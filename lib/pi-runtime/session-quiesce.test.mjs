import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { quiesceRpcProcess } = await jiti.import("./session-quiesce.ts");

test("目标已死：no-op", async () => {
	let abortCalls = 0;
	await quiesceRpcProcess({
		isAlive: () => false,
		abort: async () => {
			abortCalls++;
		},
		stop: async () => {
			abortCalls++;
		},
	});
	assert.equal(abortCalls, 0);
});

test("存活目标：abort → sleep → stop", async () => {
	const order = [];
	await quiesceRpcProcess(
		{
			isAlive: () => true,
			abort: async () => {
				order.push("abort");
			},
			stop: async () => {
				order.push("stop");
			},
		},
		{
			settleMs: 1,
			sleep: async () => {
				order.push("sleep");
			},
		},
	);
	assert.deepEqual(order, ["abort", "sleep", "stop"]);
});

test("abort 失败仍 stop", async () => {
	const order = [];
	await quiesceRpcProcess(
		{
			isAlive: () => true,
			abort: async () => {
				order.push("abort");
				throw new Error("abort failed");
			},
			stop: async () => {
				order.push("stop");
			},
		},
		{ settleMs: 0, sleep: async () => undefined },
	);
	assert.deepEqual(order, ["abort", "stop"]);
});
