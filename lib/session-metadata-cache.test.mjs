// 会话列表元数据磁盘缓存：顶层扫描 / 轻量单文件解析 / 缓存读写。
// 测试场景全部建在 tmpdir()，不触碰真实 ~/.pi/agent。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	scanSessionFiles,
	scanSessionFileFast,
	loadSessionMetadataCache,
	scheduleSessionMetadataCacheSave,
} = await jiti.import("../lib/session-metadata-cache.ts");

function makeRoot() {
	const root = mkdtempSync(join(tmpdir(), "pidance-cache-test-"));
	const sessionsRoot = join(root, "sessions");
	mkdirSync(join(sessionsRoot, "--root--"), { recursive: true });
	mkdirSync(join(sessionsRoot, "--other--"), { recursive: true });
	return { root, sessionsRoot };
}

const HEADER = JSON.stringify({
	type: "session",
	version: 3,
	id: "abc12345",
	timestamp: "2026-08-01T00:00:00.000Z",
	cwd: "/root",
	parentSession: "/root/parent.jsonl",
});

function writeSession(sessionsRoot, dir, name, lines) {
	const file = join(sessionsRoot, dir, name);
	writeFileSync(file, [HEADER, ...lines].join("\n") + "\n", "utf8");
	return file;
}

test("scanSessionFiles 只扫顶层 *.jsonl", async () => {
	const { root, sessionsRoot } = makeRoot();
	try {
		writeSession(sessionsRoot, "--root--", "a.jsonl", []);
		writeSession(sessionsRoot, "--root--", "b.jsonl", []);
		writeFileSync(join(sessionsRoot, "--root--", "ignored.txt"), "x", "utf8");
		writeFileSync(join(sessionsRoot, "loose.jsonl"), "{}", "utf8"); // 根级不算
		const files = await scanSessionFiles(sessionsRoot);
		assert.equal(files.length, 2);
		assert.ok(files.every((f) => f.path.endsWith(".jsonl")));
		assert.ok(files.every((f) => f.size > 0 && f.mtimeMs > 0));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// 符号链接的 .jsonl 只有 realpath 之后仍在 sessions 根内才收（与有界定位同口径）：
// 根外文件一旦被当成会话列出来，列表、摘要与深链都会跟着它走。
test("scanSessionFiles 不收根外的 .jsonl 符号链接，根内的照常收", async (t) => {
	const { root, sessionsRoot } = makeRoot();
	try {
		const target = writeSession(sessionsRoot, "--root--", "real.jsonl", []);
		const outside = join(root, "outside.jsonl");
		writeFileSync(outside, HEADER, "utf8");
		try {
			symlinkSync(target, join(sessionsRoot, "--root--", "alias.jsonl"));
			symlinkSync(outside, join(sessionsRoot, "--other--", "leak.jsonl"));
		} catch {
			t.skip("本机不支持创建符号链接");
			return;
		}
		const files = await scanSessionFiles(sessionsRoot);
		assert.deepEqual(files.map((f) => basename(f.path)).sort(), ["alias.jsonl", "real.jsonl"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// SDK 的 getSessionName 取**最新**一条 session_info，且空名字是显式清除标题
// （session-manager.js: "Empty names explicitly clear the session title."）。
// 只在非空时保留旧值，会让侧栏显示 SDK 已经清掉的旧标题。
test("scanSessionFileFast 取最新 session_info，空名字清除标题", async () => {
	const { root, sessionsRoot } = makeRoot();
	try {
		const cleared = writeSession(sessionsRoot, "--root--", "cleared.jsonl", [
			JSON.stringify({ type: "session_info", id: "i1", parentId: null, name: "旧标题" }),
			JSON.stringify({ type: "message", id: "u1", parentId: "i1", timestamp: "2026-08-01T00:00:01.000Z", message: { role: "user", content: "第一条" } }),
			JSON.stringify({ type: "session_info", id: "i2", parentId: "u1", name: "" }),
		]);
		const info = await scanSessionFileFast(cleared, { mtimeMs: Date.now(), size: 1 });
		assert.ok(info);
		assert.equal(info.name, undefined, "空名字应清除标题（与 SDK 一致）");

		const latestWins = writeSession(sessionsRoot, "--other--", "renamed.jsonl", [
			JSON.stringify({ type: "session_info", id: "i1", parentId: null, name: "第一个" }),
			JSON.stringify({ type: "session_info", id: "i2", parentId: null, name: "  第二个  " }),
		]);
		const info2 = await scanSessionFileFast(latestWins, { mtimeMs: Date.now(), size: 1 });
		assert.ok(info2);
		assert.equal(info2.name, "第二个", "取最新一条并 trim");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("scanSessionFileFast 提取列表元数据", async () => {
	const { root, sessionsRoot } = makeRoot();
	try {
		const file = writeSession(sessionsRoot, "--root--", "a.jsonl", [
			JSON.stringify({
				type: "session_info",
				id: "i1",
				parentId: null,
				name: "旧标题",
			}),
			JSON.stringify({
				type: "model_change",
				id: "m1",
				parentId: null,
				provider: "x",
				modelId: "y",
				timestamp: "2026-08-01T00:00:01.000Z",
			}),
			JSON.stringify({
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-08-01T00:00:02.000Z",
				message: { role: "user", content: "你好" },
			}),
			JSON.stringify({
				type: "message",
				id: "u2",
				parentId: "u1",
				timestamp: "2026-08-01T00:00:03.000Z",
				message: { role: "user", content: [{ type: "text", text: "第二条" }] },
			}),
			JSON.stringify({
				type: "session_info",
				id: "i2",
				parentId: null,
				name: "新标题",
			}),
			JSON.stringify({
				type: "message",
				id: "a1",
				parentId: "u2",
				timestamp: "2026-08-01T00:00:04.000Z",
				message: { role: "assistant", content: "回复" },
			}),
			"坏行",
			JSON.stringify({
				type: "message",
				id: "r1",
				parentId: "a1",
				timestamp: 1723000000000,
				message: {
					role: "toolResult",
					toolCallId: "t1",
					content: [{ type: "toolResult", toolName: "bash", content: "out" }],
				},
			}),
		]);
		const st = { mtimeMs: Date.now(), size: 1 };
		const info = await scanSessionFileFast(file, st);
		assert.ok(info);
		assert.equal(info.id, "abc12345");
		assert.equal(info.cwd, "/root");
		assert.equal(info.name, "新标题"); // 取最新 session_info
		assert.equal(info.messageCount, 4); // user×2 + assistant + toolResult
		assert.equal(info.firstMessage, "你好"); // 第一条 user 文本
		assert.equal(info.parentSessionPath, "/root/parent.jsonl");
		assert.equal(info.created, "2026-08-01T00:00:00.000Z");
		// modified = 最后 user 消息时间（assistant/toolResult 不抬升）
		assert.equal(info.modified, "2026-08-01T00:00:03.000Z");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("scanSessionFileFast 损坏文件安全返回 null / 空会话可解析", async () => {
	const { root, sessionsRoot } = makeRoot();
	try {
		const bad = join(sessionsRoot, "--root--", "bad.jsonl");
		writeFileSync(bad, "这不是 json", "utf8");
		assert.equal(await scanSessionFileFast(bad, { mtimeMs: 1, size: 1 }), null);

		const empty = writeSession(sessionsRoot, "--root--", "empty.jsonl", []);
		const info = await scanSessionFileFast(empty, { mtimeMs: 1, size: 1 });
		assert.ok(info);
		assert.equal(info.messageCount, 0);
		assert.equal(info.firstMessage, "(no messages)");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("缓存读写：写后读回一致；损坏文件返回 null", async () => {
	const { root } = makeRoot();
	try {
		const cacheFile = join(root, "cache.json");
		const sessions = new Map([
			[
				"/s/a.jsonl",
				{
					m: 111,
					s: 222,
					i: {
						id: "x1",
						cwd: "/root",
						created: "c",
						modified: "m",
						messageCount: 1,
						firstMessage: "f",
						name: "n",
					},
				},
			],
		]);
		const discovery = new Map([
			[
				"/s/a.jsonl",
				{
					m: 111,
					s: 222,
					c: [
						{
							path: "/s/a/child.jsonl",
							id: "c1",
							cwd: "/root",
							timestamp: "t",
							parentSessionId: "x1",
							runId: "r1",
							runIndex: 0,
						},
					],
				},
			],
		]);
		scheduleSessionMetadataCacheSave(sessions, discovery, cacheFile);
		await new Promise((r) => setTimeout(r, 2000));

		const loaded = loadSessionMetadataCache(cacheFile);
		assert.ok(loaded);
		assert.equal(loaded.sessions["/s/a.jsonl"].i.id, "x1");
		assert.equal(loaded.discovery["/s/a.jsonl"].c[0].runId, "r1");

		// 损坏：整体忽略
		writeFileSync(cacheFile, "{broken", "utf8");
		assert.equal(loadSessionMetadataCache(cacheFile), null);

		// 版本不符：忽略
		writeFileSync(
			cacheFile,
			JSON.stringify({ version: 99, sessions: {} }),
			"utf8",
		);
		assert.equal(loadSessionMetadataCache(cacheFile), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
