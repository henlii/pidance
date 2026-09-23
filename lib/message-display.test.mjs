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
