import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

const {
  TOOL_EXECUTION_OUTPUT_MAX_CHARS,
  applyToolExecutionStart,
  applyToolExecutionUpdate,
  applyToolExecutionEnd,
  applyToolExecutionResultRender,
  clearToolExecutions,
  getToolExecutionSnapshots,
} = await jiti.import("./tool-execution-buffer.ts");

const EMPTY = new Map();

test("start 创建 running 项（toolCallId 键控、含 command 提取）", () => {
	const state = applyToolExecutionStart(EMPTY, {
		toolCallId: "t1",
		toolName: "bash",
		args: { command: "ls -la" },
	});
	const snap = state.get("t1");
	assert.ok(snap);
	assert.equal(snap.status, "running");
	assert.equal(snap.toolName, "bash");
	assert.equal(snap.command, "ls -la");
	assert.equal(snap.output, "");
	assert.ok(typeof snap.startedAt === "number" && snap.startedAt > 0);
	assert.equal(snap.endedAt, undefined);
	assert.equal(getToolExecutionSnapshots(state).length, 1);
});

test("update 更新 output（replace 语义：整体替换而非拼接）", () => {
	const state = applyToolExecutionUpdate(
		applyToolExecutionStart(EMPTY, { toolCallId: "t1", toolName: "bash", args: {} }),
		{ toolCallId: "t1", partialResult: "第一段输出" },
	);
	assert.equal(state.get("t1").output, "第一段输出");
	// replace：第二次 update 直接覆盖，不保留上一次内容
	const state2 = applyToolExecutionUpdate(state, { toolCallId: "t1", partialResult: "第二段输出" });
	assert.equal(state2.get("t1").output, "第二段输出");
	assert.equal(state2.get("t1").status, "running");
	// 原状态未被修改（不可变）
	assert.equal(state.get("t1").output, "第一段输出");
});

test("插件 ANSI 行沿 start → update → end 流转并保留原始输出回退", () => {
	let state = applyToolExecutionStart(EMPTY, {
		toolCallId: "ansi",
		toolName: "subagent",
		args: { command: "run" },
		renderedCallLines: ["\u001b[36m调用\u001b[0m"],
	});
	state = applyToolExecutionUpdate(state, {
		toolCallId: "ansi",
		partialResult: "原始实时输出",
		renderedLines: ["\u001b[33m运行中\u001b[0m", "第二行"],
	});
	state = applyToolExecutionEnd(state, {
		toolCallId: "ansi",
		result: "原始最终结果",
		isError: false,
		renderedResultLines: ["\u001b[32m完成\u001b[0m"],
	});
	const snapshot = state.get("ansi");
	assert.deepEqual(snapshot.renderedCallLines, ["\u001b[36m调用\u001b[0m"]);
	assert.deepEqual(snapshot.renderedLines, ["\u001b[33m运行中\u001b[0m", "第二行"]);
	assert.deepEqual(snapshot.renderedResultLines, ["\u001b[32m完成\u001b[0m"]);
	assert.equal(snapshot.output, "原始实时输出");
});

test("空或畸形渲染行按缺失处理，不覆盖现有回退字段", () => {
	let state = applyToolExecutionStart(EMPTY, { toolCallId: "fallback", toolName: "bash", args: {}, renderedCallLines: [] });
	state = applyToolExecutionUpdate(state, { toolCallId: "fallback", partialResult: "output", renderedLines: [1, 2] });
	state = applyToolExecutionEnd(state, { toolCallId: "fallback", result: "result", renderedResultLines: [] });
	const snapshot = state.get("fallback");
	assert.equal(snapshot.renderedCallLines, undefined);
	assert.equal(snapshot.renderedLines, undefined);
	assert.equal(snapshot.renderedResultLines, undefined);
	assert.equal(snapshot.output, "output");
});

test("tool_result 只补最终渲染行，不提前结束 running 快照", () => {
	const started = applyToolExecutionStart(EMPTY, { toolCallId: "late", toolName: "subagent", args: {} });
	const merged = applyToolExecutionResultRender(started, {
		toolCallId: "late",
		renderedResultLines: ["\u001b[32m最终结果\u001b[0m"],
	});
	assert.equal(merged.get("late").status, "running");
	assert.deepEqual(merged.get("late").renderedResultLines, ["\u001b[32m最终结果\u001b[0m"]);
	const ended = applyToolExecutionEnd(merged, { toolCallId: "late", result: "原始结果", isError: false });
	assert.equal(ended.get("late").status, "success");
	assert.deepEqual(ended.get("late").renderedResultLines, ["\u001b[32m最终结果\u001b[0m"]);
});

test("update 非字符串 partialResult 序列化为 JSON", () => {
	const state = applyToolExecutionUpdate(
		applyToolExecutionStart(EMPTY, { toolCallId: "t1", toolName: "read_file", args: {} }),
		{ toolCallId: "t1", partialResult: { path: "/tmp/a.ts", lines: [1, 2] } },
	);
	assert.equal(state.get("t1").output, JSON.stringify({ path: "/tmp/a.ts", lines: [1, 2] }));
});

test("update bash partialResult 提取 content[].text 并保留真实换行", () => {
	const state = applyToolExecutionUpdate(
		applyToolExecutionStart(EMPTY, { toolCallId: "bash1", toolName: "bash", args: { command: "ls" } }),
		{
			toolCallId: "bash1",
			partialResult: {
				content: [{ type: "text", text: "line1\nline2\r\nline3" }],
				details: { truncation: undefined },
			},
		},
	);
	// 不得 JSON.stringify：否则换行变成字面 \\n，实时输出换行全坏。
	assert.equal(state.get("bash1").output, "line1\nline2\nline3");
	assert.equal(state.get("bash1").output.includes("\\n"), false);
});

test("update content 多 text 块用换行拼接；空 content 视为空输出", () => {
	const multi = applyToolExecutionUpdate(
		applyToolExecutionStart(EMPTY, { toolCallId: "m", toolName: "bash", args: {} }),
		{ toolCallId: "m", partialResult: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } },
	);
	assert.equal(multi.get("m").output, "a\nb");
	const empty = applyToolExecutionUpdate(
		applyToolExecutionStart(EMPTY, { toolCallId: "e", toolName: "bash", args: {} }),
		{ toolCallId: "e", partialResult: { content: [] } },
	);
	assert.equal(empty.get("e").output, "");
});

test("并行多工具互不干扰（按 toolCallId 独立键控）", () => {
	let state = applyToolExecutionStart(EMPTY, { toolCallId: "t1", toolName: "bash", args: { command: "npm run dev" } });
	state = applyToolExecutionStart(state, { toolCallId: "t2", toolName: "grep", args: { pattern: "TODO" } });
	state = applyToolExecutionUpdate(state, { toolCallId: "t1", partialResult: "bash 输出" });
	state = applyToolExecutionUpdate(state, { toolCallId: "t2", partialResult: "grep 输出" });
	state = applyToolExecutionEnd(state, { toolCallId: "t2", result: "grep 完成", isError: false });
	assert.equal(state.get("t1").status, "running");
	assert.equal(state.get("t1").output, "bash 输出");
	assert.equal(state.get("t2").status, "success");
	assert.equal(state.get("t2").output, "grep 输出");
	// end 只影响 t2，t1 仍 running
	assert.equal(state.get("t1").endedAt, undefined);
});

test("end 固定 status（isError → error / 否则 success）与 endedAt", () => {
	const started = applyToolExecutionStart(EMPTY, { toolCallId: "ok", toolName: "bash", args: {} });
	const ok = applyToolExecutionEnd(started, { toolCallId: "ok", result: "done", isError: false });
	assert.equal(ok.get("ok").status, "success");
	assert.ok(ok.get("ok").endedAt >= ok.get("ok").startedAt);

	const startedErr = applyToolExecutionStart(EMPTY, { toolCallId: "err", toolName: "bash", args: {} });
	const err = applyToolExecutionEnd(startedErr, { toolCallId: "err", result: "boom", isError: true });
	assert.equal(err.get("err").status, "error");
	assert.ok(err.get("err").endedAt >= err.get("err").startedAt);
});

test("end 对无 update 流且 output 为空的工具用 result 摘要兜底", () => {
	const state = applyToolExecutionEnd(
		applyToolExecutionStart(EMPTY, { toolCallId: "t1", toolName: "read_file", args: {} }),
		{ toolCallId: "t1", result: { path: "/x" }, isError: false },
	);
	assert.equal(state.get("t1").output, JSON.stringify({ path: "/x" }));
	assert.equal(state.get("t1").status, "success");
});

test("end 无 start 记录时创建终态兜底项（SSE 重连场景），不抛错", () => {
	const state = applyToolExecutionEnd(EMPTY, { toolCallId: "ghost", toolName: "bash", result: "ran", isError: false });
	const snap = state.get("ghost");
	assert.ok(snap);
	assert.equal(snap.status, "success");
	assert.equal(snap.toolName, "bash");
	assert.equal(snap.output, "ran");
	assert.equal(snap.startedAt, snap.endedAt); // 未知开始时间以结束时间近似
});

test("end 后迟到的 update 安全忽略（状态已终态）", () => {
	let state = applyToolExecutionStart(EMPTY, { toolCallId: "t1", toolName: "bash", args: {} });
	state = applyToolExecutionUpdate(state, { toolCallId: "t1", partialResult: "执行中" });
	state = applyToolExecutionEnd(state, { toolCallId: "t1", result: "", isError: false });
	const afterEnd = applyToolExecutionUpdate(state, { toolCallId: "t1", partialResult: "迟到的更新" });
	assert.equal(afterEnd.get("t1").output, "执行中"); // 不被迟到 update 覆盖
	assert.equal(afterEnd.get("t1").status, "success");
	// 重复 end 幂等忽略
	const again = applyToolExecutionEnd(afterEnd, { toolCallId: "t1", result: "再结束", isError: true });
	assert.equal(again.get("t1").status, "success");
});

test("未见 start 的 update 忽略；toolCallId 缺失/非法输入安全忽略不抛错", () => {
	// 未见 start 就 update
	let state = applyToolExecutionUpdate(EMPTY, { toolCallId: "t1", partialResult: "x" });
	assert.equal(state, EMPTY); // 原引用不变
	// toolCallId 缺失
	state = applyToolExecutionStart(EMPTY, { toolName: "bash", args: {} });
	assert.equal(state, EMPTY);
	state = applyToolExecutionUpdate(state, { partialResult: "x" });
	assert.equal(state, EMPTY);
	state = applyToolExecutionEnd(state, { result: "x", isError: false });
	assert.equal(state, EMPTY);
	// toolCallId 非法（空串 / 非字符串）
	state = applyToolExecutionStart(EMPTY, { toolCallId: "", toolName: "bash" });
	assert.equal(state, EMPTY);
	state = applyToolExecutionStart(EMPTY, { toolCallId: 42, toolName: "bash" });
	assert.equal(state, EMPTY);
	// 事件非对象 / null
	state = applyToolExecutionStart(EMPTY, null);
	assert.equal(state, EMPTY);
	state = applyToolExecutionUpdate(EMPTY, undefined);
	assert.equal(state, EMPTY);
	state = applyToolExecutionEnd(EMPTY, "str");
	assert.equal(state, EMPTY);
});

test("输出超限置 truncated（超过 64KB 截断）", () => {
	const huge = "x".repeat(TOOL_EXECUTION_OUTPUT_MAX_CHARS + 100);
	const state = applyToolExecutionUpdate(
		applyToolExecutionStart(EMPTY, { toolCallId: "t1", toolName: "bash", args: {} }),
		{ toolCallId: "t1", partialResult: huge },
	);
	const snap = state.get("t1");
	assert.equal(snap.output.length, TOOL_EXECUTION_OUTPUT_MAX_CHARS);
	assert.equal(snap.truncated, true);
	// 未超限不置 truncated
	const small = applyToolExecutionUpdate(
		applyToolExecutionStart(EMPTY, { toolCallId: "t2", toolName: "bash", args: {} }),
		{ toolCallId: "t2", partialResult: "short" },
	);
	assert.equal(small.get("t2").truncated, undefined);
	assert.equal(small.get("t2").output, "short");
});

test("clear 清空全部缓冲（新 run 语义）", () => {
	let state = applyToolExecutionStart(EMPTY, { toolCallId: "t1", toolName: "bash", args: {} });
	state = applyToolExecutionStart(state, { toolCallId: "t2", toolName: "grep", args: {} });
	assert.equal(getToolExecutionSnapshots(state).length, 2);
	const cleared = clearToolExecutions(state);
	assert.equal(cleared.size, 0);
	assert.equal(getToolExecutionSnapshots(cleared).length, 0);
	// clear 后旧 id 再 update 也被忽略（无 start 记录）
	const afterClear = applyToolExecutionUpdate(cleared, { toolCallId: "t1", partialResult: "旧工具残留" });
	assert.equal(afterClear.size, 0);
	// 原状态未被修改（不可变）
	assert.equal(getToolExecutionSnapshots(state).length, 2);
});

test("command 提取优先级：args.command 字符串 → command 对象内部 → 摘要字段 → undefined", () => {
	const mk = (args) => applyToolExecutionStart(EMPTY, { toolCallId: "t1", toolName: "bash", args }).get("t1").command;
	// 1. command 为字符串：直接使用
	assert.equal(mk({ command: "ls -la" }), "ls -la");
	// 2. command 为对象：取其内部 command / cmd
	assert.equal(mk({ command: { cmd: "git status" } }), "git status");
	assert.equal(mk({ command: { command: "npm test" } }), "npm test");
	// 3. 摘要字段：cmd → path → pattern → query → file → name（按序取第一个）
	assert.equal(mk({ cmd: "pnpm dev" }), "pnpm dev");
	assert.equal(mk({ path: "/tmp/x", pattern: "*.ts" }), "/tmp/x");
	assert.equal(mk({ pattern: "TODO", query: "q" }), "TODO");
	assert.equal(mk({ query: "hello" }), "hello");
	// 4. 无可用字段 → undefined
	assert.equal(mk({}), undefined);
	assert.equal(mk({ mode: "fast" }), undefined);
	assert.equal(mk(undefined), undefined);
	assert.equal(mk("not-an-object"), undefined);
});

test("getToolExecutionSnapshots 按插入序（工具启动顺序）返回数组副本", () => {
	let state = applyToolExecutionStart(EMPTY, { toolCallId: "t1", toolName: "bash", args: {} });
	state = applyToolExecutionStart(state, { toolCallId: "t2", toolName: "grep", args: {} });
	state = applyToolExecutionStart(state, { toolCallId: "t3", toolName: "read_file", args: {} });
	const snaps = getToolExecutionSnapshots(state);
	assert.deepEqual(snaps.map((s) => s.toolCallId), ["t1", "t2", "t3"]);
	// 返回新数组：修改不影响状态
	snaps[0] = null;
	assert.equal(getToolExecutionSnapshots(state)[0].toolCallId, "t1");
});
