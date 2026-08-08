import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { projectRpcAgentState } = await jiti.import("./project-rpc-state.ts");

const baseInput = {
	rpc: {
		sessionId: "sid-1",
		sessionFile: "/tmp/s.jsonl",
		isStreaming: false,
		isCompacting: false,
		thinkingLevel: "low",
		autoCompactionEnabled: true,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		messageCount: 3,
		pendingMessageCount: 1,
		model: { id: "m1", provider: "p1" },
		// legacy 噪声：不得透传为权威
		systemPrompt: "SHOULD_NOT_APPEAR",
		queuedMessages: { steering: ["x"], followUp: [] },
		contextUsage: { percent: 0, contextWindow: 1, tokens: 0 },
		autoRetryEnabled: true,
	},
	fallbackSessionId: "fallback",
	fallbackSessionFile: "/tmp/fallback.jsonl",
	isPromptRunning: true,
	isBashRunning: false,
	extensionStatuses: [{ key: "k", text: "t" }],
	extensionWidgets: [],
	pendingExtensionRequests: [],
};

test("投影只输出 RPC 白名单 + 本地覆盖，不含 systemPrompt", () => {
	const state = projectRpcAgentState(baseInput);
	assert.equal(state.sessionId, "sid-1");
	assert.equal(state.thinkingLevel, "low");
	assert.equal(state.isPromptRunning, true);
	assert.equal(state.messageCount, 3);
	assert.deepEqual(state.model, { id: "m1", provider: "p1" });
	assert.equal("systemPrompt" in state, false);
	assert.equal("autoRetryEnabled" in state, false);
	// 无 localQueue / sessionStats → 不附带这些字段
	assert.equal("queuedMessages" in state, false);
	assert.equal("contextUsage" in state, false);
	assert.equal(state.stateSources.rpcGetState, true);
	assert.equal(state.stateSources.localQueue, false);
	assert.equal(state.stateSources.sessionStats, false);
});

test("localQueue 与 sessionStats.contextUsage 仅在提供时附带", () => {
	const state = projectRpcAgentState({
		...baseInput,
		localQueue: { steering: ["a"], followUp: ["b"] },
		sessionStats: {
			contextUsage: { percent: 12.5, contextWindow: 1000, tokens: 125 },
		},
	});
	assert.deepEqual(state.queuedMessages, { steering: ["a"], followUp: ["b"] });
	assert.deepEqual(state.contextUsage, {
		percent: 12.5,
		contextWindow: 1000,
		tokens: 125,
	});
	assert.equal(state.stateSources.localQueue, true);
	assert.equal(state.stateSources.sessionStats, true);
});

test("contextUsage 窗口非法时省略（不伪造 0%）", () => {
	const state = projectRpcAgentState({
		...baseInput,
		sessionStats: { contextUsage: { percent: null, contextWindow: 0, tokens: null } },
	});
	assert.equal("contextUsage" in state, false);
});

test("缺 model 字段时 model 为 undefined", () => {
	const state = projectRpcAgentState({
		...baseInput,
		rpc: { ...baseInput.rpc, model: { id: "only-id" } },
	});
	assert.equal(state.model, undefined);
});
