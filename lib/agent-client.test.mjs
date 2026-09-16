/**
 * 引导/发送回执的客户端信任边界（issue #42 / R7 / A8）。
 *
 * 每个用例对应一个已发生过的缺陷：
 * - 只认 accepted/rejected 时，Host 的 `queued`（载荷已可靠入队）会被当成非法回执
 *   抛错 → 用户看到失败并重发一次，实际投递两次
 * - 回执里的结构化字段（action/reason/queue）被丢掉，客户端只能猜处置
 * - submissionId/sessionId 不校验 → 迟到的回执被当成当前提交的结果
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { submitAgentPrompt } = await jiti.import("./agent-client.ts");

function stubFetch(body, { ok = true, status = 200 } = {}) {
  const original = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return { ok, status, json: async () => body };
  };
  return {
    captured: () => captured,
    restore: () => { globalThis.fetch = original; },
  };
}

const INPUT = { message: "hello", submissionId: "s1" };

async function withStub(body, run, options) {
  const stub = stubFetch(body, options);
  try {
    return await run(stub);
  } finally {
    stub.restore();
  }
}

test("#42 queued 是合法回执：载荷已入队不得报成失败", async () => {
  const receipt = await withStub({ success: true, data: {
    submissionId: "s1", sessionId: "sess", status: "queued", action: "queued", reason: "compacting",
  } }, (stub) => submitAgentPrompt("sess", INPUT));
  assert.equal(receipt.status, "queued");
  assert.equal(receipt.action, "queued");
  assert.equal(receipt.reason, "compacting");
});

test("#42 结构化字段透传；未知 token 被丢弃（不猜处置）", async () => {
  const receipt = await withStub({ success: true, data: {
    submissionId: "s1", sessionId: "sess", status: "rejected", action: "bogus", reason: "nonsense",
  } }, () => submitAgentPrompt("sess", INPUT));
  assert.equal(receipt.status, "rejected");
  assert.equal(receipt.action, undefined);
  assert.equal(receipt.reason, undefined, "无法识别的 reason 必须丢弃，客户端不能按它处置");
});

test("#42 回执中的权威队列快照按条目身份归一化", async () => {
  const receipt = await withStub({ success: true, data: {
    submissionId: "s1",
    sessionId: "sess",
    status: "rejected",
    reason: "busy",
    queue: {
      revision: 4,
      items: [
        { id: "i1", text: "a", state: "waiting" },
        { id: "i2", text: "b", state: "unknown" },
        { id: "", text: "bad" },
        { text: 42 },
      ],
      inFlight: ["in flight", 7],
    },
  } }, () => submitAgentPrompt("sess", INPUT));
  assert.equal(receipt.queue.revision, 4);
  // 缺 id 的条目不得被丢掉（丢掉就是丢用户内容）：按内容造稳定 id。
  assert.deepEqual(receipt.queue.items.map((item) => [item.text, item.state]), [
    ["a", "waiting"],
    ["b", "unknown"],
    ["bad", "waiting"],
  ]);
  assert.ok(receipt.queue.items.every((item) => item.id.length > 0), "造出的 id 必须非空");
  assert.deepEqual(receipt.queue.inFlight, ["in flight"]);
});

test("#42 半截队列快照宁缺勿错：缺 revision/items 时不返回 queue", async () => {
  const receipt = await withStub({ success: true, data: {
    submissionId: "s1", sessionId: "sess", status: "accepted", queue: { items: [] },
  } }, () => submitAgentPrompt("sess", INPUT));
  assert.equal(receipt.queue, undefined);
});

test("#42 回执必须对应本次提交与会话", async () => {
  await assert.rejects(
    () => withStub({ success: true, data: { submissionId: "other", sessionId: "sess", status: "accepted" } },
      () => submitAgentPrompt("sess", INPUT)),
    /Invalid prompt receipt/,
  );
  await assert.rejects(
    () => withStub({ success: true, data: { submissionId: "s1", sessionId: "other", status: "accepted" } },
      () => submitAgentPrompt("sess", INPUT)),
    /Invalid prompt receipt/,
  );
});

test("#42 未知状态与缺失 data 都抛错（不得当成已接受）", async () => {
  await assert.rejects(
    () => withStub({ success: true, data: { submissionId: "s1", sessionId: "sess", status: "pending" } },
      () => submitAgentPrompt("sess", INPUT)),
    /Invalid prompt receipt/,
  );
  await assert.rejects(
    () => withStub({ success: true, data: null }, () => submitAgentPrompt("sess", INPUT)),
    /Invalid prompt receipt: expected an object/,
  );
});

test("#42 HTTP 错误照旧向上抛（客户端据此回草稿）", async () => {
  await assert.rejects(
    () => withStub({ error: "Agent is already processing" }, () => submitAgentPrompt("sess", INPUT), { ok: false, status: 409 }),
    /already processing/,
  );
});
