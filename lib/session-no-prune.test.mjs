/**
 * P5 无剪枝行为证据：分支/树导航只改变 leaf/context，原始 jsonl entry 全部保留。
 *
 * 验证层次说明（按所用层次如实报告）：
 * 1. 动态（自有 SessionFile，同 rpc-manager.test.mjs 的 A6 fixture 等价树语义）：
 *    branch()/leaf 切换前后 getEntries() 与原始 jsonl 内容只增不减，仅 leaf/context 投影变化。
 * 2. 静态（源码文本）：恢复旁支走 select_leaf_exact / navigate_tree 的契约存在，
 *    文件层原语是 sessionManager.branch()（无物理删除入口）。
 *
 * 注：不依赖 @earendil-works/pi-coding-agent；SessionFile 与 Pi 打开语义一致
 *（open 后 leaf = 文件最后一条，branch 只改 leaf 不删 entry）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SessionFile } = await jiti.import("./session-file.ts");

/** 追加一条 user 消息。 */
function appendUser(sm, content) {
  return sm.appendMessage({ role: "user", content, timestamp: Date.now() });
}

/** 追加一条 assistant 消息（简化形状即可；SessionFile 不校验 usage）。 */
function appendAssistant(sm, text) {
  return sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  });
}

/** 从 jsonl 文件提取全部 message entry 的 id（保持文件顺序；损坏行跳过）。 */
function listMessageIds(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
  const ids = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "message" && typeof entry.id === "string") ids.push(entry.id);
    } catch {
      // 跳过损坏/半写行
    }
  }
  return ids;
}

test("分支/树导航只改 leaf/context：entries 与原始 jsonl 全部保留（不物理删除）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pidance-noprune-branch-"));
  try {
    const sm = SessionFile.create("/tmp", dir);
    sm.appendModelChange("test", "model-a");
    const u1 = appendUser(sm, "第一个问题");
    const a1 = appendAssistant(sm, "回答一");
    const u2 = appendUser(sm, "第二个问题");
    const a2 = appendAssistant(sm, "回答二");
    // 无 assistant flush 前强制落盘（branch 语义等价 Pi 的 flush）
    sm.branch(a2);
    assert.equal(sm.getLeafId(), a2);

    const file = sm.getSessionFile();
    assert.ok(file);
    assert.equal(sm.isPersisted(), true);

    const messageIds = () => listMessageIds(file);
    const entriesCount = () => sm.getEntries().length;

    // 主链基线：root→leaf 路径 + 文件内容（getBranch 含 model_change 等非消息条目，取消息投影）
    const branchMessageIds = (entryId) =>
      sm.getBranch(entryId).filter((e) => e.type === "message").map((e) => e.id);
    assert.deepEqual(branchMessageIds(a2), [u1, a1, u2, a2]);
    const baselineEntries = entriesCount();
    const baselineMessages = messageIds();
    assert.equal(baselineMessages.length, 4);

    // 从 u2 开出旁支（navigate_tree / select_leaf_exact 的文件层原语）
    sm.branch(u2);
    const u3 = appendUser(sm, "旁支问题");
    const a3 = appendAssistant(sm, "旁支回答");

    // leaf/context 变化：旁支路径进入投影
    assert.equal(sm.getLeafId(), a3);
    assert.deepEqual(branchMessageIds(a3), [u1, a1, u2, u3, a3]);
    // entries 与原始 jsonl 只增不减：主链 4 条 + 旁支 2 条，无任何删除
    assert.equal(entriesCount(), baselineEntries + 2);
    assert.deepEqual(messageIds(), [...baselineMessages, u3, a3]);

    // 切回主链（恢复动作 = 树导航）：leaf 回 a2，context 回主链，entries 仍全保留
    sm.branch(a2);
    assert.equal(sm.getLeafId(), a2);
    assert.deepEqual(branchMessageIds(a2), [u1, a1, u2, a2]);
    assert.equal(entriesCount(), baselineEntries + 2);
    assert.deepEqual(messageIds(), [...baselineMessages, u3, a3]);

    // 再切回旁支末端（restore 等价语义）：仍无任何删除
    sm.branch(a3);
    assert.equal(sm.getLeafId(), a3);
    assert.equal(entriesCount(), baselineEntries + 2);
    assert.deepEqual(messageIds(), [...baselineMessages, u3, a3]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("恢复/切换旁支契约：select_leaf_exact 经 SessionService 落到 branch()，无物理删除", async () => {
  const rpc = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const svc = await readFile(new URL("./session-service.ts", import.meta.url), "utf8");
  const external = await readFile(
    new URL("./pi-runtime/external-session.ts", import.meta.url),
    "utf8",
  );

  // 恢复旁支走 select_leaf_exact：逻辑在 SessionService，文件层仅 branch()
  assert.match(svc, /sessionManager\.branch\(trimmedId\)/);
  // P1-4：rpc-manager 不再 import session-service，导航动作经构造注入 seam 落地
  assert.doesNotMatch(rpc, /from\s+["']\.\/session-service["']/);
  // 外部 RPC 会话分发 select_leaf_exact → 注入的 selectLeafExact 动作
  assert.match(external, /case "select_leaf_exact"/);
  assert.match(external, /selectLeafExact\(/);
});
