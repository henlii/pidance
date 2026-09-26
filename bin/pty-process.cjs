"use strict";

/**
 * PTY 子进程的收尾规则（bin/pty-manager.cjs 与 bin/pty-worker.js 共用一份）。
 *
 * 为什么不能只 `proc.kill(signal)`：node-pty 的 Unix 实现就是只杀那一个 pid
 * （`node_modules/node-pty/lib/unixTerminal.js` 的 `kill` 里是 `process.kill(this.pid, signal)`），
 * 而 shell 在**同一进程组**里起的后代（例如 `sh -c "sleep 600 & wait"` 那种同组后台作业）会被留下。
 *
 * forkpty 会让 shell 成为会话/进程组组长，所以先补一刀 `-pid` 打整组，再按 pid 收尾
 * （组长可能已不在，两步都要容错）。
 *
 * 边界（别把组杀想得比它更大）：交互式 bash 里直接敲的 `sleep 600 &` 会被 job control 放进
 * **另一个**进程组，`kill(-shellPid)` **打不中**它 —— 逃出会话组的后代本来就要按 SID 遍历进程树才收得掉，
 * 那是平台相关的产品取舍，这里不做。
 *
 * Windows 上 `process.kill(-pid)` 会抛错（不支持杀进程组），而 node-pty 的
 * `WindowsTerminal.kill(signal)` 在真正清理（`_close()` / `_agent.kill()`）**之前**就
 * `throw new Error("Signals not supported on windows.")`（`node_modules/node-pty/lib/windowsTerminal.js`）——
 * 所以 win32 必须**不传 signal** 地调用 `kill()`，否则那条真正的 ConPTY 清理会被空 catch 当成「已经退出」吞掉。
 */
function killPtyProcess(proc, signal = "SIGTERM", platform = process.platform) {
  if (!proc || !(proc.pid > 0)) return;
  // 进程组那一刀只在支持它的平台做（Windows 传负 pid 会抛）。
  if (platform !== "win32") {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      /* 进程组可能已不在 */
    }
  }
  if (typeof proc.kill === "function") {
    try {
      // Windows：不能传 signal，否则 node-pty 在真正清理前就抛错（见文件头）。
      if (platform === "win32") proc.kill();
      else proc.kill(signal);
    } catch {
      /* 已退出 */
    }
  }
}

/**
 * 请 pty-worker 自己收尾（发一条 {type:"bye"} 帧）。
 * 为什么不能只靠 child.kill：Windows 上 Node 会忽略信号种类直接强杀 worker，
 * worker 里的信号处理跑不到 → node-pty 的真实清理也跑不到。帧发不出去就返回 false，
 * 由调用方继续走强杀兜底。
 */
function requestWorkerShutdown(child) {
  try {
    if (!child || !child.stdin || child.stdin.writable === false) return false;
    child.stdin.write(`${JSON.stringify({ type: "bye" })}\n`);
    return true;
  } catch {
    return false;
  }
}

const PARENT_WATCH_MS = 5000;
/** 连续探不到父进程几次才收尾（见 startParentWatchdog）。 */
const PARENT_WATCH_MISSES = 2;

/**
 * 父进程被硬杀（SIGKILL / 崩溃 / 被强制结束）时不会发 SIGTERM，PTY worker 会连同
 * 它下面的 shell 一起变成孤儿 —— 实测：改前（没有看护）worker 在父进程被 SIGKILL
 * 之后一直活着，改后退出。定期确认父进程还在，不在了就收尾。
 * 依赖与计时器可注入，单测用假计时器驱动。
 */
function startParentWatchdog(options = {}) {
  const parentPid = options.parentPid ?? process.ppid;
  const intervalMs = options.intervalMs ?? PARENT_WATCH_MS;
  const missThreshold = options.missThreshold ?? PARENT_WATCH_MISSES;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  // 只看「进程不存在」（ESRCH）：EPERM 是「存在但不是我们能碰的」，绝不能当死亡，
  // 否则一次权限异常就会在 5 秒后拆掉用户的终端。
  const isAlive = options.isAlive ?? ((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error && error.code === "EPERM";
    }
  });
  const onGone = options.onGone ?? (() => {});
  // 连续两次探不到才收尾：杀错（拆掉用户正在用的终端）比晚 5 秒收尾严重得多。
  let missed = 0;
  const timer = setIntervalFn(() => {
    if (isAlive(parentPid)) {
      missed = 0;
      return;
    }
    missed += 1;
    if (missed >= missThreshold) onGone();
  }, intervalMs);
  // unref：看护计时器不该把进程吊住，worker 是靠 pty 活着的。
  if (timer && typeof timer.unref === "function") timer.unref();
  return () => clearIntervalFn(timer);
}

module.exports = { killPtyProcess, startParentWatchdog, requestWorkerShutdown };
