import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveActiveOutlineEntry,
  buildUserMessageOutline,
  entryUserText,
} from "./session-outline.ts";

const entry = (id, role, content, type = "message") => ({ id, type, message: { role, content } });

test("大纲只取用户消息，保持顺序并编号", () => {
  const outline = buildUserMessageOutline([
    entry("a", "user", "第一问"),
    entry("b", "assistant", [{ type: "text", text: "回答" }]),
    entry("c", "toolResult", []),
    entry("d", "user", "第二问"),
  ]);
  assert.deepEqual(outline.map((i) => [i.ordinal, i.entryId, i.text]), [
    [0, "a", "第一问"],
    [1, "d", "第二问"],
  ]);
});

test("大纲跳过缺 id 的条目（无法定位）与非 message 条目", () => {
  const outline = buildUserMessageOutline([
    { type: "message", message: { role: "user", content: "无 id" } },
    { id: "x", type: "model_change" },
    { id: "y", type: "message", message: { role: "user", content: "有 id" } },
  ]);
  assert.deepEqual(outline.map((i) => i.entryId), ["y"]);
});

test("entryUserText 支持字符串与 text 块，忽略非文本块", () => {
  assert.equal(entryUserText("纯文本"), "纯文本");
  assert.equal(
    entryUserText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]),
    "a\nb",
  );
  assert.equal(entryUserText(undefined), "");
});

test("大纲带时间戳（缺失则不带该字段）", () => {
  const outline = buildUserMessageOutline([
    { id: "a", type: "message", message: { role: "user", content: "x", timestamp: 123 } },
    { id: "b", type: "message", message: { role: "user", content: "y" } },
  ]);
  assert.equal(outline[0].timestamp, 123);
  assert.ok(!("timestamp" in outline[1]));
});

// ── 当前提问推导：不能依赖「提问本身已渲染」──

const outlineOf = (ids) => ids.map((id, i) => ({ entryId: id, ordinal: i, text: id }));

test("resolveActiveOutlineEntry：视口锚点在窗口中部 → 取该位置之前最后一条提问", () => {
  // 窗口顺序：a(提问) m m m b(提问) m m c(提问) m；锚点在 b 之后、c 之前
  const loaded = ["a", "m1", "m2", "m3", "b", "m4", "m5", "c", "m6"];
  const outline = outlineOf(["a", "b", "c"]);
  assert.equal(resolveActiveOutlineEntry({ outline, loadedEntryIds: loaded, isAtLiveTail: false, topVisibleEntryId: "m4" }), "b");
  assert.equal(resolveActiveOutlineEntry({ outline, loadedEntryIds: loaded, isAtLiveTail: false, topVisibleEntryId: "m6" }), "c");
  assert.equal(resolveActiveOutlineEntry({ outline, loadedEntryIds: loaded, isAtLiveTail: false, topVisibleEntryId: "m2" }), "a");
});

test("resolveActiveOutlineEntry：提问未渲染也能判定（长会话只渲染末几条）", () => {
  // 窗口里没有任何提问条目，但按位置仍应给出「窗口起点之前的那条」
  const loaded = ["m0", "m1", "m2", "m3"];
  const outline = outlineOf(["q1", "q2"]);
  // 锚点不在 loaded 中（例如未渲染）→ 按窗口起点处理，窗口内无提问 → null（保持原值）
  assert.equal(resolveActiveOutlineEntry({ outline, loadedEntryIds: loaded, isAtLiveTail: false, topVisibleEntryId: null }), null);
  assert.equal(resolveActiveOutlineEntry({ outline, loadedEntryIds: loaded, isAtLiveTail: false, topVisibleEntryId: "m9" }), null);
});

test("resolveActiveOutlineEntry：锚点在窗口第一条提问之前 → 回退窗口内第一条提问", () => {
  const loaded = ["m0", "q1", "m1", "q2"];
  const outline = outlineOf(["q1", "q2"]);
  assert.equal(resolveActiveOutlineEntry({ outline, loadedEntryIds: loaded, isAtLiveTail: false, topVisibleEntryId: "m0" }), "q1");
});

test("resolveActiveOutlineEntry：空输入返回 null（调用方保持原高亮）", () => {
  assert.equal(resolveActiveOutlineEntry({ outline: [], loadedEntryIds: ["a"], isAtLiveTail: true, topVisibleEntryId: "a" }), null);
  assert.equal(resolveActiveOutlineEntry({ outline: outlineOf(["q1"]), loadedEntryIds: [], isAtLiveTail: true, topVisibleEntryId: null }), null);
});

test("resolveActiveOutlineEntry：尾页窗口整段在提问之后 → 当前即最后一条提问", () => {
  // 长过程：最后一条提问之后有上百条过程消息，尾页窗口里一条提问都没有
  const loaded = Array.from({ length: 80 }, (_, i) => `m${i}`);
  const outline = outlineOf(["q1", "q2", "q3"]);
  assert.equal(
    resolveActiveOutlineEntry({ outline, loadedEntryIds: loaded, isAtLiveTail: true, topVisibleEntryId: "m10" }),
    "q3",
  );
  // 定位到历史中间（后面还有更新历史）时无法判断：保持原高亮
  assert.equal(
    resolveActiveOutlineEntry({ outline, loadedEntryIds: loaded, isAtLiveTail: false, topVisibleEntryId: "m10" }),
    null,
  );
});
