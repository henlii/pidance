"use strict";

/**
 * PTY 子进程的收尾规则（bin/pty-manager.cjs 与 bin/pty-worker.js 共用一份）。
 *
 * 为什么不能只 `proc.kill(signal)`：node-pty 的 Unix 实现就是只杀那一个 pid
 * （`node_modules/node-pty/lib/unixTerminal.js` 的 `kill` 里是 `process.kill(this.pid, signal)`），
 * 而用户在终端里起的后台命令是 shell 的**子进程** —— 只杀 shell 会把它们留成孤儿。
 * 实测（WebSocket 断开、worker 已退出）：终端里 `sleep 600 &` 起来的进程仍在跑。
 *
 * forkpty 会让 shell 成为会话/进程组组长，所以先补一刀 `-pid` 打整组，再按 pid 收尾
 * （组长可能已不在，两步都要容错）。
 */
function killPtyProcess(proc, signal = "SIGTERM") {
  if (!proc || !(proc.pid > 0)) return;
  try {
    process.kill(-proc.pid, signal);
  } catch {
    /* 进程组可能已不在 */
  }
  if (typeof proc.kill === "function") {
    try {
      proc.kill(signal);
    } catch {
      /* 已退出 */
    }
  }
}

const PARENT_WATCH_MS = 5000;

/**
 * 父进程被硬杀（SIGKILL / 崩溃 / 被强制结束）时不会发 SIGTERM，PTY worker 会连同
 * 它下面的 shell 一起变成孤儿 —— 实测：改前（没有看护）worker 在父进程被 SIGKILL
 * 之后一直活着，改后退出。定期确认父进程还在，不在了就收尾。
 * 依赖与计时器可注入，单测用假计时器驱动。
 */
function startParentWatchdog(options = {}) {
  const parentPid = options.parentPid ?? process.ppid;
  const intervalMs = options.intervalMs ?? PARENT_WATCH_MS;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const isAlive = options.isAlive ?? ((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  const onGone = options.onGone ?? (() => {});
  const timer = setIntervalFn(() => {
    if (!isAlive(parentPid)) onGone();
  }, intervalMs);
  // unref：看护计时器不该把进程吊住，worker 是靠 pty 活着的。
  if (timer && typeof timer.unref === "function") timer.unref();
  return () => clearIntervalFn(timer);
}

module.exports = { killPtyProcess, startParentWatchdog };
