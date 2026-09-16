import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  mergeFollowUpForSteer,
  joinQueueForRecall,
  parseQueueAutoFlushReason,
  readFollowUpQueuePreference,
  shouldAutoFlushQueue,
} = await jiti.import("./queue-merge.ts");

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
  const texts = (pref) => pref.items.map((item) => [item.text, item.state]);
  // 旧格式（纯数组）：条目按正文清洗，revision 未知（无法判新旧）
  const legacy = readFollowUpQueuePreference({ sessionQueue: { a: ["one", " ", 2] } }, "a");
  assert.deepEqual(texts(legacy), [["one", "waiting"]]);
  assert.equal(legacy.revision, null);
  // 旧格式没有 id：同一份数据两次读取必须得到同一身份
  assert.equal(
    readFollowUpQueuePreference({ sessionQueue: { a: ["one", " ", 2] } }, "a").items[0].id,
    legacy.items[0].id,
  );
  assert.deepEqual(texts(readFollowUpQueuePreference({ "sessionQueue.b": ["two"] }, "b")), [["two", "waiting"]]);
  assert.deepEqual(readFollowUpQueuePreference({ sessionQueue: { empty: [] } }, "empty"), { items: [], revision: null });
  // 新格式：保留条目身份与状态，带版本号（客户端据此丢弃过期回显）
  assert.deepEqual(
    readFollowUpQueuePreference(
      { sessionQueue: { c: { items: [{ id: "i1", text: "x", state: "unknown" }], revision: 7 } } },
      "c",
    ),
    { items: [{ id: "i1", text: "x", state: "unknown" }], revision: 7 },
  );
  // 非法 state 回落 waiting，缺 id 按正文补确定性 id
  assert.deepEqual(
    texts(readFollowUpQueuePreference({ sessionQueue: { d: { items: [{ text: "y", state: "bogus" }], revision: 1 } } }, "d")),
    [["y", "waiting"]],
  );
  // 结构非法 / 缺会话：null（不得当作权威空队列）
  assert.equal(readFollowUpQueuePreference({ sessionQueue: { bad: { items: "no" } } }, "bad"), null);
  assert.equal(readFollowUpQueuePreference({ sessionQueue: { noItems: { revision: 3 } } }, "noItems"), null);
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
