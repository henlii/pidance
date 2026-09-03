"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const { existsSync, realpathSync } = require("fs");
const { WebSocketServer } = require("ws");
const ptyWss = new WebSocketServer({ noServer: true });

function sanitizeEnv(env) {
  const next = { ...env };
  delete next.PI_WEB_PASSWORD;
  delete next.PIDANCE_PASSWORD;
  return next;
}

function tryLoadNodePty() {
  try {
    const loaded = require("node-pty");
    if (typeof loaded.spawn !== "function") return null;
    return loaded;
  } catch {
    return null;
  }
}

function resolvePtyCwd(cwd) {
  if (!existsSync(cwd)) throw new Error("PTY cwd 不存在");
  return realpathSync(cwd);
}

function startPtySession(options) {
  const spawner = options.pty === undefined ? tryLoadNodePty() : options.pty;
  if (!spawner) throw new Error("node-pty 不可用");
  const cwd = resolvePtyCwd(options.cwd);
  const cols = options.cols && options.cols > 0 ? options.cols : 80;
  const rows = options.rows && options.rows > 0 ? options.rows : 24;
  // 平台默认 shell：Windows 没有 POSIX /bin/bash，必须走 PowerShell/cmd。
  // 优先用户显式 SHELL（Linux/macOS 常见）；win32 用 PowerShell 否则 cmd。
  let shell = process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : "";
  if (!shell) {
    if (process.platform === "win32") {
      shell = process.env.COMSPEC && process.env.COMSPEC.length > 0
        ? process.env.COMSPEC
        : "powershell.exe";
    } else {
      shell = "/bin/bash";
    }
  }
  const proc = spawner.spawn(shell, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: sanitizeEnv(options.env ?? process.env),
  });
  let disposed = false;
  const onChunk = (data) => {
    if (!disposed) {
      const text = typeof data === "string" ? data : data.toString();
      options.onData(text);
    }
  };
  if (typeof proc.on === "function") proc.on("data", onChunk);
  else if (typeof proc.onData === "function") proc.onData(onChunk);
  const onGone = (e) => {
    if (!disposed) options.onExit(typeof e === "object" && e ? e.exitCode : 0);
  };
  if (typeof proc.on === "function") proc.on("exit", onGone);
  else if (typeof proc.onExit === "function") proc.onExit(onGone);
  return {
    pid: proc.pid,
    write: (data) => {
      if (!disposed) proc.write(data);
    },
    resize: (nextCols, nextRows) => {
      if (!disposed && nextCols > 0 && nextRows > 0) proc.resize(nextCols, nextRows);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        if (proc.pid > 0) process.kill(-proc.pid, "SIGTERM");
      } catch {
        /* 进程组可能已不在 */
      }
      try {
        proc.kill("SIGTERM");
      } catch {
        /* 已退出 */
      }
    },
  };
}

function attachPtyToWebSocket(ws, cwd) {
  const { spawn } = require("child_process");
  const path = require("path");
  const workerPath = path.join(__dirname, "pty-worker.js");
  const child = spawn(process.execPath, [workerPath, cwd, "80", "24"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => console.warn("[pidance] pty-worker stderr", data));
  child.on("error", (error) => console.warn("[pidance] pty-worker spawn", error.message));
  const session = {
    pid: child.pid,
    write: (data) => child.stdin.write(`${JSON.stringify({ type: "in", d: data })}\n`),
    resize: (cols, rows) => child.stdin.write(`${JSON.stringify({ type: "rs", cols, rows })}\n`),
    dispose: () => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    },
  };
  child.stdout.setEncoding("utf8");
  // pty-worker 输出按 JSON Lines 帧化：{type:"out",d:...}，避免与终端原始输出混淆。
  let stdoutBuf = "";
  child.stdout.on("data", (data) => {
    stdoutBuf += typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg && msg.type === "out" && typeof msg.d === "string") {
          // 统一用 JSON 帧发给浏览器，避免普通输出与控制消息混淆。
          ws.send(JSON.stringify({ type: "out", d: msg.d }));
        }
      } catch { /* 非 JSON 的旧协议输出，尽量原样转发 */ try { ws.send(line); } catch { /* ignore */ } }
    }
  });
  child.on("exit", (code) => {
    try {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "exit", code: code ?? 0 }));
        ws.close();
      }
    } catch { /* ignore */ }
  });
  ws.on("message", (raw) => {
    const text = typeof raw === "string" ? raw : raw.toString();
    let parsed;
    try { parsed = JSON.parse(text); } catch { return; }
    if (parsed && parsed.type === "in" && typeof parsed.d === "string") session.write(parsed.d);
    if (parsed && parsed.type === "rs" && parsed.cols > 0 && parsed.rows > 0) session.resize(parsed.cols, parsed.rows);
  });
  ws.on("close", () => session.dispose());
  ws.on("error", () => session.dispose());
  try { ws.send(JSON.stringify({ type: "out", d: "\r\n[pidance] terminal ready\r\n" })); } catch { /* ignore */ }
  return session;
}

function completePtyUpgrade(req, socket, head, cwd) {
  ptyWss.handleUpgrade(req, socket, head, (ws) => {
    ptyWss.emit("connection", ws, req);
    attachPtyToWebSocket(ws, cwd);
  });
}

module.exports = { startPtySession, tryLoadNodePty, resolvePtyCwd, attachPtyToWebSocket, completePtyUpgrade };
