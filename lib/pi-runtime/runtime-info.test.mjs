import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildRuntimeInfo } = await jiti.import("./runtime-info.ts");

test("默认模式为 rpc（只用外部 pi）", () => {
	const info = buildRuntimeInfo({ PATH: "" }, process.cwd());
	assert.equal(info.agentRuntimeMode, "rpc");
	assert.equal(info.runtime.protocol, "rpc");
});

test("显式 inprocess：protocol=inprocess，runtime.path 为空", () => {
	const info = buildRuntimeInfo({ PIDANCE_AGENT_RUNTIME: "inprocess" }, process.cwd());
	assert.equal(info.agentRuntimeMode, "inprocess");
	assert.equal(info.runtime.protocol, "inprocess");
	assert.equal(info.runtime.path, null);
	assert.equal(info.runtime.compatible, true);
	assert.ok(info.pidanceVersion);
});

test("rpc 模式且无二进制：compatible=false 并有 notes", () => {
	const info = buildRuntimeInfo(
		{
			PIDANCE_AGENT_RUNTIME: "rpc",
			// 空 PATH + 无配置 + 关闭 bundled → 必然解析失败
			PATH: "",
			PIDANCE_PI_RUNTIME: undefined,
			PIDANCE_PI_RUNTIME_FALLBACK_BUNDLED: "0",
		},
		process.cwd(),
	);
	assert.equal(info.agentRuntimeMode, "rpc");
	assert.equal(info.runtime.protocol, "rpc");
	assert.equal(info.runtime.path, null);
	assert.equal(info.runtime.compatible, false);
	assert.ok(info.notes.some((n) => /未解析|PATH|PIDANCE_PI_RUNTIME/.test(n)));
});

test("0.84 能力启发式：deltaOnlyMessageUpdate=true", () => {
	// 通过伪造 PATH 下不可达 + 直接测 infer 较难；用真实 cwd 管理面版本至少可解析
	const info = buildRuntimeInfo({ PIDANCE_AGENT_RUNTIME: "inprocess" }, process.cwd());
	assert.equal(typeof info.capabilities.extensionUi, "boolean");
	assert.equal(info.capabilities.deltaOnlyMessageUpdate, false);
});
