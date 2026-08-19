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
