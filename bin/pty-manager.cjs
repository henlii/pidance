"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const { existsSync, realpathSync } = require("fs");
const { WebSocketServer } = require("ws");
const { resolveShell } = require("./pty-shell.cjs");
const { killPtyProcess, disposeWorkerChild } = require("./pty-process.cjs");
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
  // 平台默认 shell：跟真正开终端的 pty-worker.js 用同一套规则（bin/pty-shell.cjs）。
  const shell = resolveShell(process.platform, process.env);
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
      killPtyProcess(proc);
    },
  };
}

const PTY_HEARTBEAT_MS = 30_000;
const PTY_HEARTBEAT_MAX_MISSED = 2;
// 取舍：看的是 WebSocket 协议级 ping/pong（浏览器自动回 pong），**不是**终端有没有输出，
// 所以前台跑 `sleep 600` 之类不会因为「没输出」被判死。代价是：手机锁屏后网络栈不再回 pong，
// 连续 3 拍（约 90 秒）没有任何 pong 就会 terminate → 面板重连时是**新** shell。
// 要更宽松就调大这两个常量；不要改成按终端输出判活（那会杀掉长任务）。

/**
 * 判断这条连接是真死还是只是安静：手机掉网、进程被冻住时 TCP 不会发 FIN，
 * 服务端会一直攥着 ws 和它背后的 shell（孤儿进程，还占着端口/内存）。
 * 按 ping/pong 收尾，连续几轮没有 pong 就 terminate（触发 close → dispose）。
 * 计时器与 readyState 判定可注入，单测用假计时器驱动。
 */
function startPtyHeartbeat(ws, options = {}) {
  const intervalMs = options.intervalMs ?? PTY_HEARTBEAT_MS;
  const maxMissed = options.maxMissed ?? PTY_HEARTBEAT_MAX_MISSED;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const isOpen = options.isOpen ?? (() => ws.readyState === 1);
  let missedPongs = 0;
  const onPong = () => {
    missedPongs = 0;
  };
  ws.on("pong", onPong);
  const timer = setIntervalFn(() => {
    if (!isOpen()) return;
    if (missedPongs >= maxMissed) {
      try {
        ws.terminate();
      } catch {
        /* 已断开 */
      }
      return;
    }
    missedPongs += 1;
    try {
      ws.ping();
    } catch {
      /* 已断开 */
    }
  }, intervalMs);
  // unref：别让心跳计时器把进程吊在退出前。
  if (timer && typeof timer.unref === "function") timer.unref();
  return () => {
    clearIntervalFn(timer);
    if (typeof ws.off === "function") ws.off("pong", onPong);
  };
}

function attachPtyToWebSocket(ws, cwd) {
  const { spawn } = require("child_process");
  const path = require("path");
  const workerPath = path.join(__dirname, "pty-worker.js");
  let disposed = false;
  const child = spawn(process.execPath, [workerPath, cwd, "80", "24"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  // stdin 在子进程已退出后写入会异步抛 EPIPE：这里吞掉，避免拆连接时崩服务端。
  child.stdin.on("error", () => {});
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => console.warn("[pidance] pty-worker stderr", data));
  child.on("error", (error) => console.warn("[pidance] pty-worker spawn", error.message));
  const session = {
    pid: child.pid,
    write: (data) => child.stdin.write(`${JSON.stringify({ type: "in", d: data })}\n`),
    resize: (cols, rows) => child.stdin.write(`${JSON.stringify({ type: "rs", cols, rows })}\n`),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // 先请 worker 自己收尾，再按平台决定强杀时机（Windows 上不能同拍强杀，见 disposeWorkerChild）。
      disposeWorkerChild(child);
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
  // 心跳与 dispose 一起收：连接没了就别再 ping（也避免计时器残留）。
  const stopHeartbeat = startPtyHeartbeat(ws);
  const disposeSession = () => {
    stopHeartbeat();
    session.dispose();
  };
  ws.on("close", disposeSession);
  ws.on("error", disposeSession);
  try { ws.send(JSON.stringify({ type: "out", d: "\r\n[pidance] terminal ready\r\n" })); } catch { /* ignore */ }
  return session;
}

function completePtyUpgrade(req, socket, head, cwd) {
  ptyWss.handleUpgrade(req, socket, head, (ws) => {
    ptyWss.emit("connection", ws, req);
    attachPtyToWebSocket(ws, cwd);
  });
}

module.exports = { startPtySession, tryLoadNodePty, resolvePtyCwd, attachPtyToWebSocket, completePtyUpgrade, startPtyHeartbeat };
