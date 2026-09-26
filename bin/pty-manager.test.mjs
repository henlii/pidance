import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { startPtySession, startPtyHeartbeat, tryLoadNodePty } = await import("./pty-manager.cjs");

// 临时目录随进程回收：本文件每个用例建一个，漏了会按跑测试的次数累积在 /tmp。
const tempDirs = [];
process.on("exit", () => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
    }
  }
});
function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test("node-pty 不可用时 startPtySession 抛错", () => {
  assert.throws(
    () => startPtySession({
      cwd: tmpdir(),
      pty: null,
      onData: () => {},
      onExit: () => {},
    }),
    /不可用/,
  );
});

test("mock pty 写入/缩放/dispose 会杀进程组语义", () => {
  const calls = [];
  const fake = {
    spawn() {
      return {
        pid: 999991,
        write: (d) => calls.push(["write", d]),
        resize: (c, r) => calls.push(["resize", c, r]),
        kill: (sig) => calls.push(["kill", sig]),
        onData: () => {},
        onExit: () => {},
      };
    },
  };
  const cwd = makeTempDir("pidance-pty-");
  const session = startPtySession({
    cwd,
    cols: 40,
    rows: 12,
    pty: fake,
    env: { PATH: "/bin", PI_WEB_PASSWORD: "secret", PIDANCE_PASSWORD: "secret2", HOME: "/tmp" },
    onData: () => {},
    onExit: () => {},
  });
  assert.equal(session.pid, 999991);
  session.write("ls\n");
  session.resize(80, 24);
  session.dispose();
  session.dispose();
  assert.deepEqual(calls.filter((c) => c[0] !== "kill").concat(calls.filter((c) => c[0] === "kill").slice(0, 1)), [
    ["write", "ls\n"],
    ["resize", 80, 24],
    ["kill", "SIGTERM"],
  ]);
});

test("tryLoadNodePty 在本机返回 spawn 或 null", () => {
  const loaded = tryLoadNodePty();
  if (loaded) assert.equal(typeof loaded.spawn, "function");
});

test("win32 无 SHELL 时使用 PowerShell/cmd（Windows 终端可交互）", async () => {
  const { startPtySession: sp } = await import("./pty-manager.cjs");
  const calls = [];
  const fake = {
    spawn(shell, _args, _opts) {
      calls.push(shell);
      return { pid: 1, write() {}, resize() {}, kill() {}, onData() {}, onExit() {} };
    },
  };
  const cwd = makeTempDir("pidance-pty-win-");
  // 模拟 Windows：无 SHELL，有 COMSPEC
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const realShell = process.env.SHELL;
  const realComspec = process.env.COMSPEC;
  delete process.env.SHELL;
  process.env.COMSPEC = "C:\\Windows\\System32\\cmd.exe";
  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    sp({ cwd, pty: fake, onData() {}, onExit() {} });
    assert.equal(calls.at(-1), "C:\\Windows\\System32\\cmd.exe");
    delete process.env.COMSPEC;
    sp({ cwd, pty: fake, onData() {}, onExit() {} });
    assert.equal(calls.at(-1), "powershell.exe");
    // 用户显式 SHELL 优先
    process.env.SHELL = "C:\\custom\\shell.exe";
    sp({ cwd, pty: fake, onData() {}, onExit() {} });
    assert.equal(calls.at(-1), "C:\\custom\\shell.exe");
  } finally {
    if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
    else delete process.platform;
    if (realShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = realShell;
    if (realComspec === undefined) delete process.env.COMSPEC;
    else process.env.COMSPEC = realComspec;
  }
});

test("心跳：连续数轮没有 pong 就 terminate，收到 pong 会复位", () => {
  const events = [];
  let tick = null;
  const ws = {
    readyState: 1,
    on: (name, fn) => events.push(["on", name, fn]),
    off: (name) => events.push(["off", name]),
    ping: () => events.push(["ping"]),
    terminate: () => events.push(["terminate"]),
  };
  const stop = startPtyHeartbeat(ws, {
    intervalMs: 1,
    maxMissed: 2,
    setIntervalFn: (fn) => {
      tick = fn;
      return { unref() {} };
    },
    clearIntervalFn: () => events.push(["clear"]),
  });
  const pongs = events.filter((e) => e[1] === "pong").map((e) => e[2]);
  assert.equal(pongs.length, 1, "应订阅一次 pong");
  tick();
  tick();
  assert.equal(events.filter((e) => e[0] === "ping").length, 2, "两轮都应发 ping");
  assert.equal(events.some((e) => e[0] === "terminate"), false, "两轮还没到上限，不 terminate");
  pongs[0]();
  tick();
  tick();
  assert.equal(events.some((e) => e[0] === "terminate"), false, "pong 复位后不应 terminate");
  tick();
  assert.equal(events.filter((e) => e[0] === "terminate").length, 1, "连续 maxMissed+1 轮无 pong 才 terminate");
  stop();
  assert.equal(events.some((e) => e[0] === "clear"), true, "stop 应清掉计时器");
  assert.equal(events.some((e) => e[0] === "off" && e[1] === "pong"), true, "stop 应退订 pong");
});

test("心跳：连接已关闭时不再 ping", () => {
  const pings = [];
  let tick = null;
  const ws = {
    readyState: 3,
    on: () => {},
    off: () => {},
    ping: () => pings.push(1),
    terminate: () => pings.push("terminate"),
  };
  const stop = startPtyHeartbeat(ws, {
    intervalMs: 1,
    setIntervalFn: (fn) => { tick = fn; return { unref() {} }; },
    clearIntervalFn: () => {},
  });
  tick();
  assert.deepEqual(pings, [], "关闭的连接既不该 ping 也不该 terminate");
  stop();
});