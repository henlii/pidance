import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveActiveOutlineEntry,
  buildUserMessageOutline,
  entryUserText,
  lastUserEntryId,
  loadedUserOutlineSeeds,
  extendOutlineWithLoadedUsers,
  outlineForSession,
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

test("resolveActiveOutlineEntry：贴底且在最新一段 → 当前即最后一条提问", () => {
  // 末轮很短：视口顶部落在更早的轮次里，按顶部推会得到上一条
  const loaded = ["q1", "a1", "q2", "a2", "q3", "a3"];
  const outline = outlineOf(["q1", "q2", "q3"]);
  assert.equal(
    resolveActiveOutlineEntry({
      outline,
      loadedEntryIds: loaded,
      isAtLiveTail: true,
      isAtScrollBottom: true,
      topVisibleEntryId: "a1",
    }),
    "q3",
  );
  // 没贴底：仍然按阅读位置判定
  assert.equal(
    resolveActiveOutlineEntry({
      outline,
      loadedEntryIds: loaded,
      isAtLiveTail: true,
      isAtScrollBottom: false,
      topVisibleEntryId: "a1",
    }),
    "q1",
  );
  // 定位到历史中间：贴的是旧页底部，不得当作会话末尾
  assert.equal(
    resolveActiveOutlineEntry({
      outline,
      loadedEntryIds: ["q2", "a2"],
      isAtLiveTail: false,
      isAtScrollBottom: true,
      topVisibleEntryId: "a2",
    }),
    "q2",
  );
  // 空大纲仍然返回 null（调用方保持原高亮）
  assert.equal(
    resolveActiveOutlineEntry({
      outline: [],
      loadedEntryIds: loaded,
      isAtLiveTail: true,
      isAtScrollBottom: true,
      topVisibleEntryId: null,
    }),
    null,
  );
});

test("lastUserEntryId：取已加载窗口里最后一条用户消息，不看总条数", () => {
  assert.equal(lastUserEntryId([], []), null);
  assert.equal(
    lastUserEntryId(
      [{ role: "user" }, { role: "assistant" }, { role: "user" }],
      ["u1", "a1", "u2"],
    ),
    "u2",
  );
  // 条数没变、末条用户 id 从乐观变成落盘：必须能发现（fetch 不能只绑 length）
  assert.equal(
    lastUserEntryId(
      [{ role: "user" }, { role: "assistant" }],
      ["local-temp", "a1"],
    ),
    "local-temp",
  );
  assert.equal(
    lastUserEntryId(
      [{ role: "user" }, { role: "assistant" }],
      ["disk-u1", "a1"],
    ),
    "disk-u1",
  );
  assert.equal(
    lastUserEntryId([{ role: "assistant" }], ["a1"]),
    null,
  );
});

test("extendOutlineWithLoadedUsers：只把窗口末尾尚未进大纲的提问接到最后", () => {
  const outline = outlineOf(["a", "b"]);
  assert.deepEqual(
    extendOutlineWithLoadedUsers({
      outline,
      isAtLiveTail: true,
      loadedUsers: loadedUserOutlineSeeds(
        [{ role: "user", content: "A" }, { role: "assistant" }, { role: "user", content: "C" }],
        ["a", "x", "c"],
      ),
    }).map((i) => i.entryId),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    extendOutlineWithLoadedUsers({
      outline,
      isAtLiveTail: true,
      loadedUsers: [{ entryId: "a", text: "A" }, { entryId: "b", text: "B" }],
    }).map((i) => i.entryId),
    ["a", "b"],
  );
  // 大纲还没到：先用窗口里的提问，末项立刻能出现
  assert.deepEqual(
    extendOutlineWithLoadedUsers({
      outline: [],
      isAtLiveTail: true,
      loadedUsers: [{ entryId: "u1", text: "hi" }, { entryId: "u2", text: "next" }],
    }).map((i) => [i.entryId, i.ordinal, i.text]),
    [["u1", 0, "hi"], ["u2", 1, "next"]],
  );
  // 窗口是更早一页：缺的中间项不得被接到末尾冒充最后一条
  assert.deepEqual(
    extendOutlineWithLoadedUsers({
      outline: outlineOf(["a", "b", "c"]),
      isAtLiveTail: false,
      loadedUsers: [{ entryId: "a", text: "A" }, { entryId: "orphan", text: "nope" }],
    }).map((i) => i.entryId),
    ["a", "b", "c"],
  );
  // 已知末项在窗口中间、后面跟着更新的未知项：只接尾部那一段
  assert.deepEqual(
    extendOutlineWithLoadedUsers({
      outline: outlineOf(["a", "b"]),
      isAtLiveTail: true,
      loadedUsers: [{ entryId: "a", text: "A" }, { entryId: "b", text: "B" }, { entryId: "c", text: "C" }],
    }).map((i) => i.entryId),
    ["a", "b", "c"],
  );
});

test("outlineForSession：会话对不上时不沿用上一份大纲", () => {
  const items = outlineOf(["old"]);
  assert.deepEqual(outlineForSession({ sessionId: "B", ownerId: "A", items }), []);
  assert.deepEqual(
    outlineForSession({ sessionId: "A", ownerId: "A", items }).map((i) => i.entryId),
    ["old"],
  );
  assert.deepEqual(outlineForSession({ sessionId: null, ownerId: "A", items }), []);
});
