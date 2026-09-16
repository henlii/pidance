"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * 终端要跑的 shell。
 *
 * 抽成独立模块是因为两处必须用同一套规则：pty-manager 的可用性探测（startPtySession）
 * 和真正开终端的子进程（pty-worker.js）。早先 pty-worker 里写死了 "/bin/bash"，
 * Windows 上没有这个路径，`pty.spawn` 直接抛错、worker 立刻退出，浏览器侧就是
 * 「终端刚连上就被关掉」（桌面壳与 CLI 都受影响）；探测那个还看不到问题。
 *
 * SHELL 只在「看起来是 Windows 路径」时才当真：Git Bash / MSYS 会把 SHELL 设成
 * `/usr/bin/bash` 这类 POSIX 路径，Windows 根本 spawn 不了，这时改用 COMSPEC。
 */
function looksLikeWindowsPath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function resolveShell(platform, env) {
  const explicit = typeof env?.SHELL === "string" ? env.SHELL.trim() : "";
  if (platform !== "win32") return explicit || "/bin/bash";
  if (explicit && looksLikeWindowsPath(explicit)) return explicit;
  const comspec = typeof env?.COMSPEC === "string" ? env.COMSPEC.trim() : "";
  return comspec || "powershell.exe";
}

module.exports = { resolveShell, looksLikeWindowsPath };
