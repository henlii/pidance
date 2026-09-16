/**
 * 本地 follow-up 队列状态机的回归测试。
 *
 * 每个用例对应一个已发生过的缺陷，而不是算术练习：
 * - 失败回滚不得留下从未被接受的乐观值
 * - 冲突必须同时采纳权威内容与版本（旧实现只更新版本，下次 CAS 删掉别人的消息）
 * - 成功回执即新基线（旧实现忽略回执版本，下一次写入被 CAS 拒 → 转引导失败）
 * - 过期快照不得把已经被带走的队列写回 UI，也不得回退 CAS 基线
 * - 按 sessionId 分账：切走会话后失败只修正原会话
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  adoptServerSnapshot,
  hasPendingLocalChange,
  isQueueWriteConflict,
  projection,
  proposeQueue,
  queueEntry,
  queueRows,
  settleSyncFailure,
  settleSyncSuccess,
} = await jiti.import("./queue-state.ts");

const EMPTY_BOOK = {};

const item = (id, text, state = "waiting") => ({ id, text, state });

test("显示投影：优先乐观值，否则回落权威条目", () => {
  const { book } = proposeQueue(EMPTY_BOOK, "A", ["a"]);
  assert.deepEqual(projection(queueEntry(book, "A")), ["a"]);
  const settled = settleSyncSuccess(book, "A", queueEntry(book, "A").revision, {
    items: [item("i1", "a")],
    revision: 1,
  });
  assert.deepEqual(projection(queueEntry(settled, "A")), ["a"]);
  assert.equal(queueEntry(settled, "A").pending, null, "成功后 pending 必须清空");
  assert.equal(queueEntry(settled, "A").serverRevision, 1, "成功回执即新 CAS 基线");
});

test("连续两次乐观写入都失败：退回权威条目，不得留下从未被接受的中间值", () => {
  let book = {};
  const first = proposeQueue(book, "A", ["a"]);
  book = first.book;
  const second = proposeQueue(book, "A", ["a", "b"]);
  book = second.book;

  book = settleSyncFailure(book, "A", second.revision);
  assert.deepEqual(
    projection(queueEntry(book, "A")),
    [],
    "第二次失败后应退回权威条目 []，而不是第一次的乐观值 [a]",
  );

  // 第一次（迟到的）失败结算按 revision CAS 丢弃，不得覆盖。
  book = settleSyncFailure(book, "A", first.revision);
  assert.deepEqual(projection(queueEntry(book, "A")), []);
});

test("R2：冲突回执必须同时采纳权威内容与版本（不能形成新版本 + 旧内容）", () => {
  // 本地 [x]@0，服务端 [x, other]@1；当前追加冲突。
  let book = adoptServerSnapshot(EMPTY_BOOK, "A", { items: [item("x", "x")], revision: 0 });
  const proposal = proposeQueue(book, "A", ["x", "next"]);
  book = proposal.book;
  book = settleSyncFailure(book, "A", proposal.revision, {
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

test("R1：成功后立刻用回执版本做下一次 CAS", () => {
  let book = {};
  const first = proposeQueue(book, "A", ["a"]);
  book = settleSyncSuccess(first.book, "A", first.revision, {
    items: [item("i1", "a")],
    revision: 7,
  });
  assert.equal(queueEntry(book, "A").serverRevision, 7, "expectedRevision 必须来自回执");
});

test("提交成功但期间有更新的写入：旧结果作废", () => {
  let book = {};
  const first = proposeQueue(book, "A", ["a"]);
  const second = proposeQueue(first.book, "A", ["a", "b"]);
  book = second.book;

  book = settleSyncSuccess(book, "A", first.revision, { items: [item("i1", "a")], revision: 1 });
  assert.deepEqual(
    projection(queueEntry(book, "A")),
    ["a", "b"],
    "旧代次的成功结果不得覆盖更新的乐观值",
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
  assert.deepEqual(
    queueRows(queueEntry(after, "A")).map((row) => row.text),
    ["local"],
  );
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

test("切走会话后失败：修正的是原会话条目，不是当前投影", () => {
  let book = {};
  const proposal = proposeQueue(book, "A", ["a"]);
  book = proposal.book;
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

// ---------------------------------------------------------------------------
// Issue #32：队列写入冲突判定
// ---------------------------------------------------------------------------

test("#32 isQueueWriteConflict 只认显式 conflict 回执", () => {
  assert.equal(isQueueWriteConflict({ ok: true, revision: 2 }), false);
  assert.equal(isQueueWriteConflict({ ok: false, conflict: true, revision: 1, items: [] }), true);
  assert.equal(isQueueWriteConflict(null), false);
  assert.equal(isQueueWriteConflict(undefined), false);
  assert.equal(isQueueWriteConflict("conflict"), false);
});
