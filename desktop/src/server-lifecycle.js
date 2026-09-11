"use strict";

/**
 * 桌面壳的服务生命周期纯逻辑（不依赖 electron，node:test 可直接测）。
 *
 * 职责：把「复用已有服务 / 拉起本进程服务 / 关闭时只停自己拉起的服务」这三件事
 * 的判断从 Electron 主进程里拆出来，避免"端口有人应答就当 Pidance"这类误判。
 */

const PIDANCE_BRAND = "Pidance";

/** 服务就绪探测地址：回环根路径（页面未认证也放行，由页内登录处理）。 */
function buildReadyUrl(host, port) {
  return `http://${host}:${port}/`;
}

/**
 * 响应体是否是 Pidance 服务。
 * 端口被别的程序占用时也会应答，必须校验品牌标识，不能只看"端口开着"。
 */
function looksLikePidance(body) {
  return typeof body === "string" && body.includes(PIDANCE_BRAND);
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

/** 服务进程参数：显式端口 + 不自动开浏览器；监听地址交给 pidance-server.json。 */
function buildServerArgs(serverBin, port) {
  return [serverBin, "--port", String(port), "--no-open"];
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
  looksLikePidance,
  probeService,
  resolveServerDir,
  resolveNodeBinary,
  buildServerArgs,
  stopServerProcess,
  checkServerInputs,
  isPortOpen,
};
