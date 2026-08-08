import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SessionFile, openSessionFile } = await jiti.import("./session-file.ts");
const {
	readLeafSidecar,
	writeLeafSidecar,
	leafSidecarPath,
	clearLeafSidecar,
} = await jiti.import("./session-leaf-sidecar.ts");

test("create + appendCustomEntry + open 往返", () => {
	const dir = mkdtempSync(join(tmpdir(), "sf-"));
	try {
		const sm = SessionFile.create("/tmp/proj", dir);
		const file = sm.getSessionFile();
		assert.ok(file);
		// 无 assistant 时可能未落盘；强制写 header
		const id1 = sm.appendCustomEntry("pidance.activity", { kind: "test" });
		assert.ok(id1);
		// 模拟 assistant 以触发 flush
		// 直接再 append 一条 message
		const leaf = sm.getLeafId();
		assert.equal(leaf, id1);

		// 手动写 assistant 进文件：用 branch/create 路径
		// 重新 open
		if (!existsSync(file) && sm.getSessionFile()) {
			// 未 flushed：rewrite 通过再 append model_change 后仍可能未 flush
		}
		// appendModelChange 同样
		sm.appendModelChange("p", "m");
		// 强制：createBranchedSession 需要已有路径
		const entries = sm.getEntries();
		assert.ok(entries.length >= 1);

		// open 新实例
		const path = sm.getSessionFile();
		assert.ok(path);
		// 若未落盘，createBranchedSession 会写新文件；对原文件 _rewrite
		// 用 branch 持久化
		sm.branch(id1);
		assert.ok(existsSync(path));

		const sm2 = openSessionFile(path);
		assert.equal(sm2.getSessionId(), sm.getSessionId());
		assert.equal(sm2.getEntry(id1)?.type, "custom");
		assert.equal(sm2.getLeafId(), id1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createBranchedSession 生成新文件与 parentSession", () => {
	const dir = mkdtempSync(join(tmpdir(), "sf-"));
	try {
		const sm = SessionFile.create("/tmp/proj", dir);
		const a = sm.appendCustomEntry("t", { n: 1 });
		const b = sm.appendCustomEntry("t", { n: 2 });
		sm.branch(b); // flush
		const parentFile = sm.getSessionFile();
		const newFile = sm.createBranchedSession(a);
		assert.ok(newFile);
		assert.ok(existsSync(newFile));
		const raw = readFileSync(newFile, "utf8");
		const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
		assert.equal(lines[0].type, "session");
		assert.equal(lines[0].parentSession, parentFile);
		assert.ok(lines.some((e) => e.id === a));
		assert.ok(!lines.some((e) => e.id === b && e.type === "custom" && e.data?.n === 2) || lines.filter((e) => e.type === "custom").length === 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeSession(dir) {
	const sm = SessionFile.create("/tmp/proj", dir);
	const a = sm.appendCustomEntry("t", { n: 1 });
	const b = sm.appendCustomEntry("t", { n: 2 });
	sm.branch(b); // flush
	return { sm, a, b, file: sm.getSessionFile() };
}

test("branch 持久化走 sidecar 而非 header 扩展字段", () => {
	const dir = mkdtempSync(join(tmpdir(), "sf-"));
	try {
		const { sm, a, file } = makeSession(dir);
		sm.branch(a);
		assert.equal(readLeafSidecar(file), a);
		// header 不得再含 pidanceLeafId
		const raw = readFileSync(file, "utf8");
		assert.ok(!raw.includes("pidanceLeafId"));
		const sm2 = openSessionFile(file);
		assert.equal(sm2.getLeafId(), a);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("历史 header pidanceLeafId 一次性迁移到 sidecar 并清理 header", () => {
	const dir = mkdtempSync(join(tmpdir(), "sf-"));
	try {
		const { sm, a, file } = makeSession(dir);
		// 模拟历史形态：无 sidecar，header 手工带 pidanceLeafId
		clearLeafSidecar(file);
		assert.equal(readLeafSidecar(file), null);
		const lines = readFileSync(file, "utf8").trim().split("\n");
		const header = JSON.parse(lines[0]);
		header.pidanceLeafId = a;
		lines[0] = JSON.stringify(header);
		writeFileSync(file, lines.join("\n"));
		assert.ok(readFileSync(file, "utf8").includes("pidanceLeafId"));

		const sm2 = openSessionFile(file);
		assert.equal(sm2.getLeafId(), a);
		assert.equal(readLeafSidecar(file), a);
		assert.ok(!readFileSync(file, "utf8").includes("pidanceLeafId"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("getLastEntryId = 文件末尾 entry（不经 sidecar）", () => {
	const dir = mkdtempSync(join(tmpdir(), "sf-"));
	try {
		const { sm, a, b, file } = makeSession(dir);
		sm.branch(a); // sidecar = a，但文件末尾是 b
		const sm2 = openSessionFile(file);
		assert.equal(sm2.getLeafId(), a); // sidecar 恢复
		assert.equal(sm2.getLastEntryId(), b); // 文件末尾不受 sidecar 影响
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("clearLeafSidecar 删除 sidecar 文件", () => {
	const dir = mkdtempSync(join(tmpdir(), "sf-"));
	try {
		const { file } = makeSession(dir);
		writeLeafSidecar(file, "x");
		assert.ok(existsSync(leafSidecarPath(file)));
		clearLeafSidecar(file);
		assert.ok(!existsSync(leafSidecarPath(file)));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
