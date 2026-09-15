import test from "node:test";
import assert from "node:assert/strict";
import {
  sliceContextTail,
  sliceContextBefore,
  parseContextLimitParam,
  DEFAULT_SESSION_TAIL_LIMIT,
  sliceContextAround,
  sliceContextAfter,
  sessionExceedsModelWindow,
} from "./session-context-window.ts";

function ctx(n) {
  const messages = [];
  const entryIds = [];
  for (let i = 0; i < n; i++) {
    entryIds.push(`e${i}`);
    messages.push({ role: "user", content: `m${i}` });
  }
  return {
    messages,
    entryIds,
    thinkingLevel: "auto",
    model: { provider: "p", modelId: "m" },
  };
}

test("sliceContextTail：不足 limit 时 hasMoreBefore=false", () => {
  const w = sliceContextTail(ctx(10), 80);
  assert.equal(w.messages.length, 10);
  assert.equal(w.hasMoreBefore, false);
  assert.equal(w.totalMessageCount, 10);
});

test("sliceContextTail：截取最新 limit 条", () => {
  const w = sliceContextTail(ctx(100), 20);
  assert.equal(w.messages.length, 20);
  assert.equal(w.entryIds[0], "e80");
  assert.equal(w.entryIds[19], "e99");
  assert.equal(w.hasMoreBefore, true);
  assert.equal(w.totalMessageCount, 100);
  assert.equal(w.thinkingLevel, "auto");
});

test("sliceContextBefore：取 before 之前的窗口", () => {
  const w = sliceContextBefore(ctx(100), "e80", 20);
  assert.equal(w.entryIds[0], "e60");
  assert.equal(w.entryIds[19], "e79");
  assert.equal(w.hasMoreBefore, true);
  assert.equal(w.totalMessageCount, 100);
});

test("sliceContextBefore：before 为第一项时返回空", () => {
  const w = sliceContextBefore(ctx(10), "e0", 5);
  assert.deepEqual(w.entryIds, []);
  assert.equal(w.hasMoreBefore, false);
});

test("parseContextLimitParam：limit/tail 同义，缺省 null", () => {
  assert.equal(parseContextLimitParam({ get: () => null }), null);
  assert.equal(parseContextLimitParam({ get: (k) => (k === "limit" ? "40" : null) }), 40);
  assert.equal(parseContextLimitParam({ get: (k) => (k === "tail" ? "40" : null) }), 40);
  assert.equal(parseContextLimitParam({ get: () => "bad" }), DEFAULT_SESSION_TAIL_LIMIT);
});

// ── around/after 窗口协议（按 entryId 定位；前后游标由窗口起止决定）──

const ctxOf = (n) => ({
  messages: Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` })),
  entryIds: Array.from({ length: n }, (_, i) => `e${i}`),
  thinkingLevel: "high",
  model: { provider: "p", modelId: "m" },
});

test("around：返回含 anchor 的窗口，前后游标由窗口起止决定", () => {
  const w = sliceContextAround(ctxOf(300), "e150", 80);
  assert.ok(w);
  assert.equal(w.entryIds.length, 80);
  assert.ok(w.entryIds.includes("e150"));
  assert.equal(w.hasMoreBefore, true);
  assert.equal(w.hasMoreAfter, true, "中间窗口必须还有更新的历史可向下加载");
});

test("around：锚点在历史开头时 hasMoreBefore=false（不得用总数推断）", () => {
  const w = sliceContextAround(ctxOf(300), "e0", 80);
  assert.ok(w);
  assert.equal(w.hasMoreBefore, false);
  assert.equal(w.hasMoreAfter, true);
  assert.equal(w.entryIds[0], "e0");
});

test("around：锚点在末尾时 hasMoreAfter=false", () => {
  const w = sliceContextAround(ctxOf(300), "e299", 80);
  assert.ok(w);
  assert.equal(w.hasMoreAfter, false);
  assert.equal(w.hasMoreBefore, true);
});

test("around：锚点不在当前分支（列表）→ 显式未命中（null，不回退尾页）", () => {
  assert.equal(sliceContextAround(ctxOf(50), "not-in-list", 80), null);
});

test("after：取更近的一页，游标对称", () => {
  const w = sliceContextAfter(ctxOf(300), "e100", 80);
  assert.equal(w.entryIds[0], "e101");
  assert.equal(w.entryIds.length, 80);
  assert.equal(w.hasMoreBefore, true);
  assert.equal(w.hasMoreAfter, true);
  // 末尾之后没有内容
  const tail = sliceContextAfter(ctxOf(300), "e299", 80);
  assert.deepEqual(tail.entryIds, []);
  assert.equal(tail.hasMoreAfter, false);
});

test("tail/before 窗口显式声明没有更新历史", () => {
  assert.equal(sliceContextTail(ctxOf(300), 80).hasMoreAfter, false);
  assert.equal(sliceContextBefore(ctxOf(300), "e200", 80).hasMoreAfter, true);
});

test("around + toEnd：窗口从锚点前一小段一直取到最新（保留尾部流式段）", () => {
  const ctx = ctxOf(300);
  const w = sliceContextAround(ctx, "e150", 80, { toEnd: true });
  assert.ok(w);
  // 起点仍在锚点前（half 页），终点到最新
  assert.ok(w.entryIds.includes("e150"));
  assert.equal(w.entryIds[w.entryIds.length - 1], "e299", "必须取到最后一条（尾部流式输出不能被切掉）");
  assert.equal(w.hasMoreAfter, false);
  assert.equal(w.hasMoreBefore, true);
  // 不传 toEnd 时仍是「前后各半页」
  const half = sliceContextAround(ctx, "e150", 80);
  assert.equal(half.entryIds.length, 80);
  assert.equal(half.entryIds[half.entryIds.length - 1], "e189");
});

test("sessionExceedsModelWindow：占用超过「窗口 - 预留」才命中", () => {
  const exceeds = sessionExceedsModelWindow;

  // 实测案例：381K 会话切到声明 500000 的模型，按声明值仍有 100K 余量 → 未命中
  // （上游真实限额更低，这正是「未命中不代表安全」的情形）
  assert.equal(exceeds(381233, 500000, 16384), false);
  // 同一占用切到声明 272000 的模型 → 命中
  assert.equal(exceeds(381233, 272000, 16384), true);
  // 刚好等于窗口 - 预留：不命中（必须严格大于）
  assert.equal(exceeds(483616, 500000, 16384), false);
  assert.equal(exceeds(483617, 500000, 16384), true);
});

test("sessionExceedsModelWindow：缺失/非法输入一律不命中（不误报）", () => {
  const exceeds = sessionExceedsModelWindow;

  assert.equal(exceeds(null, 500000, 16384), false);
  assert.equal(exceeds(undefined, 500000, 16384), false);
  assert.equal(exceeds(0, 500000, 16384), false);
  assert.equal(exceeds(Number.NaN, 500000, 16384), false);
  assert.equal(exceeds(381233, null, 16384), false);
  assert.equal(exceeds(381233, undefined, 16384), false);
  assert.equal(exceeds(381233, 0, 16384), false);
  // 预留非法时按 0 处理（只用窗口本身比较）
  assert.equal(exceeds(500001, 500000, Number.NaN), true);
  assert.equal(exceeds(500000, 500000, -1), false);
});
