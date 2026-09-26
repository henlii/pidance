"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const pty = require("node-pty");
const { resolveShell } = require("./pty-shell.cjs");
const { killPtyProcess, startParentWatchdog } = require("./pty-process.cjs");

const cwd = process.argv[2] || process.cwd();
const cols = Number(process.argv[3]) || 80;
const rows = Number(process.argv[4]) || 24;
const shell = resolveShell(process.platform, process.env);
const env = { ...process.env };
delete env.PI_WEB_PASSWORD;
delete env.PIDANCE_PASSWORD;

let proc;
try {
  proc = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env,
  });
} catch (error) {
  // 起不来就把原因发给浏览器再退出：父进程只看得到退出码，终端会静默消失。
  const reason = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({ type: "out", d: `\r\n[pidance] 无法启动终端 shell（${shell}）：${reason}\r\n` }) + "\n");
  process.exit(1);
}

proc.onData((data) => {
  process.stdout.write(JSON.stringify({ type: "out", d: data }) + "\n");
});
proc.onExit((e) => {
  process.exit(e.exitCode ?? 0);
});

process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === "in" && typeof msg.d === "string") proc.write(msg.d);
    if (msg.type === "rs" && msg.cols > 0 && msg.rows > 0) proc.resize(msg.cols, msg.rows);
    // 父进程请求收尾：Windows 上 child.kill 会忽略信号种类直接强杀 worker，
    // worker 侧的信号处理跑不到，所以正常关闭走这条显式请求。
    if (msg.type === "bye") shutdown();
  }
});

// 收尾：Linux 走父进程的 SIGTERM / SIGINT，Windows 走父进程发来的 bye 帧
// （那边 child.kill 会忽略信号种类直接强杀，信号处理跑不到）；异常路径由下面的父进程看护兜底。
let exiting = false;
const shutdown = () => {
  if (exiting) return;
  exiting = true;
  killPtyProcess(proc);
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
// 父进程真的没了才收尾：stdin EOF 不等于父进程退出（写端关闭就会 EOF，
// 而父进程可能还在），所以这里看的是父进程本身还在不在。
startParentWatchdog({ onGone: shutdown });
