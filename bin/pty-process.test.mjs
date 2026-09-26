import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
const { killPtyProcess, startParentWatchdog, requestWorkerShutdown, disposeWorkerChild } = await import("./pty-process.cjs");

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const reap = (pid) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已经没了 */
  }
};
const waitGone = async (pid, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive(pid)) await new Promise((r) => setTimeout(r, 50));
  return !isAlive(pid);
};

test("非法 pid 时什么都不做", () => {
  assert.doesNotThrow(() => killPtyProcess(null));
  assert.doesNotThrow(() => killPtyProcess({ pid: 0 }));
  assert.doesNotThrow(() => killPtyProcess({ pid: -1 }));
  assert.doesNotThrow(() => killPtyProcess({ pid: Number.NaN }));
});

test("进程组不存在时仍会按 pid 收尾（两步都容错）", () => {
  const calls = [];
  // 用一个几乎不可能存在的 pgid：-pid 那一刀必然抛错，必须被吞掉并继续 proc.kill。
  killPtyProcess({ pid: 999999, kill: (...args) => calls.push(args) }, "SIGTERM", "linux");
  assert.deepEqual(calls, [["SIGTERM"]]);
});

test("win32 上不能给 node-pty 传 signal（否则真正的清理会被吞掉）", () => {
  const calls = [];
  killPtyProcess({ pid: 999999, kill: (...args) => calls.push(args) }, "SIGTERM", "win32");
  assert.deepEqual(calls, [[]], "win32 必须不传参调用 kill()");
});

test("requestWorkerShutdown：写得出就发 bye 帧，写不出就不抛", () => {
  const written = [];
  assert.equal(requestWorkerShutdown({ stdin: { writable: true, write: (d) => written.push(d) } }), true);
  assert.equal(written.length, 1);
  assert.equal(JSON.parse(written[0]).type, "bye");

  // 已经关了 / 没有 stdin：返回 false，绝不抛（拆连接时不能崩服务端）。
  let writeAttempts = 0;
  assert.equal(
    requestWorkerShutdown({ stdin: { writable: false, write: () => { writeAttempts += 1; throw new Error("EPIPE"); } } }),
    false,
  );
  assert.equal(writeAttempts, 0, "stdin 已关时不该尝试写（别指望 try/catch 兜）");
  assert.equal(requestWorkerShutdown({ stdin: { writable: true, write: () => { throw new Error("EPIPE"); } } }), false);
  assert.equal(requestWorkerShutdown({}), false);
  assert.equal(requestWorkerShutdown(null), false);
});

test("killPtyProcess 连带收掉进程组里的后代（模拟 forkpty 的组长语义）", { skip: process.platform === "win32" ? "win32 不支持负 pid 杀进程组" : false }, async () => {
  // detached 让子进程成为进程组/会话组长，与 forkpty 后的 shell 同形；
  // 它再起一个后代 —— 正是「只杀 shell 会把后台进程留成孤儿」那条。
  const script = [
    "const { spawn } = require('child_process');",
    "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
    "process.stdout.write(String(c.pid) + '\\n');",
    "setTimeout(() => {}, 60000);",
  ].join("");
  const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let grand = 0;
  try {
    grand = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("拿不到后代 pid")), 5000);
      child.stdout.on("data", (d) => {
        buf += d;
        const idx = buf.indexOf("\n");
        if (idx >= 0) {
          clearTimeout(timer);
          resolve(Number(buf.slice(0, idx).trim()));
        }
      });
    });
    assert.ok(grand > 0 && isAlive(grand), "后代应当先活着");
    killPtyProcess({
      pid: child.pid,
      kill: (sig) => {
        try {
          process.kill(child.pid, sig);
        } catch {
          /* 已退出 */
        }
      },
    });
    assert.equal(await waitGone(grand), true, "后代应随进程组一起被收掉");
    assert.equal(await waitGone(child.pid), true, "组长也应退出");
  } finally {
    reap(grand);
    reap(child.pid);
  }
});

test("关终端收尾：Linux 直接发信号；win32 先发 bye 并等它自己退出，超时才强杀", () => {
  const makeChild = () => {
    const state = { writes: [], kills: [], exitHandlers: [], unrefed: false };
    return {
      state,
      stdin: { writable: true, write: (d) => state.writes.push(d) },
      kill: (sig) => state.kills.push(sig),
      once: (name, fn) => state.exitHandlers.push([name, fn]),
    };
  };

  // Linux：立刻 SIGTERM（worker 的 shutdown 会跑），不等。
  const linux = makeChild();
  disposeWorkerChild(linux, { platform: "linux" });
  assert.deepEqual(linux.state.kills, ["SIGTERM"], "非 win32 应立即发信号");
  assert.deepEqual(linux.state.writes, [], "非 win32 不需要 bye 帧");

  // Windows：先写 bye，且**不能**同拍强杀（Node 会忽略信号种类直接结束 worker，
  // 那样 worker 根本读不到 bye 帧，node-pty 的真实清理也跑不到）。
  const win = makeChild();
  let timerFn = null;
  let cleared = 0;
  disposeWorkerChild(win, {
    platform: "win32",
    graceMs: 1234,
    setTimer: (fn) => { timerFn = fn; return { unref() { win.state.unrefed = true; } }; },
    clearTimer: () => { cleared += 1; },
  });
  assert.equal(win.state.writes.length, 1, "win32 应先发 bye 帧");
  assert.equal(JSON.parse(win.state.writes[0]).type, "bye");
  assert.deepEqual(win.state.kills, [], "win32 不能同拍强杀");
  assert.equal(win.state.unrefed, true, "等退出的计时器不应吊住进程");
  assert.equal(win.state.exitHandlers.length, 1, "应监听 exit 以取消计时器");
  timerFn();
  assert.deepEqual(win.state.kills, ["SIGTERM"], "超时未退才强杀");
  win.state.exitHandlers[0][1]();
  assert.equal(cleared, 1, "worker 退出后应取消计时器");

  // win32 但帧发不出去（stdin 已关）：没有可等的东西，直接强杀。
  const stuck = makeChild();
  stuck.stdin.writable = false;
  disposeWorkerChild(stuck, { platform: "win32", setTimer: () => { throw new Error("不该等"); } });
  assert.deepEqual(stuck.state.kills, ["SIGTERM"]);

  // kill 抛错也不能冒泡（拆连接时不能崩服务端）。
  assert.doesNotThrow(() => disposeWorkerChild({ stdin: { writable: false }, kill: () => { throw new Error("ESRCH"); } }, { platform: "linux" }));
});

test("父进程看护：还在就不动，没了才收尾，stop 会停表", () => {
  let tick = null;
  let cleared = 0;
  const gone = [];
  const stop = startParentWatchdog({
    parentPid: 4242,
    intervalMs: 1,
    setIntervalFn: (fn) => { tick = fn; return { unref() {} }; },
    clearIntervalFn: () => { cleared += 1; },
    isAlive: () => aliveFlag,
    onGone: () => gone.push(1),
  });
  let aliveFlag = true;
  tick();
  tick();
  assert.deepEqual(gone, [], "父进程还在时不该收尾");
  aliveFlag = false;
  tick();
  assert.deepEqual(gone, [], "只探到一次不收尾：一次抖动不该拆掉用户终端");
  tick();
  assert.equal(gone.length, 1, "连续探不到才收尾");
  stop();
  assert.equal(cleared, 1, "stop 应停表");
});

test("父进程看护：默认探针把「存在但没权限」当活着，把「不存在」当死亡", { skip: process.platform === "win32" ? "win32 没有 Unix init 的 pid 1，EPERM 场景不成立" : false }, () => {
  // 这条守的是危险方向：探针一次异常就把活着的父进程判死 → 5 秒后拆掉用户终端。
  // pid 1 一定存在，非 root 下 process.kill(1, 0) 抛 EPERM —— 旧实现（catch → false）会误判成死亡。
  const seen = [];
  const gone = [];
  const stop = startParentWatchdog({
    parentPid: 1,
    intervalMs: 1,
    setIntervalFn: (fn) => { seen.push(fn); return { unref() {} }; },
    clearIntervalFn: () => {},
    onGone: () => gone.push(1),
  });
  const tick1 = seen.pop();
  tick1();
  tick1();
  assert.deepEqual(gone, [], "存在但 EPERM 的父进程不该被当成死亡");
  stop();

  // 反过来：一个不存在的 pid 必须（连续 missThreshold 次后）收尾。
  const gone2 = [];
  const seen2 = [];
  const stop2 = startParentWatchdog({
    parentPid: 999999,
    intervalMs: 1,
    setIntervalFn: (fn) => { seen2.push(fn); return { unref() {} }; },
    clearIntervalFn: () => {},
    onGone: () => gone2.push(1),
  });
  const tick2 = seen2.pop();
  tick2();
  assert.deepEqual(gone2, [], "只探到一次不收尾（避免一次抖动就拆终端）");
  tick2();
  assert.deepEqual(gone2, [1], "连续探不到才收尾");
  stop2();
});
