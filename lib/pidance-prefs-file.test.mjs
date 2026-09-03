import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { readPidancePrefs, updatePidancePref } = await jiti.import("./pidance-prefs-file.ts");
const modulePath = fileURLToPath(new URL("./pidance-prefs-file.ts", import.meta.url));

const workerScript = `
(async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { updatePidancePref } = await jiti.import(process.argv[1]);
  updatePidancePref(process.argv[2], JSON.parse(process.argv[3]), process.argv[4]);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

async function runWorker(modulePath, key, value, agentDir) {
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    workerScript,
    resolve(modulePath),
    key,
    JSON.stringify(value),
    agentDir,
  ], {
    cwd: resolve("."),
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  const [result] = await once(child, "close");
  if (result !== 0) throw new Error(`prefs worker exited with ${result}: ${stderr.join("")}`);
}

test("pidance prefs：跨进程并发点路径更新不丢 sessionQueue", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pidance-prefs-lock-"));
  try {
    const workers = [];
    for (let index = 0; index < 12; index += 1) {
      const id = `session-${index}`;
      workers.push(runWorker(modulePath, `sessionQueue.${id}`, [`message-${index}`], agentDir));
      workers.push(runWorker(modulePath, `sessionQueueHold.${id}`, true, agentDir));
    }
    await Promise.all(workers);
    const prefs = readPidancePrefs(agentDir);
    for (let index = 0; index < 12; index += 1) {
      const id = `session-${index}`;
      assert.deepEqual(prefs.sessionQueue?.[id], [`message-${index}`]);
      assert.equal(prefs.sessionQueueHold?.[id], true);
    }
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("pidance prefs：单进程 update 保持点路径删除语义", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pidance-prefs-delete-"));
  try {
    updatePidancePref("sessionQueue.s1", ["next"], agentDir);
    updatePidancePref("sessionQueueHold.s1", true, agentDir);
    updatePidancePref("sessionQueueHold.s1", null, agentDir);
    assert.deepEqual(readPidancePrefs(agentDir), { sessionQueue: { s1: ["next"] }, sessionQueueHold: {} });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
