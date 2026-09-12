import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeFollowUpForSteer,
  joinQueueForRecall,
  parseQueueAutoFlushReason,
  readFollowUpQueuePreference,
  shouldAutoFlushQueue,
} from "./queue-merge.ts";

test("mergeFollowUpForSteer 合并队列为一条消息（换行分隔）", () => {
  assert.equal(mergeFollowUpForSteer(["第一问", "第二问"]), "第一问\n第二问");
});

test("mergeFollowUpForSteer extra 并入队尾", () => {
  assert.equal(
    mergeFollowUpForSteer(["第一问"], "输入框补充"),
    "第一问\n输入框补充",
  );
});

test("mergeFollowUpForSteer 空/空白条目忽略", () => {
  assert.equal(mergeFollowUpForSteer(["", "  ", "有效"]), "有效");
  assert.equal(mergeFollowUpForSteer([" 有效 "]), "有效");
  assert.equal(mergeFollowUpForSteer([]), "");
  assert.equal(mergeFollowUpForSteer([], "  "), "");
});

test("joinQueueForRecall 空行分隔（对齐 TUI queue restore）", () => {
  assert.equal(joinQueueForRecall(["a", "b"]), "a\n\nb");
  assert.equal(joinQueueForRecall(["", "x"]), "x");
  assert.equal(joinQueueForRecall([]), "");
});

test("readFollowUpQueuePreference：读取嵌套队列并兼容扁平键", () => {
  // 旧格式（纯数组）：items 保留，revision 未知
  assert.deepEqual(
    readFollowUpQueuePreference({ sessionQueue: { a: ["one", " ", 2] } }, "a"),
    { items: ["one"], revision: null },
  );
  assert.deepEqual(readFollowUpQueuePreference({ "sessionQueue.b": ["two"] }, "b"), { items: ["two"], revision: null });
  assert.deepEqual(readFollowUpQueuePreference({ sessionQueue: { empty: [] } }, "empty"), { items: [], revision: null });
  // 新格式：带版本号（客户端据此丢弃过期回显）
  assert.deepEqual(
    readFollowUpQueuePreference({ sessionQueue: { c: { items: ["x", 3], revision: 7 } } }, "c"),
    { items: ["x"], revision: 7 },
  );
  // 结构非法 / 缺会话：null
  assert.equal(readFollowUpQueuePreference({ sessionQueue: { bad: { items: "no" } } }, "bad"), null);
  assert.equal(readFollowUpQueuePreference({}, "missing"), null);
});

test("shouldAutoFlushQueue：仅正常完成自动投递", () => {
  assert.equal(shouldAutoFlushQueue("completed"), true);
  assert.equal(shouldAutoFlushQueue("aborted"), false);
  assert.equal(shouldAutoFlushQueue("error"), false);
  assert.equal(shouldAutoFlushQueue(null), false);
  assert.equal(shouldAutoFlushQueue(undefined), false);
  assert.equal(parseQueueAutoFlushReason("completed"), "completed");
  assert.equal(parseQueueAutoFlushReason("nope"), null);
});
