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
  hasUncertainWrite,
  itemToPayload,
  isQueueProposalLive,
  isQueueWriteConflict,
  latestPending,
  payloadsForWrite,
  projection,
  proposeQueue,
  proposeQueueWrite,
  queueEntry,
  queueRows,
  settleQueueWrite,
} from "./queue-state.ts";

const EMPTY_BOOK = {};

const item = (id, text, state = "waiting") => ({ id, text, state });

test("显示投影：优先最新乐观值，成功后回落权威条目", () => {
  const proposal = proposeQueue(EMPTY_BOOK, "A", ["a"]);
  assert.deepEqual(projection(queueEntry(proposal.book, "A")), ["a"]);
  const settled = settleQueueWrite(proposal.book, "A", proposal.revision, "accepted", {
    items: [item("i1", "a")],
    revision: 1,
  }).book;
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
  book = settleQueueWrite(book, "A", first.revision, "conflict", {
    items: [item("x", "x"), item("other", "other-tab")],
    revision: 1,
  }).book;
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
  // 真实客户端载荷都带写入令牌：`a` 已被受理（回执的 admittedAttemptIds 里），
  // 所以它由权威条目表达，不会再被后继重复列一遍。
  const first = proposeQueueWrite(EMPTY_BOOK, "A", {
    payloads: [{ text: "a", attemptId: "try-a" }],
    candidates: [{ text: "a", attemptId: "try-a" }],
  });
  const second = proposeQueueWrite(first.book, "A", {
    payloads: [{ text: "a", attemptId: "try-a" }, { text: "b", attemptId: "try-b" }],
    candidates: [{ text: "b", attemptId: "try-b" }],
  });
  const after = settleQueueWrite(second.book, "A", first.revision, "accepted", {
    items: [item("i1", "a")],
    revision: 7,
    admittedAttemptIds: ["try-a"],
  }).book;
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
  const after = settleQueueWrite(second.book, "A", first.revision, "rejected").book;
  assert.equal(isQueueProposalLive(queueEntry(after, "A"), second.revision), false);
  assert.deepEqual(projection(queueEntry(after, "A")), [], "退回权威条目（空队列）");
});

test("结算幂等：同一个提交结算两次不改变结果", () => {
  const proposal = proposeQueue(EMPTY_BOOK, "A", ["a"]);
  const once = settleQueueWrite(proposal.book, "A", proposal.revision, "rejected").book;
  const twice = settleQueueWrite(once, "A", proposal.revision, "rejected").book;
  assert.deepEqual(twice, once);
});

test("R2：冲突回执必须同时采纳权威内容与版本（不能形成新版本 + 旧内容）", () => {
  let book = adoptServerSnapshot(EMPTY_BOOK, "A", { items: [item("x", "x")], revision: 0 });
  const proposal = proposeQueue(book, "A", ["x", "next"]);
  book = settleQueueWrite(proposal.book, "A", proposal.revision, "conflict", {
    items: [item("x", "x"), item("other", "other")],
    revision: 1,
  }).book;
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
  // 乐观值仍优先显示；同时权威条目成为这份提交的底——冻结在提出时的载荷一旦落后于
  // 服务端，整包写出去就是「新版本 + 旧内容」（会删掉这里刚出现的 server）。
  assert.deepEqual(projection(queueEntry(after, "A")), ["server", "local"]);
  assert.equal(hasPendingLocalChange(queueEntry(after, "A")), true);
  assert.deepEqual(
    latestPending(queueEntry(after, "A")).payloads.map((payload) => payload.text),
    ["server", "local"],
  );
  assert.deepEqual(queueEntry(after, "A").items.map((entry) => entry.text), ["server"]);
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

  book = settleQueueWrite(book, "A", proposal.revision, "rejected").book;
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

test("I7：权威快照解决更早的未决提交，未受理的载荷回到草稿", () => {
  let book = adoptServerSnapshot(EMPTY_BOOK, "A", { items: [item("keep", "keep")], revision: 3 });
  // 用户入队：keep 是队列自己持有的（无令牌），uncertain 是新载荷。
  const enqueue = proposeQueueWrite(book, "A", {
    payloads: [itemToPayload(item("keep", "keep")), { text: "lost", attemptId: "try-lost" }],
    candidates: [{ text: "lost", attemptId: "try-lost" }],
  });
  book = settleQueueWrite(enqueue.book, "A", enqueue.revision, "unknown").book;
  assert.equal(hasUncertainWrite(queueEntry(book, "A")), true);
  assert.deepEqual(projection(queueEntry(book, "A")), ["keep", "lost"]);

  // 召回被受理：服务端队列为空，令牌表里没有 try-lost → 它从未被受理。
  const recall = proposeQueueWrite(book, "A", { payloads: [] });
  const settled = settleQueueWrite(recall.book, "A", recall.revision, "accepted", {
    items: [],
    revision: 4,
    admittedAttemptIds: [],
  });
  assert.deepEqual(settled.resolved.map((payload) => payload.text), ["lost"], "未受理的载荷交还草稿");
  assert.equal(hasUncertainWrite(queueEntry(settled.book, "A")), false, "未决提交不得跨权威快照存活");
  assert.deepEqual(projection(queueEntry(settled.book, "A")), [], "投影跟随权威快照");
});

test("I7：未确认但服务端其实已受理的载荷，不得再复制成草稿", () => {
  // 回执在途中丢失：Host 已受理（令牌入表），客户端却只能按 unknown 处理。
  let book = proposeQueueWrite(EMPTY_BOOK, "A", {
    payloads: [{ text: "landed", attemptId: "try-landed" }],
    candidates: [{ text: "landed", attemptId: "try-landed" }],
  }).book;
  book = settleQueueWrite(book, "A", 1, "unknown").book;

  const settle = proposeQueueWrite(book, "A", { payloads: [] });
  const settled = settleQueueWrite(settle.book, "A", settle.revision, "accepted", {
    items: [item("i1", "landed")],
    revision: 2,
    admittedAttemptIds: ["try-landed"],
  });
  assert.deepEqual(settled.resolved, [], "已受理过就归队列，不得变成可重发副本");
  assert.deepEqual(projection(queueEntry(settled.book, "A")), ["landed"]);
});

test("I7：后继提交按身份重整，不把已召回的条目或已认领的条目写回去", () => {
  let book = adoptServerSnapshot(EMPTY_BOOK, "A", {
    items: [item("keep", "keep"), item("same", "同文")],
    revision: 1,
  });
  // P1：unknown（其载荷 lost 从未被受理）。
  const first = proposeQueueWrite(book, "A", {
    payloads: [{ text: "lost", attemptId: "try-lost" }],
    candidates: [{ text: "lost", attemptId: "try-lost" }],
  });
  book = settleQueueWrite(first.book, "A", first.revision, "unknown").book;
  // P2：召回（显示为空）。
  const recall = proposeQueueWrite(book, "A", { payloads: [] });
  book = recall.book;
  // P3：召回在途时用户又入队——它的整包快照里含已经被召回的 keep 与未确认的 lost。
  const later = proposeQueueWrite(book, "A", {
    payloads: [itemToPayload(item("keep", "keep")), { text: "lost", attemptId: "try-lost" }, { text: "next", attemptId: "try-next" }],
    candidates: [{ text: "next", attemptId: "try-next" }],
  });
  book = later.book;

  const settled = settleQueueWrite(book, "A", recall.revision, "accepted", {
    items: [item("same", "同文", "claimed")],
    revision: 2,
    admittedAttemptIds: [],
  });
  const pending = latestPending(queueEntry(settled.book, "A"));
  assert.deepEqual(
    pending?.payloads.map((payload) => payload.text),
    ["next"],
    "已召回的 keep 与从未受理的 lost 都不再被写回",
  );
  assert.deepEqual(settled.resolved.map((payload) => payload.text), ["lost"]);
  assert.deepEqual(
    queueRows(queueEntry(settled.book, "A")).map((row) => row.text),
    ["next"],
    "显示仍是用户目标状态（重整后）",
  );
});

test("J1：冲突回执同样给更早的未决提交定论，不用过期 pending 覆盖权威队列", () => {
  let book = adoptServerSnapshot(EMPTY_BOOK, "A", { items: [item("keep", "keep")], revision: 1 });
  // P1：入队 lost，结果未知（服务端从未受理）。
  const first = proposeQueueWrite(book, "A", {
    payloads: [{ text: "lost", attemptId: "try-lost" }],
    candidates: [{ text: "lost", attemptId: "try-lost" }],
  });
  book = settleQueueWrite(first.book, "A", first.revision, "unknown").book;
  // P2：另一端已把队列写成 [keep, other]，本端带过期版本 → CAS 冲突（回执带权威队列）。
  const second = proposeQueueWrite(book, "A", {
    payloads: [{ text: "keep" }, { text: "lost", attemptId: "try-lost" }, { text: "retry", attemptId: "try-retry" }],
    candidates: [{ text: "retry", attemptId: "try-retry" }],
  });
  const settled = settleQueueWrite(second.book, "A", second.revision, "conflict", {
    items: [item("keep", "keep"), item("other", "other-tab")],
    revision: 2,
    admittedAttemptIds: [],
  });
  const entry = queueEntry(settled.book, "A");
  assert.deepEqual(projection(entry), ["keep", "other-tab"], "投影跟随权威队列，不再被过期 pending 盖住");
  assert.equal(hasUncertainWrite(entry), false, "更早的未决提交被冲突回执定论");
  assert.deepEqual(settled.resolved.map((payload) => payload.text), ["lost"], "未受理的内容回草稿");
  assert.deepEqual(settled.restore.map((payload) => payload.text), ["retry"], "本次未受理的候选回草稿");
});

test("J1：没有 revision 的回执既不当权威也不定论（路由 400 空体不覆盖本地队列）", () => {
  let book = adoptServerSnapshot(EMPTY_BOOK, "A", { items: [item("keep", "keep")], revision: 1 });
  const first = proposeQueueWrite(book, "A", {
    payloads: [{ text: "lost", attemptId: "try-lost" }],
    candidates: [{ text: "lost", attemptId: "try-lost" }],
  });
  book = settleQueueWrite(first.book, "A", first.revision, "unknown").book;
  const second = proposeQueueWrite(book, "A", {
    payloads: [{ text: "keep" }, { text: "lost", attemptId: "try-lost" }],
    candidates: [],
  });
  const settled = settleQueueWrite(second.book, "A", second.revision, "rejected", {
    items: [],
    revision: null,
  });
  const entry = queueEntry(settled.book, "A");
  assert.equal(entry.serverRevision, 1, "基线不被无版本的快照改写");
  assert.deepEqual(entry.items.map((entryItem) => entryItem.text), ["keep"], "本地权威条目不被空体清掉");
  assert.equal(hasUncertainWrite(entry), true, "没有权威内容就不能给未决提交定论");
  assert.deepEqual(settled.resolved, []);
});

test("J1-b：采纳权威快照时，未结算提交的整包载荷以权威队列为底重建", () => {
  const base = adoptServerSnapshot(EMPTY_BOOK, "A", { items: [item("keep", "keep")], revision: 1 });
  const first = proposeQueueWrite(base, "A", {
    payloads: [itemToPayload(item("keep", "keep")), { text: "mine", attemptId: "try-mine" }],
    candidates: [{ text: "mine", attemptId: "try-mine" }],
  });
  const second = proposeQueueWrite(first.book, "A", {
    payloads: [...first.payloads, { text: "foo", attemptId: "try-foo" }],
    candidates: [{ text: "foo", attemptId: "try-foo" }],
  });
  // 另一端改了队列并经由 SSE 被本端采纳：这份未结算提交必须补上 other，
  // 否则它下一次整包写入（带上推进后的 revision）会把 other 删掉。
  const after = adoptServerSnapshot(second.book, "A", {
    items: [item("keep", "keep"), item("other", "other-tab")],
    revision: 2,
  });
  assert.deepEqual(
    payloadsForWrite(queueEntry(after, "A")).map((payload) => payload.text),
    ["keep", "other-tab", "mine", "foo"],
  );
  assert.deepEqual(
    latestPending(queueEntry(after, "A")).candidates.map((payload) => payload.text),
    ["foo"],
    "候选集是逐次提交自己的新增内容，重整不动它（恢复时按链上全部候选收集）",
  );
});

test("J1-b：在途（claimed）的条目不进入重整后的载荷", () => {
  const base = adoptServerSnapshot(EMPTY_BOOK, "A", { items: [item("keep", "keep")], revision: 1 });
  const proposal = proposeQueueWrite(base, "A", {
    payloads: [itemToPayload(item("keep", "keep")), { text: "mine", attemptId: "try-mine" }],
    candidates: [{ text: "mine", attemptId: "try-mine" }],
  });
  const after = adoptServerSnapshot(proposal.book, "A", {
    items: [item("keep", "keep"), item("flying", "in-flight", "claimed")],
    revision: 2,
  });
  assert.deepEqual(
    payloadsForWrite(queueEntry(after, "A")).map((payload) => payload.text),
    ["keep", "mine"],
    "已提交给 Agent 的条目写回去就是投递第二次",
  );
});

test("K1：正文相同的第二条同文消息不得被权威重整消重", () => {
  const base = adoptServerSnapshot(EMPTY_BOOK, "A", { items: [item("keep", "hello")], revision: 1 });
  // 用户接着又入队一条同文消息（合法：队列里允许两条 same，见 session-queue 的 I4）。
  const proposed = proposeQueueWrite(base, "A", {
    payloads: [itemToPayload(item("keep", "hello")), { text: "hello", attemptId: "try-dup" }],
    candidates: [{ text: "hello", attemptId: "try-dup" }],
  });
  const after = adoptServerSnapshot(proposed.book, "A", {
    items: [item("keep", "hello"), item("other", "other-tab")],
    revision: 2,
  });
  assert.deepEqual(
    payloadsForWrite(queueEntry(after, "A")).map((payload) => payload.text),
    ["hello", "other-tab", "hello"],
    "权威那条 + 用户刚入队的第二条都要在待发送列表里（正文相同不能当同一条）",
  );
  assert.deepEqual(
    latestPending(queueEntry(after, "A")).candidates.map((payload) => payload.text),
    ["hello"],
  );
});

test("K1：令牌已被受理的载荷由权威条目表达，不重复列一遍", () => {
  const base = adoptServerSnapshot(EMPTY_BOOK, "A", { items: [item("keep", "hello")], revision: 1 });
  const proposed = proposeQueueWrite(base, "A", {
    payloads: [{ text: "hello", attemptId: "try-admitted" }],
    candidates: [{ text: "hello", attemptId: "try-admitted" }],
  });
  const after = adoptServerSnapshot(proposed.book, "A", {
    items: [item("i1", "hello")],
    revision: 2,
    admittedAttemptIds: ["try-admitted"],
  });
  assert.deepEqual(
    payloadsForWrite(queueEntry(after, "A")).map((payload) => payload.text),
    ["hello"],
    "服务端已经有它（令牌在 admittedAttemptIds 里），不能再列一遍",
  );
});

test("K2：空令牌数组是权威事实，缺字段才是「未知」（不得覆盖账本）", () => {
  const proposed = proposeQueueWrite(EMPTY_BOOK, "A", {
    payloads: [{ text: "hello", attemptId: "try-a" }],
    candidates: [{ text: "hello", attemptId: "try-a" }],
  });
  const admitted = adoptServerSnapshot(proposed.book, "A", {
    items: [],
    revision: 1,
    admittedAttemptIds: ["try-a"],
  });
  assert.deepEqual(queueEntry(admitted, "A").admittedAttemptIds, ["try-a"]);

  // 旧 Host 不带这个字段：保持账本已有的令牌，不能当成「从未受理」。
  const missing = adoptServerSnapshot(admitted, "A", { items: [], revision: 2 });
  assert.deepEqual(queueEntry(missing, "A").admittedAttemptIds, ["try-a"], "缺字段不覆盖");

  // 显式空数组是服务端的事实（确实没有受理过），要覆盖。
  const cleared = adoptServerSnapshot(missing, "A", { items: [], revision: 3, admittedAttemptIds: [] });
  assert.deepEqual(queueEntry(cleared, "A").admittedAttemptIds, [], "空数组覆盖");
});
