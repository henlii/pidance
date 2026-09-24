import assert from "node:assert/strict";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
async function loadSubject() {
  return jiti.import("./message-display.ts");
}

function assistant(content) {
  return {
    role: "assistant",
    provider: "test",
    model: "test-model",
    content,
  };
}




test("drops empty thinking blocks after completion", async () => {
  const { getDisplayableAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Final answer" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["text"],
    "完成后空 thinking 块不再显示（正文照常显示）",
  );
});

test("keeps thinking stored in text/reasoning fields after completion", async () => {
  const { getDisplayableAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "", text: "另一字段里的思考" },
    { type: "text", text: "Final answer" },
  ]);
  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["thinking", "text"],
  );
});

test("keeps empty thinking while streaming", async () => {
  const { getDisplayableAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Partial answer" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: true }).map((block) => block.type),
    ["thinking", "text"],
    "流式期间空 thinking 块保留（正文还在长，位置不能跳）",
  );
});

test("keeps deferred historical thinking placeholders", async () => {
  const { getDisplayableAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "", deferred: true },
    { type: "text", text: "Final answer" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["thinking", "text"],
  );
});

test("isActiveStreamBlock：仅流式最后一块为活跃输出", async () => {
  const { isActiveStreamBlock } = await loadSubject();
  assert.equal(isActiveStreamBlock(true, 0, 1), true);
  assert.equal(isActiveStreamBlock(true, 0, 2), false);
  assert.equal(isActiveStreamBlock(true, 1, 2), true);
  assert.equal(isActiveStreamBlock(false, 0, 1), false);
  assert.equal(isActiveStreamBlock(undefined, 0, 1), false);
});

test("isAssistantTruncated：只有 stopReason=length 算截断", async () => {
  const { isAssistantTruncated } = await loadSubject();
  assert.equal(isAssistantTruncated({ stopReason: "length" }), true);
  assert.equal(isAssistantTruncated({ stopReason: "end_turn" }), false);
  assert.equal(isAssistantTruncated({ stopReason: "aborted" }), false);
  assert.equal(isAssistantTruncated({ stopReason: "error" }), false);
  assert.equal(isAssistantTruncated({}), false);
});

test("collapsedSummaryLine：流式中取末行、结束后取首行，空白行不参与", async () => {
  const { collapsedSummaryLine } = await loadSubject();

  const text = "第一行\n\n第二行\n最后一行";
  assert.equal(collapsedSummaryLine(text, { streaming: true }), "最后一行");
  assert.equal(collapsedSummaryLine(text, { streaming: false }), "第一行");
  assert.equal(collapsedSummaryLine(text), "第一行", "默认按结束态取首行");

  // 空白行 / 前后空格不参与取值
  assert.equal(collapsedSummaryLine("\n\n  首行  \n末行\n  "), "首行");
  assert.equal(collapsedSummaryLine("\n\n  首行  \n末行\n  ", { streaming: true }), "末行");

  // 空内容返回空串，调用方自行决定回退文案
  assert.equal(collapsedSummaryLine(""), "");
  assert.equal(collapsedSummaryLine("   \n  "), "");
  assert.equal(collapsedSummaryLine(null), "");
  assert.equal(collapsedSummaryLine(undefined, { streaming: true }), "");
});

test("shouldRenderLiveToolOutput：运行中才用实时段，结束后交给配对结果段（缺结果时保留）", async () => {
  const { shouldRenderLiveToolOutput } = await loadSubject();

  // 运行中：有快照就渲染实时输出
  assert.equal(shouldRenderLiveToolOutput({ hasSnapshot: true, isRunning: true, hasResult: false }), true);
  assert.equal(shouldRenderLiveToolOutput({ hasSnapshot: true, isRunning: true, hasResult: true }), true);
  // 已结束 + 有配对结果：实时段必须让位，否则同一份输出渲染两遍
  assert.equal(shouldRenderLiveToolOutput({ hasSnapshot: true, isRunning: false, hasResult: true }), false);
  // 已结束但结果事件迟到/缺失：保留实时段，宁可显示一次也不丢内容
  assert.equal(shouldRenderLiveToolOutput({ hasSnapshot: true, isRunning: false, hasResult: false }), true);
  // 没有快照：不渲染（刷新后的历史工具卡只有磁盘结果）
  assert.equal(shouldRenderLiveToolOutput({ hasSnapshot: false, isRunning: false, hasResult: true }), false);
  assert.equal(shouldRenderLiveToolOutput({ hasSnapshot: false, isRunning: true, hasResult: false }), false);
});
