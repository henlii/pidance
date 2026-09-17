/**
 * 本地 follow-up 队列账本的回归测试。
 *
 * 每个用例对应一个已发生过的缺陷（括号里是复核编号），不是算术练习：
 * - 失败回滚不得留下从未被接受的乐观值
 * - 冲突必须同时采纳权威内容与版本（R2）
 * - 成功回执即新基线（R1）
 * - 过期快照不得把已经被带走的队列写回 UI，也不得回退 CAS 基线
 * - 按 sessionId 分账：切走会话后失败只修正原会话
 * - 冲突/失败后后继提交不得升到新基线（F11）
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  adoptServerSnapshot,
  hasPendingLocalChange,
  isQueueProposalLive,
  isQueueWriteConflict,
  latestPending,
  projection,
  proposeQueue,
  queueEntry,
  queueRows,
  settleSyncFailure,
  settleSyncSuccess,
} from "./queue-state.ts";

const EMPTY_BOOK = {};

const item = (id, text, state = "waiting") => ({ id, text, state });

test("显示投影：优先最新乐观值，成功后回落权威条目", () => {
  const proposal = proposeQueue(EMPTY_BOOK, "A", ["a"]);
  assert.deepEqual(projection(queueEntry(proposal.book, "A")), ["a"]);
  const settled = settleSyncSuccess(proposal.book, "A", proposal.revision, {
    items: [item("i1", "a")],
    revision: 1,
  });
  assert.deepEqual(projection(queueEntry(settled, "A")), ["a"]);
  assert.deepEqual(queueEntry(settled, "A").pending, [], "成功后链必须清空");
  assert.equal(queueEntry(settled, "A").serverRevision, 1, "成功回执即新 CAS 基线");
});

test("F11：第一个提交冲突，后继一并作废且不得再发送", () => {
  // 标签 A 本地 [x]@0；Host 因另一标签入队已是 [x, other]@1。
  let book = adoptServerSnapshot(EMPTY_BOOK, "A", { items: [item("x", "x")], revision: 0 });
  const first = proposeQueue(book, "A", ["x", "mine-1"]);
  book = first.book;
  const second = proposeQueue(book, "A", ["x", "mine-1", "mine-2"]);
  book = second.book;
  assert.equal(isQueueProposalLive(queueEntry(book, "A"), second.revision), true);

  // 第一个提交收到冲突回执：采纳权威内容与版本，后继一起作废。
  book = settleSyncFailure(book, "A", first.revision, {
    items: [item("x", "x"), item("other", "other-tab")],
    revision: 1,
  });
  assert.equal(isQueueProposalLive(queueEntry(book, "A"), first.revision), false);
  assert.equal(
    isQueueProposalLive(queueEntry(book, "A"), second.revision),
    false,
    "后继基于旧基线，必须作废（否则下次写入会删掉另一标签的条目）",
  );
  assert.deepEqual(projection(queueEntry(book, "A")), ["x", "other-tab"]);
  assert.equal(queueEntry(book, "A").serverRevision, 1);
});

test("第一个提交成功时后继仍在链上，并以推进后的基线继续", () => {
  const first = proposeQueue(EMPTY_BOOK, "A", ["a"]);
  const second = proposeQueue(first.book, "A", ["a", "b"]);
  const after = settleSyncSuccess(second.book, "A", first.revision, {
    items: [item("i1", "a")],
    revision: 7,
  });
  assert.equal(isQueueProposalLive(queueEntry(after, "A"), first.revision), false);
  assert.equal(
    isQueueProposalLive(queueEntry(after, "A"), second.revision),
    true,
    "第一个写入成功即证明新基线可用，后继不必作废",
  );
  assert.equal(queueEntry(after, "A").serverRevision, 7, "expectedRevision 来自回执");
  assert.deepEqual(projection(queueEntry(after, "A")), ["a", "b"], "显示仍是用户的目标状态");
});

test("网络错误（没有回执快照）同样作废后继", () => {
  const first = proposeQueue(EMPTY_BOOK, "A", ["a"]);
  const second = proposeQueue(first.book, "A", ["a", "b"]);
  const after = settleSyncFailure(second.book, "A", first.revision);
  assert.equal(isQueueProposalLive(queueEntry(after, "A"), second.revision), false);
  assert.deepEqual(projection(queueEntry(after, "A")), [], "退回权威条目（空队列）");
});

test("结算幂等：同一个提交结算两次不改变结果", () => {
  const proposal = proposeQueue(EMPTY_BOOK, "A", ["a"]);
  const once = settleSyncFailure(proposal.book, "A", proposal.revision);
  const twice = settleSyncFailure(once, "A", proposal.revision);
  assert.deepEqual(twice, once);
});

test("R2：冲突回执必须同时采纳权威内容与版本（不能形成新版本 + 旧内容）", () => {
  let book = adoptServerSnapshot(EMPTY_BOOK, "A", { items: [item("x", "x")], revision: 0 });
  const proposal = proposeQueue(book, "A", ["x", "next"]);
  book = settleSyncFailure(proposal.book, "A", proposal.revision, {
    items: [item("x", "x"), item("other", "other")],
    revision: 1,
  });
  assert.equal(queueEntry(book, "A").serverRevision, 1, "版本前移到冲突回执的权威版本");
  assert.deepEqual(
    projection(queueEntry(book, "A")),
    ["x", "other"],
    "内容必须一起前移，不能保留旧内容配新版本",
  );
});

test("过期快照：内容与版本一起丢弃，不回退 CAS 基线", () => {
  let book = adoptServerSnapshot(EMPTY_BOOK, "A", { items: [item("i2", "new")], revision: 5 });
  book = adoptServerSnapshot(book, "A", { items: [item("i1", "old")], revision: 3 });
  assert.deepEqual(projection(queueEntry(book, "A")), ["new"]);
  assert.equal(queueEntry(book, "A").serverRevision, 5);
});

test("权威快照不覆盖显示中的乐观值，但内容已经落地", () => {
  const proposal = proposeQueue(EMPTY_BOOK, "A", ["local"]);
  const after = adoptServerSnapshot(proposal.book, "A", { items: [item("s", "server")], revision: 1 });
  assert.deepEqual(projection(queueEntry(after, "A")), ["local"], "乐观值仍优先显示");
  assert.equal(hasPendingLocalChange(queueEntry(after, "A")), true);
  assert.deepEqual(latestPending(queueEntry(after, "A")).payloads, [{ text: "local" }]);
});

test("在途条目与 unknown 条目分别出现在行投影里", () => {
  const book = adoptServerSnapshot(EMPTY_BOOK, "A", {
    items: [item("w", "待发", "waiting"), item("u", "未知", "unknown")],
    inFlight: ["在途"],
    revision: 2,
  });
  const rows = queueRows(queueEntry(book, "A"));
  assert.deepEqual(rows.map((row) => [row.text, row.state]), [
    ["待发", "waiting"],
    ["未知", "unknown"],
    ["在途", "claimed"],
  ]);
  // 队列内容（取回/落盘）包含 unknown：用户必须能取回结果未知的内容。
  assert.deepEqual(projection(queueEntry(book, "A")), ["待发", "未知"]);
});

test("图片数量只数原图：一份图有模型副本与原图两份引用", () => {
  const media = [
    { role: "model", path: "/a/model.webp", name: "a.png", mimeType: "image/webp", size: 3 },
    { role: "original", path: "/a/orig.png", name: "a.png", mimeType: "image/png", size: 9 },
  ];
  const book = adoptServerSnapshot(EMPTY_BOOK, "A", {
    items: [{ id: "i1", text: "看图", state: "waiting", media }],
    revision: 1,
  });
  assert.equal(queueRows(queueEntry(book, "A"))[0].imageCount, 1);
});

test("切走会话后失败：修正的是原会话条目，不是当前投影", () => {
  const proposal = proposeQueue(EMPTY_BOOK, "A", ["a"]);
  let book = proposal.book;
  // 用户切到 B：A 的乐观值仍在账上，B 是空账。
  book = proposeQueue(book, "B", []).book;

  book = settleSyncFailure(book, "A", proposal.revision);
  assert.deepEqual(projection(queueEntry(book, "A")), [], "A 回到权威条目");
  assert.deepEqual(projection(queueEntry(book, "B")), []);
});

test("无版本号的旧数据：内容落地但 CAS 基线保持未知", () => {
  const book = adoptServerSnapshot(EMPTY_BOOK, "A", { items: [item("i1", "legacy")], revision: null });
  assert.deepEqual(projection(queueEntry(book, "A")), ["legacy"]);
  assert.equal(queueEntry(book, "A").serverRevision, null);
});

test("#32 isQueueWriteConflict 只认显式 conflict 回执", () => {
  assert.equal(isQueueWriteConflict({ ok: true, revision: 2 }), false);
  assert.equal(isQueueWriteConflict({ ok: false, conflict: true, revision: 1, items: [] }), true);
  assert.equal(isQueueWriteConflict(null), false);
  assert.equal(isQueueWriteConflict(undefined), false);
  assert.equal(isQueueWriteConflict("conflict"), false);
});
