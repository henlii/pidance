/**
 * 连接首帧快照缓存：回放内容、顺序与去重判定。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createStreamSnapshotCache, isEventIncludedInSnapshot } = await jiti.import("./stream-snapshot.ts");

test("空缓存：不流式、无回放", () => {
  const cache = createStreamSnapshotCache();
  assert.deepEqual(cache.snapshot(), { isStreaming: false, events: [] });
});

test("流式消息：缓存最新一条 assistant 事件，user 角色不入快照", () => {
  const cache = createStreamSnapshotCache();
  const first = { type: "message_start", message: { id: "m1", role: "assistant" } };
  const latest = { type: "message_update", message: { id: "m1", role: "assistant" }, streamRunSeq: 3 };
  cache.remember(first);
  cache.remember({ type: "message_update", message: { role: "user" } });
  cache.remember(latest);
  const snapshot = cache.snapshot();
  assert.equal(snapshot.isStreaming, true);
  assert.deepEqual(snapshot.events, [latest], "只回放最新一条，且保留 streamRunSeq");
});

test("agent_start 与 agent_end 清空流式快照（重连页面不把上一轮当在生成）", () => {
  const cache = createStreamSnapshotCache();
  cache.remember({ type: "message_update", message: { role: "assistant" } });
  cache.remember({ type: "agent_end" });
  assert.equal(cache.snapshot().isStreaming, false);
  assert.deepEqual(cache.snapshot().events, []);

  cache.remember({ type: "message_update", message: { role: "assistant" } });
  cache.remember({ type: "agent_start" });
  assert.deepEqual(cache.snapshot().events, []);
});

test("活跃工具：start → 最新 update 的顺序回放；被节流那帧带上最近一次渲染行；end 后移除", () => {
  const cache = createStreamSnapshotCache();
  const start = { type: "tool_execution_start", toolCallId: "t1", toolName: "bash" };
  const update1 = { type: "tool_execution_update", toolCallId: "t1", partialResult: "a" };
  const update2 = { type: "tool_execution_update", toolCallId: "t1", partialResult: "ab" };
  cache.remember(start);
  cache.remember(update1);
  cache.remember(update2);
  assert.deepEqual(cache.snapshot().events, [start, update2], "同一工具只留最新 update（replace 语义）");
  assert.equal(cache.snapshot().isStreaming, true, "只有工具在跑也算持有流式状态");

  cache.remember({ type: "tool_execution_end", toolCallId: "t1" });
  assert.deepEqual(cache.snapshot(), { isStreaming: false, events: [] });
});

test("节流帧（无 renderedLines）回放时带上最近一次渲染行，重连页面不降级成原始文本", () => {
  const cache = createStreamSnapshotCache();
  const start = { type: "tool_execution_start", toolCallId: "t1", toolName: "bash" };
  const rendered = { type: "tool_execution_update", toolCallId: "t1", partialResult: "a", renderedLines: ["\u001b[32ma\u001b[0m"] };
  const throttled = { type: "tool_execution_update", toolCallId: "t1", partialResult: "ab" };
  cache.remember(start);
  cache.remember(rendered);
  cache.remember(throttled);
  const events = cache.snapshot().events;
  assert.equal(events.length, 2, "回放仍是 start + 一帧 update");
  assert.equal(events[1].partialResult, "ab", "内容取最新一帧");
  assert.deepEqual(events[1].renderedLines, ["\u001b[32ma\u001b[0m"], "补上最近一次渲染行");
});

test("最新一帧自带渲染行时原样回放（不覆盖成旧的）", () => {
  const cache = createStreamSnapshotCache();
  cache.remember({ type: "tool_execution_start", toolCallId: "t1" });
  cache.remember({ type: "tool_execution_update", toolCallId: "t1", partialResult: "a", renderedLines: ["old"] });
  cache.remember({ type: "tool_execution_update", toolCallId: "t1", partialResult: "ab", renderedLines: ["new"] });
  assert.deepEqual(cache.snapshot().events[1].renderedLines, ["new"]);
});

test("未见 start 的 update 不回放（浏览器工具缓冲会忽略它，回放也没意义）", () => {
  const cache = createStreamSnapshotCache();
  cache.remember({ type: "tool_execution_update", toolCallId: "t9", partialResult: "x" });
  assert.deepEqual(cache.snapshot(), { isStreaming: false, events: [] });
});

test("缺 toolCallId 的工具事件与未知类型都不缓存", () => {
  const cache = createStreamSnapshotCache();
  cache.remember({ type: "tool_execution_start", toolName: "bash" });
  cache.remember({ type: "queue_update", steering: [], followUp: [] });
  cache.remember({ type: "connected", isStreaming: true });
  assert.deepEqual(cache.snapshot(), { isStreaming: false, events: [] });
});

test("reset 清空全部缓存", () => {
  const cache = createStreamSnapshotCache();
  cache.remember({ type: "message_update", message: { id: "m1", role: "assistant" } });
  cache.remember({ type: "tool_execution_start", toolCallId: "t1" });
  cache.reset();
  assert.deepEqual(cache.snapshot(), { isStreaming: false, events: [] });
});

test("isEventIncludedInSnapshot：start 按 id 判重；update 只认同一个对象（同 id 的新内容必须重发）", () => {
  const snapshotUpdate = { type: "message_update", message: { id: "m1", role: "assistant" } };
  const snapshot = {
    isStreaming: true,
    events: [
      snapshotUpdate,
      { type: "tool_execution_start", toolCallId: "t1" },
      { type: "tool_execution_update", toolCallId: "t1", partialResult: "a" },
    ],
  };
  // 同一条消息的 start 已被快照里的 update 取代：可以丢。
  assert.equal(isEventIncludedInSnapshot({ type: "message_start", message: { id: "m1" } }, snapshot), true);
  assert.equal(isEventIncludedInSnapshot({ type: "message_start", message: { id: "m2" } }, snapshot), false);
  // 同 id 但不同对象的 update：内容可能更新，宁可重发（整条替换，重复无害）。
  assert.equal(isEventIncludedInSnapshot({ type: "message_update", message: { id: "m1" } }, snapshot), false);
  assert.equal(isEventIncludedInSnapshot(snapshotUpdate, snapshot), true, "同一个对象才算重复");
  assert.equal(isEventIncludedInSnapshot({ type: "message_update", message: { id: "m2" } }, snapshot), false);
  assert.equal(isEventIncludedInSnapshot({ type: "message_start", message: { role: "assistant" } }, snapshot), false);
  assert.equal(isEventIncludedInSnapshot({ type: "tool_execution_update", toolCallId: "t1" }, snapshot), true);
  assert.equal(isEventIncludedInSnapshot({ type: "tool_execution_update", toolCallId: "t2" }, snapshot), false);
  assert.equal(isEventIncludedInSnapshot({ type: "tool_execution_start", toolCallId: "t1" }, snapshot), true);
  assert.equal(isEventIncludedInSnapshot({ type: "agent_end" }, snapshot), false);
});

test("插件重渲（rendered_lines_update）进快照：调用槽覆盖 start 自带的行，结果槽另发一帧", () => {
  const cache = createStreamSnapshotCache();
  const start = { type: "tool_execution_start", toolCallId: "t1", toolName: "edit", renderedCallLines: ["edit a.ts"] };
  cache.remember(start);
  cache.remember({
    type: "rendered_lines_update",
    toolCallId: "t1",
    renderedCallLines: ["edit a.ts", "-old", "+new"],
    renderedResultLines: ["done"],
  });
  const events = cache.snapshot().events;
  assert.equal(events.length, 2, "start（带最新调用槽）+ 一帧结果槽重渲");
  assert.deepEqual(events[0].renderedCallLines, ["edit a.ts", "-old", "+new"], "调用槽要用重渲后的行，而不是 start 自带那份");
  assert.equal(events[0].toolCallId, "t1");
  assert.deepEqual(
    events[1],
    { type: "rendered_lines_update", toolCallId: "t1", renderedResultLines: ["done"] },
    "结果槽用同一形事件回放（浏览器两端共用同一套解释）",
  );
});

test("rendered_lines_update 在 start 之前或工具已结束时不缓存；非法行不污染快照", () => {
  const cache = createStreamSnapshotCache();
  cache.remember({ type: "rendered_lines_update", toolCallId: "t9", renderedCallLines: ["x"] });
  assert.deepEqual(cache.snapshot(), { isStreaming: false, events: [] }, "未见 start 不回放");

  const start = { type: "tool_execution_start", toolCallId: "t1" };
  cache.remember(start);
  cache.remember({ type: "rendered_lines_update", toolCallId: "t1", renderedCallLines: [] });
  cache.remember({ type: "rendered_lines_update", toolCallId: "t1", renderedCallLines: [1, 2] });
  cache.remember({ type: "rendered_lines_update", toolCallId: "t1" });
  assert.deepEqual(cache.snapshot().events, [start], "空数组 / 非字符串 / 缺字段一律不采纳");

  cache.remember({ type: "tool_execution_end", toolCallId: "t1" });
  cache.remember({ type: "rendered_lines_update", toolCallId: "t1", renderedCallLines: ["late"] });
  assert.deepEqual(cache.snapshot(), { isStreaming: false, events: [] }, "结束后不再回放（终态归消息历史）");
});

test("isEventIncludedInSnapshot：同 toolCallId 的 rendered_lines_update 已在快照里就不重发", () => {
  const snapshot = {
    isStreaming: true,
    events: [
      { type: "rendered_lines_update", toolCallId: "t1", renderedResultLines: ["new"] },
    ],
  };
  // 这是整体替换语义：缓冲里那份可能比快照还旧，重放会把新行盖回旧行 —— 按 id 丢弃。
  assert.equal(isEventIncludedInSnapshot({ type: "rendered_lines_update", toolCallId: "t1", renderedCallLines: ["old"] }, snapshot), true);
  assert.equal(isEventIncludedInSnapshot({ type: "rendered_lines_update", toolCallId: "t2" }, snapshot), false);
  assert.equal(isEventIncludedInSnapshot({ type: "rendered_lines_update" }, snapshot), false, "缺 toolCallId 不判重（交给上层收窄）");
});
