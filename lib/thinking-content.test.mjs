import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getThinkingText,
  isFloodStreamingThinking,
  stripFloodStreamingThinking,
} = await jiti.import("./thinking-content.ts");

test("getThinkingText：thinking / text / reasoning 都认", () => {
  assert.equal(getThinkingText({ thinking: "甲" }), "甲");
  assert.equal(getThinkingText({ text: "乙" }), "乙");
  assert.equal(getThinkingText({ reasoning: "丙" }), "丙");
  assert.equal(getThinkingText({ thinking: "", text: "乙" }), "乙");
  assert.equal(getThinkingText({ thinking: "甲", text: "乙" }), "甲");
  assert.equal(getThinkingText({}), "");
});

test("isFloodStreamingThinking：只认 reasoning_content 签名", () => {
  assert.equal(
    isFloodStreamingThinking({ type: "thinking", thinking: "x", thinkingSignature: "reasoning_content" }),
    true,
  );
  assert.equal(
    isFloodStreamingThinking({
      type: "thinking",
      thinking: "x",
      thinkingSignature: JSON.stringify({ encrypted_content: "abc" }),
    }),
    false,
  );
  assert.equal(
    isFloodStreamingThinking({
      type: "thinking",
      thinking: "x",
      thinkingSignature: JSON.stringify({ id: "rs_1", type: "reasoning" }),
    }),
    false,
  );
  assert.equal(isFloodStreamingThinking({ type: "text", text: "x" }), false);
});

test("stripFloodStreamingThinking：只清空洪水通道正文", () => {
  const flood = { type: "thinking", thinking: "刷屏", thinkingSignature: "reasoning_content" };
  const stripped = stripFloodStreamingThinking(flood);
  assert.equal(stripped.thinking, "");
  assert.equal(stripped.thinkingSignature, "reasoning_content");
  assert.equal(flood.thinking, "刷屏");

  const anthropic = {
    type: "thinking",
    thinking: "正常思考",
    thinkingSignature: "{\"encrypted_content\":\"x\"}",
  };
  assert.equal(stripFloodStreamingThinking(anthropic), anthropic);
});
