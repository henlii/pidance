import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { MessageAssembler } = await jiti.import("./message-assembler.ts");

test("0.84 delta-only：text_start/delta/end 组装累计 message", () => {
	const a = new MessageAssembler();
	const start = a.process({
		type: "message_start",
		message: { role: "assistant", content: [] },
	});
	assert.equal(start.message.role, "assistant");

	const u1 = a.process({
		type: "message_update",
		assistantMessageEvent: { type: "text_start", contentIndex: 0 },
	});
	assert.equal(u1.message.content[0].type, "text");

	const u2 = a.process({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" },
	});
	assert.equal(u2.message.content[0].text, "Hello");

	const u3 = a.process({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " world" },
	});
	assert.equal(u3.message.content[0].text, "Hello world");

	const end = a.process({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Hello world" }],
			stopReason: "end",
		},
	});
	assert.equal(end.message.content[0].text, "Hello world");
	assert.equal(end.message.stopReason, "end");
});

test("0.81 累计 message 优先于 delta 缓冲", () => {
	const a = new MessageAssembler();
	a.process({ type: "message_start", message: { role: "assistant", content: [] } });
	const u = a.process({
		type: "message_update",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "from-message" }],
		},
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ignored" },
	});
	assert.equal(u.message.content[0].text, "from-message");
});

test("缺 message_start 时最小 buffer，end 修正", () => {
	const a = new MessageAssembler();
	const u = a.process({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
	});
	assert.equal(u.message.content[0].text, "x");
	const end = a.process({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "final" }] },
	});
	assert.equal(end.message.content[0].text, "final");
});

test("thinking_delta 组装", () => {
	const a = new MessageAssembler();
	a.process({ type: "message_start", message: { role: "assistant", content: [] } });
	a.process({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
	});
	const u = a.process({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "why" },
	});
	assert.equal(u.message.content[0].type, "thinking");
	assert.equal(u.message.content[0].thinking, "why");
});

test("非消息事件原样透传", () => {
	const a = new MessageAssembler();
	const e = { type: "tool_execution_start", toolCallId: "t1" };
	assert.equal(a.process(e), e);
});
