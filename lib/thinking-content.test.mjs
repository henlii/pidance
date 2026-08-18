import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getThinkingText,
  isThinkingLikeType,
  projectDisplayBlocks,
  splitTextByThinkTags,
  toThinkingBlock,
} = await jiti.import("./thinking-content.ts");

test("getThinkingText：thinking / text / reasoning 都认", () => {
  assert.equal(getThinkingText({ thinking: "甲" }), "甲");
  assert.equal(getThinkingText({ text: "乙" }), "乙");
  assert.equal(getThinkingText({ reasoning: "丙" }), "丙");
  assert.equal(getThinkingText({ thinking: "", text: "乙" }), "乙");
  assert.equal(getThinkingText({ thinking: "甲", text: "乙" }), "甲");
  assert.equal(getThinkingText({}), "");
});

test("isThinkingLikeType / toThinkingBlock：reasoning 也收成 thinking", () => {
  assert.equal(isThinkingLikeType("thinking"), true);
  assert.equal(isThinkingLikeType("reasoning"), true);
  assert.equal(isThinkingLikeType("redacted_thinking"), true);
  assert.equal(isThinkingLikeType("text"), false);
  const block = toThinkingBlock({ type: "reasoning", reasoning: "推演" });
  assert.equal(block.type, "thinking");
  assert.equal(block.thinking, "推演");
});

test("splitTextByThinkTags：闭合与流式未闭合", () => {
  assert.deepEqual(splitTextByThinkTags("<think>先想</think>回答"), [
    { type: "thinking", value: "先想" },
    { type: "text", value: "回答" },
  ]);
  assert.deepEqual(splitTextByThinkTags("前言<thinking>中段</thinking>后记"), [
    { type: "text", value: "前言" },
    { type: "thinking", value: "中段" },
    { type: "text", value: "后记" },
  ]);
  assert.deepEqual(splitTextByThinkTags("<think>还在想"), [
    { type: "thinking", value: "还在想" },
  ]);
  assert.deepEqual(splitTextByThinkTags("只有正文"), [
    { type: "text", value: "只有正文" },
  ]);
});

test("projectDisplayBlocks：思考进思考块，正文不含 think 标签", () => {
  const items = projectDisplayBlocks([
    { type: "reasoning", text: "隐式思考" },
    { type: "text", text: "<think>标签思考</think>可见回答" },
    { type: "toolCall", toolCallId: "t1" },
  ]);
  assert.deepEqual(items.map((item) => item.block.type), ["thinking", "thinking", "text", "toolCall"]);
  assert.equal(items[0].block.thinking, "隐式思考");
  assert.equal(items[1].block.thinking, "标签思考");
  assert.equal(items[2].block.text, "可见回答");
  assert.equal(items[0].sourceIndex, 0);
  assert.equal(items[1].sourceIndex, 1);
  assert.equal(items[2].sourceIndex, 1);
});
