"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const pty = require("node-pty");

const cwd = process.argv[2] || process.cwd();
const cols = Number(process.argv[3]) || 80;
const rows = Number(process.argv[4]) || 24;
const shell = process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : "/bin/bash";
const env = { ...process.env };
delete env.PI_WEB_PASSWORD;
delete env.PIDANCE_PASSWORD;

const proc = pty.spawn(shell, [], {
  name: "xterm-256color",
  cols,
  rows,
  cwd,
  env,
});

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
  }
});

process.on("SIGTERM", () => {
  try { proc.kill("SIGTERM"); } catch { /* ignore */ }
  process.exit(0);
});
