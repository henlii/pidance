"use strict";

/**
 * 桌面壳的服务生命周期纯逻辑（不依赖 electron，node:test 可直接测）。
 *
 * 职责：把「复用已有服务 / 拉起本进程服务 / 关闭时只停自己拉起的服务」这三件事
 * 的判断从 Electron 主进程里拆出来，避免"端口有人应答就当 Pidance"这类误判。
 */

const PIDANCE_BRAND = "Pidance";
/** 服务身份指纹：页面 <title> 精确匹配，而不是「响应里出现过 Pidance」。 */
const PIDANCE_TITLE_PATTERN = /<title>\s*Pidance\s*<\/title>/i;

/** 服务就绪探测地址：回环根路径（页面未认证也放行，由页内登录处理）。 */
function buildReadyUrl(host, port) {
  return `http://${host}:${port}/`;
}

/**
 * 响应体是否是 Pidance 服务。
 * 端口被别的程序占用时也会应答，必须校验结构化指纹：页面 <title>Pidance</title>。
 * 「包含 Pidance 字样」不算（"Not Pidance" 也会命中）。
 */
function looksLikePidance(body) {
  return typeof body === "string" && PIDANCE_TITLE_PATTERN.test(body);
}

/**
 * 探测回环端口上的服务。
 * @returns {"pidance"|"other"|"none"} pidance=可复用；other=被非 Pidance 占用；none=没人监听
 */
async function probeService({ url, timeoutMs = 1_500, request }) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const verdict = await request(url);
    if (verdict === "pidance" || verdict === "other") return verdict;
    if (Date.now() >= deadline) return "none";
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** 服务端目录：打包版固定用随应用打包的包；开发版允许 PIDANCE_SERVER_DIR 覆盖。 */
function resolveServerDir({ isPackaged, resourcesPath, serverDirEnv, srcDir }) {
  if (!isPackaged && serverDirEnv) return serverDirEnv;
  if (isPackaged) return `${resourcesPath}/app/node_modules/@henlii/pidance`;
  return `${srcDir}/../..`;
}

/**
 * 服务用哪个 Node 运行。
 *
 * 优先用 Electron 自带的 Node（`ELECTRON_RUN_AS_NODE=1`）：Electron 37.10+ 自带
 * Node 22.21.1，满足主包 engines >=22.19，能省掉 ~92MB 的 node.exe。
 * extraResources 里若仍放了 node/node.exe（历史构建/兜底），则优先用它。
 * 原生模块（node-pty / sharp）是 NAPI 构建，两种运行时都能加载。
 */
function resolveNodeBinary({ isPackaged, resourcesPath, execPath, existsSync }) {
  if (isPackaged) {
    const bundled = `${resourcesPath}/node/node.exe`;
    if (existsSync(bundled)) return { bin: bundled, env: {} };
    return { bin: execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
  }
  // 开发模式：Electron 自身即以 Node 方式运行服务。
  return { bin: execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** 版本号比较（a >= b）。 */
function compareVersions(a, b) {
  const pa = String(a).split(".").map((v) => Number.parseInt(v, 10) || 0);
  const pb = String(b).split(".").map((v) => Number.parseInt(v, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 服务运行时 Node 是否满足主包 engines 要求。 */
function meetsNodeEngine(nodeVersion, minimum) {
  if (typeof nodeVersion !== "string" || !nodeVersion) return false;
  return compareVersions(nodeVersion, minimum) >= 0;
}

/**
 * 服务进程参数：显式端口 + 显式回环监听 + 不自动开浏览器。
 * 桌面壳按 #25 的范围只服务本机（不跟随 pidance-server.json 的远程访问开关）；
 * 需要远程访问请使用安装版服务。
 */
function buildServerArgs(serverBin, port, host) {
  return [serverBin, "--port", String(port), "--hostname", String(host), "--no-open"];
}

/** 窗口内只允许受信任 origin；用 URL 解析，避免 "http://127.0.0.1:31415@evil.example" 绕过。 */
function isTrustedOrigin(target, trustedOrigin) {
  if (typeof target !== "string" || target.length === 0) return false;
  try {
    return new URL(target).origin === trustedOrigin;
  } catch {
    return false;
  }
}

/**
 * IPC 调用方判定：必须是受信任主窗口的**顶层 frame**，且 URL 属于本机 origin。
 * 子 frame、其他 webContents、被导航到站外的窗口一律拒绝。
 */
function isTrustedIpcSender({ frameParent, frameUrl, senderIsMainWindow, trustedOrigin }) {
  if (frameParent !== null) return false;
  if (senderIsMainWindow !== true) return false;
  return isTrustedOrigin(frameUrl, trustedOrigin);
}

/** 交给系统浏览器打开只允许 http/https，拒绝 file:/javascript: 及任意系统协议。 */
function externalUrlFor(target) {
  if (typeof target !== "string" || target.length === 0) return null;
  try {
    const url = new URL(target);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * 启动决策：先看端口上是不是可复用的 Pidance，再决定复用 / 报错 / 拉起服务。
 * 返回状态而不是直接弹框，便于测试与在主进程里映射文案。
 * @returns {"reused"|"foreign-port"|"port-busy"|"started"|"start-failed"|"not-ready"}
 */
async function coordinateStartup({ probe, isPortBusy, startServer, waitReady }) {
  const verdict = await probe();
  if (verdict === "pidance") return "reused";
  if (verdict === "other") return "foreign-port";
  if (await isPortBusy()) return "port-busy";
  if (!(await startServer())) return "start-failed";
  const started = await waitReady();
  if (started === "pidance") return "started";
  return started === "other" ? "foreign-port" : "not-ready";
}

/**
 * 停掉本进程拉起的服务。
 * - child 为 null（复用了外部服务）→ 什么都不做，绝不误杀别人的进程。
 * - win32：pidance 会派生子进程（PTY worker 等），必须整棵树一起收。
 */
function stopServerProcess({ child, platform = process.platform, spawnSync }) {
  if (!child || child.killed) return false;
  if (platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return true;
  }
  child.kill();
  return true;
}

/** 端口是否已被占用（用于把"被别的程序占了"与"服务没起来"分开报错）。 */
function isPortOpen({ host, port, connect, timeoutMs = 1_000 }) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (value) => {
      socket.removeAllListeners?.();
      socket.destroy?.();
      resolve(value);
    };
    socket.setTimeout?.(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** 打包输入校验：入口与 Node 运行时缺一不可；缺内置 Node 时自带的 Node 必须够新。 */
function checkServerInputs({ serverBin, nodeBin, existsSync, nodeVersion, requiredNodeVersion }) {
  if (!nodeBin) return "安装包缺少内置 Node 运行时";
  if (requiredNodeVersion && !meetsNodeEngine(nodeVersion, requiredNodeVersion)) {
    return `当前运行时 Node ${nodeVersion ?? "未知"} 低于主包要求（>=${requiredNodeVersion}）`;
  }
  if (!existsSync(serverBin)) return `未找到 pidance 服务入口：\n${serverBin}`;
  return null;
}

module.exports = {
  PIDANCE_BRAND,
  buildReadyUrl,
  isTrustedOrigin,
  isTrustedIpcSender,
  externalUrlFor,
  coordinateStartup,
  looksLikePidance,
  probeService,
  resolveServerDir,
  resolveNodeBinary,
  meetsNodeEngine,
  buildServerArgs,
  stopServerProcess,
  checkServerInputs,
  isPortOpen,
};
