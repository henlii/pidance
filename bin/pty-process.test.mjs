import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
const { killPtyProcess, startParentWatchdog } = await import("./pty-process.cjs");

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
  killPtyProcess({ pid: 999999, kill: (sig) => calls.push(sig) }, "SIGTERM");
  assert.deepEqual(calls, ["SIGTERM"]);
});

test("killPtyProcess 连带收掉进程组里的后代（模拟 forkpty 的组长语义）", async () => {
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
  assert.equal(gone.length, 1, "父进程没了应收尾");
  stop();
  assert.equal(cleared, 1, "stop 应停表");
});

test("父进程看护：默认实现拿 pid 1（init）当存活探针", () => {
  // 只验证默认探针本身不抛：真实语义（父进程被 SIGKILL → 探针失败）由
  // 报告里的改前/改后实测对照覆盖，这里守住「默认实现可用」。
  const seen = [];
  const stop = startParentWatchdog({
    parentPid: process.pid,
    intervalMs: 1,
    setIntervalFn: (fn) => { seen.push(fn); return { unref() {} }; },
    clearIntervalFn: () => {},
  });
  assert.equal(seen.length, 1);
  assert.doesNotThrow(() => seen[0]());
  stop();
});
