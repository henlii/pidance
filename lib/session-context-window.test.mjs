import test from "node:test";
import assert from "node:assert/strict";
import {
  sliceContextTail,
  sliceContextBefore,
  parseContextLimitParam,
  DEFAULT_SESSION_TAIL_LIMIT,
  DEFAULT_SESSION_HISTORY_PAGE,
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

// ---------- 分页边界对齐到「轮」（组大小实测差两个数量级，所以单位仍是条数） ----------

const u = (t) => ({ role: "user", content: t });
const a = (t) => ({ role: "assistant", content: t });
const wrap = (messages) => ({
  messages,
  entryIds: messages.map((_, i) => `e${i}`),
  thinkingLevel: "auto",
  model: { provider: "p", modelId: "m" },
});

test("tail 窗口起点向前对齐到最近的提问", () => {
  const w = sliceContextTail(wrap([u("q1"), a("a1"), a("a2"), u("q2"), a("a3")]), 1);
  assert.deepEqual(w.messages.map((m) => m.role), ["user", "assistant"]);
  assert.deepEqual(w.entryIds, ["e3", "e4"]);
});

test("tail 向前对齐不超过上限：找不到提问就切开一轮，不让单页膨胀", () => {
  const messages = [u("q1")];
  for (let i = 0; i < 20; i++) messages.push(a(`a${i}`));
  messages.push(a("last"));
  const w = sliceContextTail(wrap(messages), 2);
  assert.equal(w.messages.length, 2, "超过对齐上限时保持原条数");
  assert.equal(w.messages[0].content, "a19");
});

test("before 窗口起点同样对齐到提问", () => {
  // before=u2 之前 1 条 = [a1]，向前对齐到提问 q1（在对齐上限内）
  const messages = [u("q1"), a("a1"), u("q2"), a("a2")];
  const w = sliceContextBefore(wrap(messages), "e2", 1);
  assert.deepEqual(w.messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(w.messages[0].content, "q1");
});

test("分页常量：每页 100 条", () => {
  assert.equal(DEFAULT_SESSION_TAIL_LIMIT, 100);
  assert.equal(DEFAULT_SESSION_HISTORY_PAGE, 100);
});

// ---------- 预算按可见消息计（toolResult 搭车不占额度） ----------

const tr = (t) => ({ role: "toolResult", content: t, toolCallId: "tc" });

/** 一轮 = user → assistant(tool call) → toolResult ×4 → assistant */
function toolHeavyTurn(i, toolResults = 4) {
  const turn = [u(`q${i}`), a(`calling ${i}`)];
  for (let k = 0; k < toolResults; k++) turn.push(tr(`out${i}-${k}`));
  turn.push(a(`done ${i}`));
  return turn;
}

function toolHeavyMessages(turns) {
  const messages = [];
  for (let i = 0; i < turns; i++) messages.push(...toolHeavyTurn(i));
  return messages;
}

test("tail 预算按可见消息计：工具记录搭车，用户提问不再被饿死", () => {
  const messages = toolHeavyMessages(15); // 135 条原始，30 条可见
  const w = sliceContextTail(wrap(messages), 10);
  const visible = w.messages.filter((m) => m.role !== "toolResult");
  // 预算 10 条可见；起点再向前对齐到最近的提问，最多多带一轮开头的可见消息
  assert.ok(visible.length >= 10 && visible.length <= 13, `visible=${visible.length}`);
  assert.equal(w.messages[0].role, "user", "每页从提问开始");
  assert.equal(w.messages.at(-1).role, "assistant", "窗口必须到最新一条");
  const users = w.messages.filter((m) => m.role === "user");
  assert.ok(users.length >= 3, `应至少含 3 条提问，实际 ${users.length}`);
  // 旧口径（原始条数）在同一会话里 100 条只覆盖 2 条提问
  assert.ok(w.messages.length > 10, "原始条数确实多于可见条数（工具记录搭车）");
});

test("tail 原始跨度有硬上界：纯工具流不得让单页无界膨胀", () => {
  const messages = [a("start")];
  for (let i = 0; i < 1000; i++) messages.push(tr(`out${i}`));
  messages.push(a("done"));
  const w = sliceContextTail(wrap(messages), 50);
  assert.equal(w.messages.length, 300, "上界 = max(200, 50 * 6)");
  assert.equal(w.messages.at(-1).content, "done");
  assert.equal(w.hasMoreBefore, true);
});

test("tail 上界切进纯工具流：必须退到所属 assistant，首屏不能是空页", () => {
  // 工具流（700）比上界（600）长，末尾往回 600 条全是 toolResult —— 它们在 UI 上
  // 不单独渲染（只挂在所属 assistant 的工具卡里），这一页会一条都显示不出来。
  const messages = [a("assistant with many tools")];
  for (let i = 0; i < 700; i++) messages.push(tr(`out${i}`));
  const w = sliceContextTail(wrap(messages), 100);
  assert.equal(w.messages[0].role, "assistant", "必须带上所属 assistant");
  assert.equal(w.messages.length, 701);
  assert.equal(w.messages.at(-1).role, "toolResult", "窗口仍到最新一条");
  assert.equal(w.hasMoreBefore, false, "已退到会话开头");
});

test("窗内已有可见行时，上界仍是硬顶（不退让）", () => {
  const messages = [a("start")];
  for (let i = 0; i < 700; i++) messages.push(tr(`out${i}`));
  messages.push(a("done"));
  const w = sliceContextTail(wrap(messages), 100);
  assert.equal(w.messages.length, 600, "上界 = max(200, 100 * 6)");
  assert.equal(w.messages.at(-1).content, "done");
});

test("可见消息少于预算时返回整段，且 hasMoreBefore=false", () => {
  const w = sliceContextTail(wrap([u("q"), a("a"), tr("t1"), tr("t2")]), 100);
  assert.equal(w.messages.length, 4);
  assert.equal(w.hasMoreBefore, false);
  assert.equal(w.totalMessageCount, 4, "total 仍按原始条数报");
});

test("加载更早同样按可见消息计：工具记录不会吃掉整页", () => {
  const messages = toolHeavyMessages(20);
  const w = sliceContextBefore(wrap(messages), "e90", 10);
  const visible = w.messages.filter((m) => m.role !== "toolResult");
  // 预算 10 条；起点允许向前对齐到最近的提问（额外 1 条）
  assert.ok(visible.length >= 10 && visible.length <= 11, `visible=${visible.length}`);
  assert.equal(w.messages[0].role, "user", "每页从提问开始");
  assert.equal(w.entryIds.at(-1), "e89", "窗口到 before 之前一条为止");
});

test("加载更早：窗内全是 toolResult 时也退到所属 assistant", () => {
  // before 之前的上界窗口（200 条）全是工具记录：不回退的话这一次「加载更早」
  // 在界面上什么也不会多出来。
  const messages = [u("q"), a("call"), ...Array.from({ length: 400 }, (_, i) => tr(`out${i}`)), a("done")];
  const w = sliceContextBefore(wrap(messages), "e402", 10);
  const visible = w.messages.filter((m) => m.role !== "toolResult");
  assert.equal(visible.length, 1, "至少一条可见行");
  assert.equal(w.messages[0].role, "assistant");
  assert.equal(w.entryIds[0], "e1");
  assert.equal(w.entryIds.at(-1), "e401");
  assert.equal(w.hasMoreBefore, true);
});

test("向下加载：后面只剩工具记录时一次交完并结束「还有更新」", () => {
  // 空窗口不会推进游标：客户端会反复请求同一段。所以要么给出可见行，
  // 要么把剩余记录交完并让 hasMoreAfter=false。
  const messages = [u("q"), a("call"), ...Array.from({ length: 400 }, (_, i) => tr(`out${i}`))];
  const w = sliceContextAfter(wrap(messages), "e1", 10);
  assert.equal(w.entryIds[0], "e2");
  assert.equal(w.entryIds.at(-1), "e401", "剩余记录一次交完");
  assert.equal(w.hasMoreAfter, false, "不能留下永远推不动的空页");
});

test("向下加载：后面还有可见行时交到它为止", () => {
  const messages = [u("q"), a("call"), ...Array.from({ length: 400 }, (_, i) => tr(`out${i}`)), a("done")];
  const w = sliceContextAfter(wrap(messages), "e1", 10);
  assert.equal(w.entryIds.at(-1), "e402", "交到第一条可见行");
  assert.equal(w.hasMoreAfter, false);
});

test("跳转到工具记录时不返回空页", () => {
  const messages = [u("q"), a("call"), ...Array.from({ length: 400 }, (_, i) => tr(`out${i}`)), a("done")];
  const w = sliceContextAround(wrap(messages), "e300", 10);
  assert.ok(w, "命中必须返回窗口");
  assert.ok(w.messages.some((m) => m.role !== "toolResult"), "锚点在工具流里也要能渲染出行");
  assert.equal(w.messages[0].role, "assistant");
});

test("向下加载同样按可见消息计", () => {
  const messages = toolHeavyMessages(10);
  const w = sliceContextAfter(wrap(messages), "e2", 10);
  const visible = w.messages.filter((m) => m.role !== "toolResult");
  assert.ok(visible.length >= 10 && visible.length <= 11, `visible=${visible.length}`);
  assert.equal(w.entryIds[0], "e3");
});
