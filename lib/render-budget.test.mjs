/**
 * 渲染开销预算（2026-10-07 事故的根治项）。
 *
 * 决策是纯函数式的，所以这里测行为；接线（真的被用在两条限流路径上）另用守卫断言。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const {
  createRenderBudget,
  RENDER_DUTY_CYCLE,
  framePartialText,
  partialGrowthThreshold,
  renderedLinesFrame,
  PARTIAL_GROWTH_FLOOR_CHARS,
  PARTIAL_GROWTH_RATIO,
} = await jiti.import("./render-budget.ts");

test("没量到开销时就是基础间隔（正常情况下行为与改动前一致）", () => {
  const budget = createRenderBudget({ baseMs: 100 });
  assert.equal(budget.minIntervalMs(), 100);
  assert.equal(budget.overloaded(), false);
});

test("渲染开销小：仍取基础间隔，不因为一次 20ms 的渲染就变慢", () => {
  const budget = createRenderBudget({ baseMs: 100 });
  budget.record(20);
  assert.equal(budget.minIntervalMs(), 100);
  assert.equal(budget.overloaded(), false);
});

test("渲染开销超过基础间隔：间隔按占空比放大，且随开销线性变长", () => {
  assert.equal(RENDER_DUTY_CYCLE, 0.25, "占空比写死在这里：改常量要连带确认这条断言");
  const budget = createRenderBudget({ baseMs: 100 });
  budget.record(200);
  assert.equal(budget.minIntervalMs(), 800, "200ms 的渲染 → 每 800ms 才准再渲一次（1/4 占空）");
  assert.equal(budget.overloaded(), true);
  budget.record(262);
  assert.equal(budget.minIntervalMs(), 1048, "实测 55 万字符 ≈ 262ms 的渲染对应这个间隔");
});

test("占空比可调；非法占空比回落到默认值", () => {
  const half = createRenderBudget({ baseMs: 100, dutyCycle: 0.5 });
  half.record(200);
  assert.equal(half.minIntervalMs(), 400);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const budget = createRenderBudget({ baseMs: 100, dutyCycle: bad });
    budget.record(400);
    assert.equal(budget.minIntervalMs(), 1600, `占空比 ${String(bad)} 应回落到默认`);
  }
  const capped = createRenderBudget({ baseMs: 100, dutyCycle: 2 });
  capped.record(100);
  assert.equal(capped.minIntervalMs(), 100, "占空比夹到 ≤1");
});

test("非法开销不改判定（量不出来就当没量到）", () => {
  const budget = createRenderBudget({ baseMs: 100 });
  budget.record(200);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    budget.record(bad);
    assert.equal(budget.minIntervalMs(), 800, `开销 ${String(bad)} 不该改判定`);
  }
  budget.record(0);
  assert.equal(budget.minIntervalMs(), 100, "真的量到 0ms 要如实回落");
});

test("接线：宿主在唯一的重渲入口记开销，两条限流路径都读预算，宽度变化也走限频", () => {
  const source = readFileSync(new URL("./sdk-session-host.ts", import.meta.url), "utf8");
  assert.match(source, /createRenderBudget\(\{\s*baseMs: SdkSessionHost\.PARTIAL_RENDER_MIN_INTERVAL_MS,?\s*\}\)/, "宿主没建预算");
  assert.match(source, /this\.renderBudget\.record\(Date\.now\(\) - startedAt\)/, "重渲没记实际开销（预算就永远停在基础间隔）");
  assert.match(source, /now - entry\.lastPartialAt < this\.renderBudget\.minIntervalMs\(\)/, "partial 限流没用预算");
  assert.match(source, /minIntervalMs: \(\) => this\.renderBudget\.minIntervalMs\(\)/, "插件 invalidate 限流没用预算");
  // 宽度变化在拖动窗口时并不低频：必须回到限频路径，否则拖着窗口就能把事件循环打满
  assert.match(source, /private rerenderToolLines\(\): void \{\s*\n\s*for \(const key of this\.toolRenderStates\.keys\(\)\) this\.toolRenderScheduler\.request\(key\);/, "宽度变化仍在无预算地立即重渲");
});

test("接线：partial 走增长门槛；结果槽发增量帧（不再每帧重发全文）", () => {
  const host = readFileSync(new URL("./sdk-session-host.ts", import.meta.url), "utf8");
  assert.match(host, /const payloadChars = payloadCharCount\(event\.partialResult\);/, "partial 没量载荷体量");
  assert.match(host, /shouldRenderPartialUpdate\(event\.toolCallId, payloadChars\)/, "增长门槛没接上");
  // 预算内的 partial 帧连事件一起丢：partialResult 是整段快照，一秒推十份 1MB 是纯浪费
  assert.match(host, /if \(!this\.partialFrameDue\(event\.toolCallId\)\) return null;/, "预算内没丢帧");
  assert.match(host, /const rendered = this\.withRenderedToolLines\(eventToEmit\);\s*\n\s*if \(rendered\) this\.emit\(rendered\);/, "丢帧后仍照发");
  // 原始输出走增量：不重渲的那些帧也要推进游标（推出去的每帧都是「前缀 + 新增」）
  assert.match(host, /const textFrame = this\.framePartialResult\(event\.toolCallId, event\.partialResult\);/, "原始输出没走增量");
  assert.match(host, /return withPartialTextFrame\(event, textFrame\);/, "不重渲的帧没带上增量");
  assert.match(host, /const framed = framePartialText\(entry\.partialTextCursor, partialResultToText\(partialResult\)\);/, "没接 framePartialText");
  assert.match(host, /const \{ partialResult: _replacedByDelta, \.\.\.rest \} = event/, "增量帧没把 partialResult 摘掉");
  assert.match(host, /payloadChars - entry\.lastPartialPayloadChars < partialGrowthThreshold\(payloadChars\)/, "增长门槛没用阈值函数");
  assert.match(host, /entry\.lastPartialPayloadChars = payloadChars;/, "没记下这次渲染的体量（下次就永远能渲）");
  // 结果槽：三处出口都要走 renderedLinesFrame
  const frames = host.match(/renderedLinesFrame\(/g) ?? [];
  assert.ok(frames.length >= 3, `结果槽增量帧只接了 ${frames.length} 处（partial / rendered_lines_update / end 三处都要）`);
  assert.match(host, /renderedLinesAppendFrom: patch\.appendFrom/, "partial 帧没带追加起点");
  assert.match(host, /renderedResultLinesAppendFrom: patch\.appendFrom/, "结果帧没带追加起点");
  assert.match(host, /renderOversize: true/, "超限没有如实标记，前端无从提示");
});

test("增长门槛：小输出按 1KB 一档（打字机照旧），大输出按 10% 变粗", () => {
  assert.equal(PARTIAL_GROWTH_FLOOR_CHARS, 1024);
  assert.equal(PARTIAL_GROWTH_RATIO, 0.1);
  assert.equal(partialGrowthThreshold(0), 1024);
  assert.equal(partialGrowthThreshold(4_000), 1024, "小输出用下限");
  assert.equal(partialGrowthThreshold(16_000), 1600, "1.6 万字符时约每 1.6KB 一帧");
  assert.equal(partialGrowthThreshold(100_000), 10_000);
  assert.equal(partialGrowthThreshold(550_000), 55_000, "事故那种体量：长 5.5 万字符才渲一帧");
  for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    assert.equal(partialGrowthThreshold(bad), 1024, `非法长度 ${String(bad)} 用下限`);
  }
});

test("增量帧：只在尾部追加时只推新增行，前面被改到就整份替换", () => {
  const base = ["a", "b", "c"];
  assert.deepEqual(renderedLinesFrame(base, ["a", "b", "c", "d", "e"]), { lines: ["d", "e"], appendFrom: 3 });
  // 没推过 → 全量
  assert.deepEqual(renderedLinesFrame(undefined, base), { lines: ["a", "b", "c"] });
  // 长度没长 → 全量（内容被改动了）
  assert.deepEqual(renderedLinesFrame(base, ["a", "B", "c"]), { lines: ["a", "B", "c"] });
  // 中间变了 → 全量（前缀对不上）
  assert.deepEqual(renderedLinesFrame(base, ["a", "B", "c", "d"]), { lines: ["a", "B", "c", "d"] });
  // 变短（插件收敛/截断）→ 全量
  assert.deepEqual(renderedLinesFrame(base, ["a", "b"]), { lines: ["a", "b"] });
  // 空数组也是合法全量
  assert.deepEqual(renderedLinesFrame(base, []), { lines: [] });
});

test("两端对齐：宿主发的增量帧喂给客户端缓冲，实时输出必须和整份快照一模一样", async () => {
  const { applyToolExecutionStart, applyToolExecutionUpdate } = await jiti.import("./tool-execution-buffer.ts");
  const { partialResultToText } = await jiti.import("./tool-partial-text.ts");
  const EMPTY = new Map();
  // advisor / bash 的真实载荷形状：结构化 content 块
  const snapshots = [
    "第一段\n",
    "第一段\n第二段\n",
    "第一段\n第二段\n第三段，稍微长一点\n",
    "第一段\n第二段\n第三段，稍微长一点\n收尾\n",
  ].map((text) => ({ content: [{ type: "text", text }] }));
  let cursor = null;
  let state = applyToolExecutionStart(EMPTY, { toolCallId: "t1", toolName: "ask_advisor", args: {} });
  let deltas = 0;
  for (const snapshot of snapshots) {
    const framed = framePartialText(cursor, partialResultToText(snapshot));
    cursor = framed.cursor;
    state = framed.delta
      ? applyToolExecutionUpdate(state, { toolCallId: "t1", partialResultDelta: framed.delta })
      : applyToolExecutionUpdate(state, { toolCallId: "t1", partialResult: snapshot });
    if (framed.delta) deltas += 1;
  }
  assert.equal(deltas, snapshots.length - 1, "后续几帧都该走增量");
  assert.equal(state.get("t1").output, partialResultToText(snapshots[snapshots.length - 1]));
  assert.equal(state.get("t1").truncated, undefined);
  assert.equal(state.get("t1").outputChars, state.get("t1").output.length);
});

test("原始输出增量帧：只在尾部追加时发新增那段，重写就退回整份", () => {
  // 第一帧没有游标 → 整份
  const first = framePartialText(null, "hello");
  assert.equal(first.delta, undefined);
  assert.deepEqual(first.cursor, { sentChars: 5, tail: "hello" });

  // 追加 → 只发新增
  const second = framePartialText(first.cursor, "hello world");
  assert.deepEqual(second.delta, { from: 5, text: " world" });
  assert.equal(second.cursor.sentChars, 11);

  // 没长（节流帧之间内容没变）→ 整份（调用方照样能安全替换）
  assert.equal(framePartialText(second.cursor, "hello world").delta, undefined);

  // 变短 / 前面被改（进度条那类）→ 整份
  assert.equal(framePartialText(second.cursor, "hello").delta, undefined);
  assert.equal(framePartialText(second.cursor, "HELLO WORLD!").delta, undefined);

  // 超过 4KB 后仍按尾巴校验：整份重写但尾巴恰好相同的情况极少，且退化为整份也无害
  const long = "x".repeat(5000) + "tail-A";
  const longCursor = framePartialText(null, long).cursor;
  assert.equal(longCursor.tail.length, 4096);
  assert.deepEqual(framePartialText(longCursor, long + "more").delta, { from: long.length, text: "more" });
  assert.equal(framePartialText(longCursor, "y".repeat(long.length + 4)).delta, undefined, "尾巴变了就整份");
});
