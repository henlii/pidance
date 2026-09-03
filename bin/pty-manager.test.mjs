import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { startPtySession, tryLoadNodePty } = await import("./pty-manager.cjs");

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
  const cwd = mkdtempSync(join(tmpdir(), "pidance-pty-"));
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
  const cwd = mkdtempSync(join(tmpdir(), "pidance-pty-win-"));
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
