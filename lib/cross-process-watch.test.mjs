// 跨进程变更通知：对端租约增减 → locks 帧；会话目录增删 → sessions-changed。
// 全部在临时 agentDir 里造，不触碰真实 ~/.pi/agent。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { subscribeCrossProcessEvents, resetCrossProcessWatchForTests, listSessionsLockedByOther } =
	await jiti.import("../lib/cross-process-watch.ts");

/**
	 * 每个用例都要把子代理 run 根指到临时目录。
	 *
	 * cross-process-watch 默认监听 `pi-subagents-<scope>/async-subagent-runs`（系统临时
	 * 目录，不在 PI_CODING_AGENT_DIR 下面）。不隔离的话，机器上真有一个活跃 run 时，
	 * 它的 status.json 会往「基线阶段不应有广播」这类断言里插帧 —— 也会让测试读到真用户的
	 * 会话路径。
	 */
const ISOLATED_RUNS_ROOT = mkdtempSync(join(tmpdir(), "pidance-xproc-runs-"));
process.env.PI_SUBAGENT_RUNS_ROOT = ISOLATED_RUNS_ROOT;
after(() => { rmSync(ISOLATED_RUNS_ROOT, { recursive: true, force: true }); });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 6_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(100);
	}
	assert.fail(`${label}（等待 ${timeoutMs}ms 未发生）`);
}

/** 一条「对端进程持有」的租约：pid 必须活着，且不是本测试进程（否则按自己排除）。 */
function leaseBody(sessionId, running = true) {
	return JSON.stringify({
		pid: process.ppid,
		sessionId,
		heartbeatAt: Date.now(),
		startedAt: Date.now(),
		// 只有「正在跑」才该被别的实例看成占用（空闲 writer 不算）
		running,
	});
}

test("cross-process watch：对端租约与会话目录变化都会通知", { timeout: 30_000 }, async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pidance-xproc-"));
	const leaseDir = join(agentDir, "pidance-running-leases");
	const sessionsRoot = join(agentDir, "sessions");
	mkdirSync(leaseDir, { recursive: true });
	mkdirSync(join(sessionsRoot, "--root--"), { recursive: true });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	resetCrossProcessWatchForTests();

	try {
		const events = [];
		const unsubscribe = subscribeCrossProcessEvents((event) => events.push(event));
		await sleep(300); // 建基线（首次对账不广播）
		assert.equal(events.length, 0, "基线建立阶段不应有广播");

		// 1) 对端开始执行某个会话
		writeFileSync(join(leaseDir, "sess-a.json"), leaseBody("sess-a"), "utf8");
		await waitFor(
			() => events.some((e) => e.type === "locks" && e.lockedSessionIds.includes("sess-a")),
			"对端租约出现应广播 locks",
		);
		assert.deepEqual(listSessionsLockedByOther(agentDir), ["sess-a"]);

		// 2) 对端结束执行
		unlinkSync(join(leaseDir, "sess-a.json"));
		await waitFor(
			() => events.some((e) => e.type === "locks" && e.lockedSessionIds.length === 0),
			"对端租约释放应广播空锁集",
		);

		// 3) 对端新建会话
		writeFileSync(
			join(sessionsRoot, "--root--", "new-session.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "xproc-new", timestamp: new Date().toISOString(), cwd: "/root" })}\n`,
			"utf8",
		);
		await waitFor(
			() => events.some((e) => e.type === "sessions-changed"),
			"会话目录变化应广播 sessions-changed",
		);

		unsubscribe();
	} finally {
		resetCrossProcessWatchForTests();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("cross-process watch：本进程自己的租约不算「被对端占用」", { timeout: 20_000 }, async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pidance-xproc-self-"));
	mkdirSync(join(agentDir, "pidance-running-leases"), { recursive: true });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	resetCrossProcessWatchForTests();

	try {
		writeFileSync(
			join(agentDir, "pidance-running-leases", "mine.json"),
			JSON.stringify({ pid: process.pid, sessionId: "mine", heartbeatAt: Date.now(), startedAt: Date.now() }),
			"utf8",
		);
		assert.deepEqual(listSessionsLockedByOther(agentDir), [], "本进程持有的租约不是「对端锁」");
	} finally {
		resetCrossProcessWatchForTests();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("cross-process watch：对端进程活着但心跳过期，仍算被占用（不做「解锁」误报）", { timeout: 30_000 }, async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pidance-xproc-stale-"));
	const leaseDir = join(agentDir, "pidance-running-leases");
	mkdirSync(leaseDir, { recursive: true });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	resetCrossProcessWatchForTests();

	try {
		const events = [];
		const unsubscribe = subscribeCrossProcessEvents((event) => events.push(event));
		await sleep(300);
		// 心跳早于 TTL（20s）但持有者进程活着：writer 仍是它，acquireRunningLease 也会拒绝本进程。
		writeFileSync(
			join(leaseDir, "stale.json"),
			JSON.stringify({
				pid: process.ppid,
				sessionId: "stale",
				heartbeatAt: Date.now() - 60_000,
				startedAt: Date.now() - 90_000,
				running: true,
			}),
			"utf8",
		);
		await waitFor(
			() => events.some((e) => e.type === "locks" && e.lockedSessionIds.includes("stale")),
			"心跳过期的活进程租约也应广播为占用",
		);
		assert.deepEqual(listSessionsLockedByOther(agentDir), ["stale"]);
		// 之后不得再出现「不含 stale」的锁帧（那会收起锁定条并放开输入）
		const before = events.filter((e) => e.type === "locks").length;
		await sleep(3_000);
		const locksAfter = events.filter((e) => e.type === "locks").slice(before);
		assert.deepEqual(locksAfter, [], "锁集没有再变化就不应重复广播");
		unsubscribe();
	} finally {
		resetCrossProcessWatchForTests();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("跨进程锁：空闲的 writer（只打开会话）不算别的实例的占用", { timeout: 30_000 }, async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pidance-xproc-idle-"));
	const leaseDir = join(agentDir, "pidance-running-leases");
	mkdirSync(leaseDir, { recursive: true });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	resetCrossProcessWatchForTests();

	try {
		const events = [];
		const unsubscribe = subscribeCrossProcessEvents((event) => events.push(event));
		await sleep(300);
		// 对端活着、租约新鲜，但 running=false：只是打开了会话 / 页面挂着，不该显示占用
		writeFileSync(join(leaseDir, "idle.json"), leaseBody("idle", false), "utf8");
		await sleep(2_500);
		assert.deepEqual(
			listSessionsLockedByOther(agentDir),
			[],
			"空闲 writer 不应出现在「对端正在跑」的锁集里",
		);
		assert.deepEqual(
			events.filter((e) => e.type === "locks"),
			[],
			"空闲 writer 不该触发 locks 广播",
		);
		// 同一个租约转成 running=true → 立刻算占用
		writeFileSync(join(leaseDir, "idle.json"), leaseBody("idle", true), "utf8");
		await waitFor(
			() => events.some((e) => e.type === "locks" && e.lockedSessionIds.includes("idle")),
			"转成运行中后应广播占用",
		);
		unsubscribe();
	} finally {
		resetCrossProcessWatchForTests();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

// 这一条钉的是新契约：**内容变了也要广播**（路径不变）。
// 老契约是「只看路径、追加一律不广播」，代价是用户在旧会话里聊完一句、或对端实例聊完一句，
// 侧栏不会把这条排到项目最上面，得切页面/刷新才看得见。
// 噪音由「内容指纹要稳定一轮才广播」挡住：一边写一边变，永远不稳定。
test("cross-process watch：已有会话「聊完一句」也要广播；一直在写的不广播", { timeout: 40_000 }, async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pidance-xproc-append-"));
	const leaseDir = join(agentDir, "pidance-running-leases");
	const projectDir = join(agentDir, "sessions", "--root--");
	mkdirSync(leaseDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	resetCrossProcessWatchForTests();
	const header = `${JSON.stringify({ type: "session", version: 3, id: "old-session", timestamp: new Date().toISOString(), cwd: "/root" })}\n`;
	const file = join(projectDir, "2026-10-07T00-00-00-000Z_old-session.jsonl");
	const changed = (events) => events.filter((e) => e.type === "sessions-changed").length;
	// 本进程自己持有租约：不该被当成「对端锁」
	writeFileSync(
		join(leaseDir, "old-session.json"),
		JSON.stringify({ pid: process.pid, sessionId: "old-session", heartbeatAt: Date.now(), startedAt: Date.now() }),
		"utf8",
	);

	try {
		const events = [];
		const unsubscribe = subscribeCrossProcessEvents((event) => events.push(event));
		await sleep(300); // 建基线

		// 1) 新建：老行为，立刻广播（不等稳定）
		writeFileSync(file, header, "utf8");
		await waitFor(() => changed(events) >= 1, "新建会话应立刻广播");

		// 2) 往已有会话里追加一条（对端聊完一句）：**路径没变**，稳定一轮之后也要广播
		const before = changed(events);
		writeFileSync(file, header + `${JSON.stringify({ type: "message", role: "user", content: "ping" })}\n`, "utf8");
		await waitFor(() => changed(events) > before, "已有会话追加内容（写完稳定后）应广播", 9_000);

		// 3) 一直在写（运行中的会话）：每一轮指纹都不一样 → 不该广播，
		//    否则「有人跑着」就等于每秒重取几十次整份列表
		const streaming = changed(events);
		for (let i = 0; i < 5; i++) {
			writeFileSync(file, header + `${JSON.stringify({ type: "message", role: "assistant", content: `chunk-${i}` })}\n`, "utf8");
			await sleep(500);
		}
		assert.equal(changed(events), streaming, "一边写一边变（未稳定）不该广播 sessions-changed");
		assert.deepEqual(events.filter((e) => e.type === "locks"), [], "本进程自己的租约不是「对端锁」");

		// 4) 写完了：稳定下来补一次广播
		await waitFor(() => changed(events) > streaming, "停笔之后应补一次广播", 9_000);

		unsubscribe();
	} finally {
		resetCrossProcessWatchForTests();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

/**
 * 子代理 run 记录变化 → `subagent-runs-changed`。
 *
 * 落盘层级照真实布局：子会话在 `<父会话去扩展名>/<runId>/run-N/session.jsonl`，
 * run 记录在 `PI_SUBAGENT_RUNS_ROOT/<runId>/status.json`（默认是系统临时目录，
 * 测试必须注入，否则会去听真实用户的 run）。
 *
 * 关键断言有两条：广播在**写的过程中**就发生（不等停写一轮），以及 `sessionIds`
 * 带的是会话 header 的 id、**不是** runId —— 只读会话页面的 id 是前者。
 */
test("cross-process watch：子代理 run 记录变化广播 subagent-runs-changed（带 header id，不是 runId）", { timeout: 30_000 }, async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pidance-xproc-sub-"));
	const runsRoot = mkdtempSync(join(tmpdir(), "pidance-xproc-runs-"));
	const sessionsRoot = join(agentDir, "sessions");
	const parentBase = join(sessionsRoot, "--root--", "2026-01-01T00-00-00-000Z_parent");
	const runZero = join(parentBase, "run-abc", "run-0");
	const childSessionFile = join(runZero, "session.jsonl");
	const childId = "01a1d81a-child-session";
	const runId = "run-abc";
	mkdirSync(runZero, { recursive: true });
	const childHeader = JSON.stringify({ type: "session", version: 3, id: childId, timestamp: new Date().toISOString(), cwd: "/root" });
	writeFileSync(childSessionFile, `${childHeader}\n`, "utf8");

	const runDir = join(runsRoot, runId);
	mkdirSync(runDir, { recursive: true });
	const statusPath = join(runDir, "status.json");
	const status = (tools) => JSON.stringify({
		version: 1,
		runId,
		state: "running",
		steps: [{ agent: "story-architect", status: "running", sessionFile: childSessionFile, tools }],
	});
	writeFileSync(statusPath, status(["read"]), "utf8");

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousRunsRoot = process.env.PI_SUBAGENT_RUNS_ROOT;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_SUBAGENT_RUNS_ROOT = runsRoot;
	resetCrossProcessWatchForTests();

	try {
		const events = [];
		const unsubscribe = subscribeCrossProcessEvents((event) => events.push(event));
		await sleep(300); // 建基线（首次对账不广播）
		assert.equal(events.length, 0, "基线建立阶段不应有广播");

		// 子代理还在写：status.json 在工具边界上被改写，不是停写后才通知。
		writeFileSync(statusPath, status(["read", "edit"]), "utf8");
		await waitFor(
			() => events.some((e) => e.type === "subagent-runs-changed"),
			"run 记录变化应广播 subagent-runs-changed",
		);
		const frame = events.filter((e) => e.type === "subagent-runs-changed").at(-1);
		assert.deepEqual(frame.sessionIds, [childId], "广播应带子会话 header id");
		assert.ok(!frame.sessionIds.includes(runId), "广播不应带 runId（只读页面的 id 是 header id）");

		// 同一份记录再变一次要能再广播（不能被上一次的节流永久压住）。
		const before = events.filter((e) => e.type === "subagent-runs-changed").length;
		await sleep(600);
		writeFileSync(statusPath, status(["read", "edit", "write"]), "utf8");
		await waitFor(
			() => events.filter((e) => e.type === "subagent-runs-changed").length > before,
			"后续写入应再次广播",
		);

		// 已完成的 run 记录只改了**内容之外**的兄弟文件：指纹不变就不该再广播，
		// 否则只读页面会被无关写入反复拽着重拉。
		const afterStable = events.filter((e) => e.type === "subagent-runs-changed").length;
		writeFileSync(join(runDir, "output-0.log"), "无关产物", "utf8");
		await sleep(700);
		assert.equal(
			events.filter((e) => e.type === "subagent-runs-changed").length,
			afterStable,
			"status.json 没变时，兄弟文件写入不该触发广播",
		);

		unsubscribe();
	} finally {
		resetCrossProcessWatchForTests();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousRunsRoot === undefined) delete process.env.PI_SUBAGENT_RUNS_ROOT;
		else process.env.PI_SUBAGENT_RUNS_ROOT = previousRunsRoot;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(runsRoot, { recursive: true, force: true });
	}
});
/**
 * 多 run 隔离：广播必须收成 diff，只带「这次真的变了」的 run 名下的子会话。
 *
 * 否则任何一个 run 动一下，打开着的所有历史只读会话都会被拽着重拉。
 */
test("cross-process watch：只有一个 run 变化时，广播不带别的 run 的子会话", { timeout: 30_000 }, async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pidance-xproc-multi-"));
	const runsRoot = mkdtempSync(join(tmpdir(), "pidance-xproc-multi-runs-"));
	const makeRun = (runId, childId) => {
		const parentBase = join(agentDir, "sessions", "--root--", `2026-01-01T00-00-00-000Z_${runId}`);
		const runZero = join(parentBase, runId, "run-0");
		mkdirSync(runZero, { recursive: true });
		const sessionFile = join(runZero, "session.jsonl");
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: childId, timestamp: new Date().toISOString(), cwd: "/root" })}\n`, "utf8");
		const runDir = join(runsRoot, runId);
		mkdirSync(runDir, { recursive: true });
		const statusPath = join(runDir, "status.json");
		const write = (tools) => writeFileSync(statusPath, JSON.stringify({
			version: 1, runId, state: "running",
			steps: [{ agent: "a", status: "running", sessionFile, tools }],
		}), "utf8");
		write(["read"]);
		return { write };
	};
	const runA = makeRun("run-aaa", "child-aaa");
	const runB = makeRun("run-bbb", "child-bbb");

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousRunsRoot = process.env.PI_SUBAGENT_RUNS_ROOT;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_SUBAGENT_RUNS_ROOT = runsRoot;
	resetCrossProcessWatchForTests();

	try {
		const events = [];
		const unsubscribe = subscribeCrossProcessEvents((event) => events.push(event));
		await sleep(300);

		// 只动 A：B 的 status.json 一个字节都没改。
		runA.write(["read", "edit"]);
		await waitFor(
			() => events.some((e) => e.type === "subagent-runs-changed"),
			"run A 变化应广播",
		);
		await sleep(700); // 让节流窗口内的后续帧都落定
		const ids = new Set(events.filter((e) => e.type === "subagent-runs-changed").flatMap((e) => e.sessionIds));
		assert.ok(ids.has("child-aaa"), "变化的 run 自己的子会话必须带上");
		assert.equal(ids.has("child-bbb"), false, "没变化的 run 的子会话不该被带上（否则会把别的只读页拽着重拉）");

		unsubscribe();
	} finally {
		resetCrossProcessWatchForTests();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousRunsRoot === undefined) delete process.env.PI_SUBAGENT_RUNS_ROOT;
		else process.env.PI_SUBAGENT_RUNS_ROOT = previousRunsRoot;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(runsRoot, { recursive: true, force: true });
	}
});