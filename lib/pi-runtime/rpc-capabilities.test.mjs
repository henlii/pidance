import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	PI_RPC_COMMANDS_0_83,
	UNSUPPORTED_RPC_COMMANDS,
	PI_RPC_GET_STATE_FIELDS,
	LEGACY_FAKE_STATE_FIELDS,
	isPiRpcCommand,
	isUnsupportedRpcCommand,
	unsupportedCommand,
	isUnsupportedResult,
} = await jiti.import("./rpc-capabilities.ts");

test("0.83 公开命令含 get_state / prompt / get_session_stats，不含 clear_queue", () => {
	assert.ok(PI_RPC_COMMANDS_0_83.includes("get_state"));
	assert.ok(PI_RPC_COMMANDS_0_83.includes("prompt"));
	assert.ok(PI_RPC_COMMANDS_0_83.includes("get_session_stats"));
	assert.ok(PI_RPC_COMMANDS_0_83.includes("extension_ui_response") === false);
	assert.equal(isPiRpcCommand("clear_queue"), false);
	assert.equal(isPiRpcCommand("get_tools"), false);
	assert.equal(isPiRpcCommand("abort_compaction"), false);
});

test("unsupported 命令矩阵固定且结果形状正确", () => {
	for (const name of ["clear_queue", "abort_compaction", "extension_ui_input", "flush_queue_as_steer"]) {
		assert.ok(UNSUPPORTED_RPC_COMMANDS.includes(name), name);
		assert.equal(isUnsupportedRpcCommand(name), true);
	}
	const r = unsupportedCommand("clear_queue");
	assert.equal(r.unsupported, true);
	assert.equal(r.command, "clear_queue");
	assert.ok(typeof r.reason === "string" && r.reason.length > 0);
	assert.equal(isUnsupportedResult(r), true);
	assert.equal(isUnsupportedResult({ steering: [] }), false);
});

test("legacy 伪造状态字段不得出现在 get_state 白名单", () => {
	for (const f of LEGACY_FAKE_STATE_FIELDS) {
		assert.equal(PI_RPC_GET_STATE_FIELDS.includes(f), false, f);
	}
	assert.ok(PI_RPC_GET_STATE_FIELDS.includes("sessionId"));
	assert.ok(PI_RPC_GET_STATE_FIELDS.includes("messageCount"));
});
