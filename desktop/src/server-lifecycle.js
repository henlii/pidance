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

/** 打包版使用 extraResources 内置 Node（Electron 自带 Node 版本可能低于 engines）。 */
function resolveNodeBinary({ isPackaged, resourcesPath, execPath, existsSync }) {
  if (!isPackaged) return execPath;
  const bundled = `${resourcesPath}/node/node.exe`;
  return existsSync(bundled) ? bundled : null;
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

/** 打包输入校验：入口与 Node 运行时缺一不可，缺失时返回人话错误。 */
function checkServerInputs({ serverBin, nodeBin, existsSync }) {
  if (!nodeBin) return "安装包缺少内置 Node 运行时";
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
  buildServerArgs,
  stopServerProcess,
  checkServerInputs,
  isPortOpen,
};
