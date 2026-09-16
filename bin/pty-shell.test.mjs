import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const { resolveShell, looksLikeWindowsPath } = await import("./pty-shell.cjs");

test("win32：COMSPEC 优先，缺失时退回 powershell.exe", () => {
  assert.equal(resolveShell("win32", { COMSPEC: "C:\\Windows\\System32\\cmd.exe" }), "C:\\Windows\\System32\\cmd.exe");
  assert.equal(resolveShell("win32", {}), "powershell.exe");
  assert.equal(resolveShell("win32", { COMSPEC: "   " }), "powershell.exe");
});

test("win32：Git Bash 的 POSIX SHELL 不能当真，Windows 路径的 SHELL 才用", () => {
  const env = { SHELL: "/usr/bin/bash", COMSPEC: "C:\\Windows\\System32\\cmd.exe" };
  assert.equal(resolveShell("win32", env), "C:\\Windows\\System32\\cmd.exe");
  assert.equal(resolveShell("win32", { SHELL: "/usr/bin/bash" }), "powershell.exe");
  assert.equal(resolveShell("win32", { SHELL: "C:\\custom\\shell.exe" }), "C:\\custom\\shell.exe");
  assert.equal(resolveShell("win32", { SHELL: "\\\\server\\share\\shell.exe" }), "\\\\server\\share\\shell.exe");
  assert.equal(looksLikeWindowsPath("/usr/bin/bash"), false);
  assert.equal(looksLikeWindowsPath("pwsh.exe"), false);
});

test("非 win32：显式 SHELL 优先，否则 /bin/bash", () => {
  assert.equal(resolveShell("linux", { SHELL: "/usr/bin/zsh" }), "/usr/bin/zsh");
  assert.equal(resolveShell("linux", {}), "/bin/bash");
  assert.equal(resolveShell("darwin", { SHELL: "  " }), "/bin/bash");
});

test("pty-worker 起不来 shell 时会把原因发回浏览器再退出（不再静默断开）", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(here, "pty-worker.js"), here, "80", "24"],
    { encoding: "utf8", env: { ...process.env, SHELL: "/nonexistent/pidance-shell" }, timeout: 20_000 },
  );
  const frames = (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((msg) => msg?.type === "out");
  // 失败文案可能来自 node-pty（execvp failed）也可能来自 worker 自己的兜底，两者都算把原因送达客户端。
  assert.ok(
    frames.some((msg) => /failed|无法启动终端 shell/.test(msg.d)),
    `worker 应把起不来 shell 的原因发回来，实际 stdout=${JSON.stringify(result.stdout)}`,
  );
  assert.notEqual(result.status, 0);
});
