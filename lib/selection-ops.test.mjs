/**
 * 模型/思考写入操作的串行与结算（纯函数）。
 *
 * 回归目标：
 * - 迟到的失败不得回滚更新的选择（A→B 时 A 失败不能抹掉 B）
 * - 同会话操作登记唯一，结算幂等
 * - 在途期间不得用磁盘快照结算 override
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  closeSelectionOp,
  hasOpenOp,
  isLatestOp,
  openSelectionOp,
} from "./selection-ops.ts";

test("迟到失败的回滚 CAS：更新的操作使旧代次失效", () => {
  // 用户先选 A（op 1），随即改选 B（op 2）。A 的请求迟到失败。
  let book = openSelectionOp({}, "S", 1);
  book = openSelectionOp(book, "S", 2);

  assert.equal(isLatestOp(book, "S", 1), false, "op1 已不是最新，不得回滚");
  assert.equal(isLatestOp(book, "S", 2), true, "op2 仍可结算");

  // op1 的失败结算不得清掉 op2 的登记
  const afterLateFirst = closeSelectionOp(book, "S", 1);
  assert.equal(isLatestOp(afterLateFirst, "S", 2), true, "op2 仍是当前操作");
  assert.equal(hasOpenOp(afterLateFirst, "S"), true);

  // op2 正常结算后清空
  const done = closeSelectionOp(afterLateFirst, "S", 2);
  assert.equal(hasOpenOp(done, "S"), false);
});

test("结算幂等：重复结算同一代次不报错且不误删", () => {
  const book = openSelectionOp({}, "S", 7);
  const once = closeSelectionOp(book, "S", 7);
  const twice = closeSelectionOp(once, "S", 7);
  assert.equal(hasOpenOp(twice, "S"), false);
  assert.deepEqual(twice, once);
});

test("按会话分账：不同会话的操作互不影响", () => {
  let book = openSelectionOp({}, "A", 1);
  book = openSelectionOp(book, "B", 2);
  assert.equal(isLatestOp(book, "A", 1), true);
  assert.equal(isLatestOp(book, "B", 2), true);
  assert.equal(isLatestOp(book, "A", 2), false, "代次是全局递增的，跨会话不互相顶替");
  const afterA = closeSelectionOp(book, "A", 1);
  assert.equal(hasOpenOp(afterA, "B"), true, "结算 A 不得影响 B 的在途登记");
});
