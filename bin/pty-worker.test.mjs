import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { tryLoadNodePty } = await import("./pty-manager.cjs");

const workerPath = join(dirname(fileURLToPath(import.meta.url)), "pty-worker.js");
// node-pty 缺失时（发布环境的可选依赖）整个文件跳过：起不来 worker 就没有可测的收尾。
const hasPty = tryLoadNodePty() !== null;

function startWorker() {
  return spawn(process.execPath, [workerPath, process.cwd(), "80", "24"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function waitExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

test("worker 收到父进程的 bye 帧会退出（Windows 上信号不可达，正常关闭走这条）", { skip: !hasPty }, async () => {
  const child = startWorker();
  try {
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(child.exitCode, null, "worker 起来后应仍在运行");
    child.stdin.write(`${JSON.stringify({ type: "bye" })}\n`);
    assert.equal(await waitExit(child, 4000), true, "bye 帧后 worker 应退出");
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
});

test("worker 收到 SIGTERM 会退出", { skip: !hasPty }, async () => {
  const child = startWorker();
  try {
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(child.exitCode, null, "worker 起来后应仍在运行");
    child.kill("SIGTERM");
    assert.equal(await waitExit(child, 4000), true, "SIGTERM 后 worker 应退出");
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
});
