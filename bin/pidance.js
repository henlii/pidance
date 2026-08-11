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
const { shouldRequireAuth, resolvePassword, describeHost } = require("./pidance-auth-gate");

const pkgDir = path.join(__dirname, "..");
const nextDir = path.join(pkgDir, ".next");

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

// Resolve next's CLI entry directly to avoid relying on .bin symlinks (which
// may not exist when installed via npx).
let nextBin;
try {
  nextBin = require.resolve("next/dist/bin/next", { paths: [pkgDir] });
} catch {
  // Fallback: locate next package root and derive the bin path manually.
  try {
    const nextPkg = require.resolve("next/package.json", { paths: [pkgDir] });
    nextBin = path.join(path.dirname(nextPkg), "dist", "bin", "next");
  } catch {
    nextBin = path.join(pkgDir, "node_modules", "next", "dist", "bin", "next");
  }
}

const { port, hostname, openBrowser } = parseLaunchOptions();

// 启动认证门禁（fail-closed，P0）：非回环监听地址（0.0.0.0 / :: / 局域网 IP / 非回环主机名）
// 且未设置认证密码时拒绝启动，防止局域网/公网匿名调用 Agent API（创建会话/发 prompt/调工具）。
// 仅本机使用：--hostname 127.0.0.1（或 localhost）可省略密码。
if (shouldRequireAuth(hostname, resolvePassword(process.env))) {
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
    "仅本机访问可省略密码并使用回环地址：pidance --hostname 127.0.0.1（或 localhost）。",
  );
  process.exit(1);
}

if (!fs.existsSync(nextDir)) {
  console.error("Build artifacts not found. Please report this issue.");
  process.exit(1);
}

const nextArgs = ["start", "-p", port];
if (hostname) nextArgs.push("-H", hostname);

// Always run next's JS entry with node directly — avoids .bin symlink issues
// and path-with-spaces problems on Windows when shell: true is used.
const child = spawn(process.execPath, [nextBin, ...nextArgs], {
  cwd: pkgDir,
  stdio: ["inherit", "pipe", "inherit"],
  env: { ...process.env },
});

let browserOpened = false;
const url = `http://${hostname ?? "localhost"}:${port}`;

child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  if (openBrowser && !browserOpened && text.includes("Ready")) {
    browserOpened = true;
    const isWindows = process.platform === "win32";
    const isMac = process.platform === "darwin";
    const openCmd = isWindows ? "start" : isMac ? "open" : "xdg-open";
    const opener = spawn(openCmd, [url], {
      shell: isWindows,
      stdio: "ignore",
      detached: true,
    });

    opener.on("error", (error) => {
      console.warn(`Could not open browser automatically: ${error.message}`);
    });

    opener.unref();
  }
});

child.on("exit", (code) => process.exit(code ?? 0));
