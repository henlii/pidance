import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

const { projectAgentEvent } = await jiti.import("./agent-event-stream.ts");

test("tool_execution_update 原样透传（含 toolCallId/toolName/args/partialResult）", () => {
	const event = {
		type: "tool_execution_update",
		toolCallId: "t1",
		toolName: "bash",
		args: { cmd: "ls" },
		partialResult: "out",
	};
	// 返回原对象引用，保证内容零改动
	assert.equal(projectAgentEvent(event), event);
});

test("turn_start / turn_end 丢弃", () => {
	assert.equal(projectAgentEvent({ type: "turn_start", timestamp: 1 }), null);
	assert.equal(projectAgentEvent({ type: "turn_end", timestamp: 2 }), null);
});

test("message_update 瘦身：删除 assistantMessageEvent 且不改原对象", () => {
	const event = {
		type: "message_update",
		messageId: "m1",
		assistantMessageEvent: { content: "big", tokens: 100 },
		extra: "keep",
	};
	const result = projectAgentEvent(event);
	assert.deepEqual(result, {
		type: "message_update",
		messageId: "m1",
		extra: "keep",
	});
	assert.ok(!("assistantMessageEvent" in result), "结果不再含 assistantMessageEvent");
	// 原对象不被修改
	assert.ok("assistantMessageEvent" in event, "原对象仍保留 assistantMessageEvent");
	assert.equal(event.assistantMessageEvent.tokens, 100);
});

test("message_update 只剥离 reasoning_content 洪水通道，其它思考原样下发", () => {
  const flood = {
    type: "message_update",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "完整思考内容", thinkingSignature: "reasoning_content" },
        { type: "text", text: "回答" },
      ],
    },
  };
  const floodResult = projectAgentEvent(flood);
  assert.equal(floodResult.message.content[0].thinking, "");
  assert.equal(floodResult.message.content[0].thinkingSignature, "reasoning_content");
  assert.equal(flood.message.content[0].thinking, "完整思考内容");

  const anthropic = {
    type: "message_update",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "正常思考", thinkingSignature: "{\"encrypted_content\":\"x\"}" },
      ],
    },
  };
  const kept = projectAgentEvent(anthropic);
  assert.equal(kept.message.content[0].thinking, "正常思考");
  assert.equal(kept.message.content[0], anthropic.message.content[0]);
});

test("message_update 空 thinking 不产生新对象（引用不变）", () => {
	const block = { type: "thinking", thinking: "" };
	const event = { type: "message_update", message: { role: "assistant", content: [block] } };
	const result = projectAgentEvent(event);
	assert.equal(result.message, event.message, "message 引用不变");
	assert.equal(result.message.content[0], block, "block 引用不变");
});

test("agent_end 瘦身为 { type: 'agent_end' }", () => {
	assert.deepEqual(
		projectAgentEvent({ type: "agent_end", reason: "done", stats: { tokens: 1 } }),
		{ type: "agent_end" },
	);
});

test("普通事件原样保留", () => {
	const event = { type: "agent_message", id: "x", content: "hi" };
	assert.equal(projectAgentEvent(event), event);
});

test("无合法 type 返回 null", () => {
	assert.equal(projectAgentEvent(null), null);
	assert.equal(projectAgentEvent("str"), null);
	assert.equal(projectAgentEvent(42), null);
	assert.equal(projectAgentEvent({}), null);
	assert.equal(projectAgentEvent({ type: "" }), null);
	assert.equal(projectAgentEvent({ type: 42 }), null);
});
