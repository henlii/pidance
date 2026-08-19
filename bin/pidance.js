#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseLaunchOptions } = require("./pidance-options");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadServerConfig } = require("./pidance-server-config");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { shouldRequireAuth, resolvePassword, describeHost } = require("./pidance-auth-gate");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { startPidanceHttpServer } = require("./pidance-http-server");

const pkgDir = path.join(__dirname, "..");
const distDirName = process.env.PIDANCE_DIST_DIR || ".next";
const nextDir = path.join(pkgDir, distDirName);

// Node engine 门禁（与 package.json engines.node 对齐）：低于最低版本直接失败，
// 避免进入半运行状态。npm engines 默认只警告，这里 fail-closed。
const MIN_NODE = { major: 22, minor: 19, patch: 0 };
function nodeMeetsMin(version) {
  const m = String(version).replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
  const [maj = 0, min = 0, pat = 0] = m;
  if (maj !== MIN_NODE.major) return maj > MIN_NODE.major;
  if (min !== MIN_NODE.minor) return min > MIN_NODE.minor;
  return pat >= MIN_NODE.patch;
}
if (!nodeMeetsMin(process.versions.node)) {
  console.error(
    `[pidance] 拒绝启动：需要 Node.js >= ${MIN_NODE.major}.${MIN_NODE.minor}.${MIN_NODE.patch}，当前为 ${process.versions.node}。`,
  );
  process.exit(1);
}

const { port: explicitPort, hostname: explicitHostname, openBrowser } = parseLaunchOptions();
const serverConfig = loadServerConfig();
// 默认绑定：设置 → 通用 开启远程服务 → 0.0.0.0；否则仅本机 127.0.0.1（免密码）。
// 显式 --hostname / -H / HOSTNAME env 优先；显式 0.0.0.0 仍走密码门禁。
const hostname = explicitHostname ?? (serverConfig.remoteEnabled ? "0.0.0.0" : "127.0.0.1");
// 端口优先级：显式 -p / PORT env → 配置文件 port → 产品默认 31415。
const port = explicitPort ?? (serverConfig.port ? String(serverConfig.port) : "31415");
const listenPort = Number.parseInt(String(port), 10);
if (!Number.isInteger(listenPort) || listenPort <= 0) {
  console.error(`[pidance] 拒绝启动：无效端口 ${port}`);
  process.exit(1);
}

// 启动认证门禁（fail-closed，P0）：非回环监听地址（0.0.0.0 / :: / 局域网 IP / 非回环主机名）
// 且未设置认证密码时拒绝启动，防止局域网/公网匿名调用 Agent API（创建会话/发 prompt/调工具）。
// 默认仅绑定 127.0.0.1（本机），无需密码；远程服务在设置 → 通用 中开启（须先设置密码）。
if (shouldRequireAuth(hostname, resolvePassword(process.env), serverConfig)) {
  console.error(
    "[pidance] 拒绝启动：监听地址 " +
      describeHost(hostname) +
      " 非本机回环地址，且未设置认证密码。",
  );
  console.error(
    "非本机访问必须设置密码后再启动，例如：PIDANCE_PASSWORD=<密码> pidance --hostname 0.0.0.0" +
      "（兼容旧变量 PI_WEB_PASSWORD）。",
  );
  console.error(
    "也可以在设置 → 通用 中设置密码并开启远程服务（重启后监听 0.0.0.0）。",
  );
  console.error(
    "仅本机访问默认绑定 127.0.0.1，直接运行 pidance 即可（或 --hostname 127.0.0.1 / localhost）。",
  );
  process.exit(1);
}

if (!fs.existsSync(nextDir)) {
  console.error("Build artifacts not found. Please report this issue.");
  process.exit(1);
}

const url = `http://${hostname}:${listenPort}`;
// 浏览器打开用回环地址（0.0.0.0 在多数浏览器不可直达）
const browserHost = hostname === "0.0.0.0" || hostname === "::" ? "localhost" : hostname;
const browserUrl = `http://${browserHost}:${listenPort}`;

function openBrowserOnce() {
  const isWindows = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const openCmd = isWindows ? "start" : isMac ? "open" : "xdg-open";
  const opener = spawn(openCmd, [browserUrl], {
    shell: isWindows,
    stdio: "ignore",
    detached: true,
  });
  opener.on("error", (error) => {
    console.warn(`Could not open browser automatically: ${error.message}`);
  });
  opener.unref();
}

void startPidanceHttpServer({
  dir: pkgDir,
  hostname,
  port: listenPort,
}).then(({ server }) => {
  console.log(`Ready on ${url}`);
  if (openBrowser) openBrowserOnce();

  // 同一进程持有 HTTP：SIGTERM 关 listener，不再 spawn next-server。
  const STOP_GRACE_MS = 8_000;
  let stopping = false;
  function requestStop() {
    if (stopping) return;
    stopping = true;
    server.close(() => process.exit(0));
    const force = setTimeout(() => process.exit(1), STOP_GRACE_MS);
    if (typeof force.unref === "function") force.unref();
  }
  process.on("SIGTERM", requestStop);
  process.on("SIGINT", requestStop);
}).catch((error) => {
  console.error(`[pidance] 启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
