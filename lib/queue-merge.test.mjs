import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeFollowUpForSteer, joinQueueForRecall } from "./queue-merge.ts";

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
