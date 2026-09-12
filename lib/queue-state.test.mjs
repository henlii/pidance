/**
 * 本地 follow-up 队列状态机的回归测试。
 *
 * 每个用例对应一个已发生过的缺陷，而不是算术练习：
 * - 失败回滚不得留下从未被接受的乐观值（旧实现恢复「上一份乐观值」）
 * - 并发入队时先完成的一笔不得提前放行服务端旧快照
 * - 请求早于写入、响应晚于归零时不得覆盖新值
 * - 切走会话后失败要修正原会话条目
 * - 回滚必须真的执行（旧实现比较数组引用，条件恒假）
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptRemoteQueue,
  beginSync,
  canAcceptObservation,
  hasPendingLocalChange,
  observeQueue,
  projection,
  proposeQueue,
  queueEntry,
  settleSyncFailure,
  settleSyncSuccess,
} from "./queue-state.ts";

const EMPTY_BOOK = {};

test("显示投影：优先乐观值，否则回落已确认基线", () => {
  const { book } = proposeQueue(EMPTY_BOOK, "A", ["a"]);
  assert.deepEqual(projection(queueEntry(book, "A")), ["a"]);
  const settled = settleSyncSuccess(book, "A", queueEntry(book, "A").revision, ["a"]);
  assert.deepEqual(projection(queueEntry(settled, "A")), ["a"]);
  assert.equal(queueEntry(settled, "A").pending, null, "成功后 pending 必须清空");
});

test("连续两次乐观写入都失败：退回已确认基线，不得留下从未被接受的中间值", () => {
  // 旧实现保存的是「上一份乐观值」，第一次失败会恢复出从未被服务端接受的 [A]。
  let book = {};
  const first = proposeQueue(book, "A", ["a"]);
  book = first.book;
  const second = proposeQueue(book, "A", ["a", "b"]);
  book = second.book;

  book = settleSyncFailure(book, "A", second.revision);
  assert.deepEqual(
    projection(queueEntry(book, "A")),
    [],
    "第二次失败后应退回基线 []，而不是第一次的乐观值 [a]",
  );

  // 第一次（迟到的）失败结算按 revision CAS 丢弃，不得覆盖。
  book = settleSyncFailure(book, "A", first.revision);
  assert.deepEqual(projection(queueEntry(book, "A")), []);
});

test("在途计数：并发入队时先完成的一笔不得提前放行服务端投影", () => {
  let book = {};
  const p1 = proposeQueue(book, "A", ["a"]);
  book = beginSync(p1.book, "A");
  const p2 = proposeQueue(book, "A", ["a", "b"]);
  book = beginSync(p2.book, "A");
  assert.equal(queueEntry(book, "A").syncs, 2);

  // 第一笔完成
  book = settleSyncSuccess(book, "A", p2.revision, ["a", "b"]);
  assert.equal(queueEntry(book, "A").syncs, 1);
  assert.equal(canAcceptObservation(queueEntry(book, "A")), false);

  // 此时服务端旧投影到达：不得覆盖
  const after = observeQueue(book, "A", [], 0);
  assert.deepEqual(projection(queueEntry(after, "A")), ["a", "b"], "在途期间旧快照必须被丢弃");

  book = settleSyncSuccess(book, "A", p2.revision, []);
  assert.equal(queueEntry(book, "A").syncs, 0);
  assert.equal(canAcceptObservation(queueEntry(book, "A")), true);
});

test("提交成功但期间有更新的写入：旧结果作废，只归还计数", () => {
  let book = {};
  const first = proposeQueue(book, "A", ["a"]);
  book = beginSync(first.book, "A");
  const second = proposeQueue(book, "A", ["a", "b"]);
  book = second.book;

  book = settleSyncSuccess(book, "A", first.revision, ["a"]);
  assert.deepEqual(
    projection(queueEntry(book, "A")),
    ["a", "b"],
    "旧代次的成功结果不得覆盖更新的乐观值",
  );
  assert.equal(queueEntry(book, "A").syncs, 0);
});

test("请求早于写入、响应晚于归零：旧响应不得覆盖新值", () => {
  let book = {};
  // 请求发起时捕获代次 0（空账）。
  const requestRevision = queueEntry(book, "A").revision;

  const proposal = proposeQueue(book, "A", ["a"]);
  book = beginSync(proposal.book, "A");
  book = settleSyncSuccess(book, "A", proposal.revision, ["a"]);
  assert.equal(queueEntry(book, "A").syncs, 0, "计数已归零——旧实现会在这里放行旧响应");

  const after = observeQueue(book, "A", [], requestRevision);
  assert.deepEqual(projection(queueEntry(after, "A")), ["a"], "代次不匹配的响应必须丢弃");
});

test("切走会话后失败：修正的是原会话条目，不是当前投影", () => {
  let book = {};
  const proposal = proposeQueue(book, "A", ["a"]);
  book = beginSync(proposal.book, "A");
  // 用户切到 B：A 的乐观值仍在账上，B 是空账。
  book = proposeQueue(book, "B", []).book;

  book = settleSyncFailure(book, "A", proposal.revision);
  assert.deepEqual(projection(queueEntry(book, "A")), [], "A 回到基线");
  assert.deepEqual(projection(queueEntry(book, "B")), []);
});

test("权威观察在无在途改动时正常落地", () => {
  const book = observeQueue(EMPTY_BOOK, "A", ["server"], 0);
  assert.deepEqual(projection(queueEntry(book, "A")), ["server"]);
  assert.equal(hasPendingLocalChange(queueEntry(book, "A")), false);
});

test("权威观察不得覆盖尚未提交的本地乐观值", () => {
  const proposal = proposeQueue(EMPTY_BOOK, "A", ["local"]);
  const after = observeQueue(proposal.book, "A", ["server"], proposal.revision);
  assert.deepEqual(projection(queueEntry(after, "A")), ["local"]);
});

test("同步计数不会降到负数", () => {
  let book = {};
  book = settleSyncFailure(book, "A", 0);
  assert.equal(queueEntry(book, "A").syncs, 0);
});

// ── 过期快照判定（引导整队发送后队列「复活」的根因）──

test("acceptRemoteQueue：接受更新版本并记录，丢弃过期快照", () => {
  // 首次见到：接受并记录
  assert.deepEqual(acceptRemoteQueue(undefined, 3), { accept: true, seen: 3 });
  // 更新版本：接受
  assert.deepEqual(acceptRemoteQueue(3, 4), { accept: true, seen: 4 });
  // 同版本（重复推送）：接受（幂等，账本自行去重）
  assert.deepEqual(acceptRemoteQueue(4, 4), { accept: true, seen: 4 });
  // 过期快照：丢弃，且不改动已见版本
  assert.deepEqual(acceptRemoteQueue(4, 2), { accept: false, seen: 4 });
});

test("acceptRemoteQueue：无版本号（旧 Host）不做判定", () => {
  assert.deepEqual(acceptRemoteQueue(undefined, null), { accept: true, seen: undefined });
  assert.deepEqual(acceptRemoteQueue(7, null), { accept: true, seen: 7 });
  assert.deepEqual(acceptRemoteQueue(undefined, undefined), { accept: true, seen: undefined });
});
