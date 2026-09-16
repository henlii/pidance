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
const {
  readPidancePrefs,
  updatePidancePref,
  mergePidancePrefs,
  mergeAndWritePidancePrefs,
  getPidancePref,
  stripHostOwnedQueuePrefs,
} = await jiti.import("./pidance-prefs-file.ts");
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

test("pidance prefs：merge 显式 null = 删键（墓碑语义）", () => {
  const base = {
    drafts: {
      s1: { value: "已发送残留", images: [] },
      s2: { value: "真草稿", images: [] },
    },
    thinkingLevel: { "p:m": "high" },
    locale: "zh-CN",
  };
  const patch = {
    drafts: { s1: null, s2: { value: "更新后", images: [] } },
    locale: null,
  };
  const out = mergePidancePrefs(base, patch);
  // 嵌套 null 删除，其它 draft 键保留且被 patch 覆盖
  assert.equal("s1" in out.drafts, false);
  assert.deepEqual(out.drafts.s2, { value: "更新后", images: [] });
  // 顶层 null 删除
  assert.equal("locale" in out, false);
  // 未触碰的键原样保留
  assert.deepEqual(out.thinkingLevel, { "p:m": "high" });
  // 旧语义：整包 patch 不带某键 = 不删除（并集）；服务端残留是草稿复活的根因
  assert.deepEqual(mergePidancePrefs({ drafts: { s1: { value: "残留" } } }, { drafts: {} }).drafts.s1, {
    value: "残留",
  });
});

test("pidance prefs：merge null 不覆盖非对象键（顶层标量删除）", () => {
  const out = mergePidancePrefs({ flag: true, drafts: { a: 1 } }, { flag: null, drafts: { a: null, b: 2 } });
  assert.deepEqual(out, { drafts: { b: 2 } });
});

test("pidance prefs：merge 深层 null 删除后同键再补丁为对象可恢复", () => {
  const cleared = mergePidancePrefs({ drafts: { s1: { value: "残留" } } }, { drafts: { s1: null } });
  assert.deepEqual(cleared, { drafts: {} });
  const recreated = mergePidancePrefs(cleared, { drafts: { s1: { value: "新草稿" } } });
  assert.deepEqual(recreated.drafts.s1, { value: "新草稿" });
});

test("#42 客户端整包快照不得写回宿主持有的队列（R3/R12：已投递条目被恢复成 waiting → 重复投递）", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pidance-prefs-queue-"));
  try {
    // Host 投递后落盘：队列已清空、版本前进到 4。
    updatePidancePref("sessionQueue.s1", { items: [], revision: 4 }, agentDir);
    updatePidancePref("sessionQueue.s2", { items: [], revision: 4 }, agentDir);
    // 客户端内存快照停在「投递前」，随任意一次偏好写入（草稿/hold）整包回写。
    const clientSnapshot = {
      sessionQueue: { s1: { items: [{ id: "i1", text: "已投递", state: "waiting" }], revision: 2 } },
      "sessionQueue.s2": { items: [{ id: "i2", text: "已投递", state: "waiting" }], revision: 2 },
      sessionQueueHold: { s1: true },
      drafts: { s1: { value: "草稿" } },
    };
    const { patch, dropped } = stripHostOwnedQueuePrefs(clientSnapshot);
    assert.deepEqual(dropped.sort(), ["sessionQueue", "sessionQueue.s2"]);
    mergeAndWritePidancePrefs(patch, agentDir);

    const prefs = readPidancePrefs(agentDir);
    // 队列内容与版本都必须保持 Host 的权威状态：回退就是「已投递变回待发」。
    assert.deepEqual(getPidancePref(prefs, "sessionQueue.s1"), { items: [], revision: 4 });
    assert.deepEqual(getPidancePref(prefs, "sessionQueue.s2"), { items: [], revision: 4 });
    // 客户端持有的 hold 与草稿照常写入。
    assert.equal(getPidancePref(prefs, "sessionQueueHold.s1"), true);
    assert.deepEqual(getPidancePref(prefs, "drafts.s1"), { value: "草稿" });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
