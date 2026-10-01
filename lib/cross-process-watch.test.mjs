// 跨进程变更通知：对端租约增减 → locks 帧；会话目录增删 → sessions-changed。
// 全部在临时 agentDir 里造，不触碰真实 ~/.pi/agent。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { subscribeCrossProcessEvents, resetCrossProcessWatchForTests, listSessionsLockedByOther } =
	await jiti.import("../lib/cross-process-watch.ts");

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

test("cross-process watch：只追加内容不广播，本进程自己的租约也不广播", { timeout: 40_000 }, async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pidance-xproc-append-"));
	const leaseDir = join(agentDir, "pidance-running-leases");
	const projectDir = join(agentDir, "sessions", "--root--");
	mkdirSync(leaseDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	resetCrossProcessWatchForTests();

	try {
		const sessionFile = join(projectDir, "live.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: "live", timestamp: new Date().toISOString(), cwd: "/root" })}\n`,
			"utf8",
		);
		const events = [];
		const unsubscribe = subscribeCrossProcessEvents((event) => events.push(event));
		await sleep(300);

		// 只追加内容（正在运行的会话）→ 另一个实例不该每轮重取列表
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "message", id: "m1", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "hi" }] } })}\n`,
			{ flag: "a" },
		);
		// 本进程自己持有租约 → 不是「对端锁」
		writeFileSync(
			join(leaseDir, "mine.json"),
			JSON.stringify({ pid: process.pid, sessionId: "mine", heartbeatAt: Date.now(), startedAt: Date.now() }),
			"utf8",
		);
		await sleep(7_000); // 超过 SESSION_POLL_MS(5s)，让轮询也跑过一轮
		assert.deepEqual(
			events.filter((e) => e.type === "sessions-changed"),
			[],
			"只追加内容不应广播 sessions-changed",
		);
		assert.deepEqual(
			events.filter((e) => e.type === "locks"),
			[],
			"本进程自己的租约不应广播 locks",
		);
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
