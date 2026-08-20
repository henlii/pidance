import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	browseDirectory,
	expandHome,
	getBrowseDirectoryPath,
	getBrowseLeafSegment,
} = await jiti.import("../lib/cwd-browse.ts");

function makeTree() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pidance-browse-"));
	fs.mkdirSync(path.join(root, "real-dir"));
	fs.mkdirSync(path.join(root, "a-dir"));
	fs.writeFileSync(path.join(root, "file.txt"), "x");
	try {
		fs.symlinkSync(path.join(root, "real-dir"), path.join(root, "link-dir"));
		fs.symlinkSync("/nonexistent-target-xyz", path.join(root, "broken-link"));
	} catch {
		// 平台不支持 symlink 时跳过
	}
	return root;
}

test("browseDirectory 只列目录（含符号链接目录跟随，排除文件/坏链接）", async () => {
	const root = makeTree();
	const result = await browseDirectory(root);
	assert.ok(result);
	assert.equal(result.path, root);
	const names = result.entries.map((e) => e.name).sort();
	assert.deepEqual(names, ["a-dir", "link-dir", "real-dir"]);
});

test("browseDirectory 返回 parentPath（根目录为 null）", async () => {
	const root = makeTree();
	const result = await browseDirectory(root);
	assert.ok(result);
	assert.equal(result.parentPath, path.dirname(root));
	const rootResult = await browseDirectory("/");
	assert.ok(rootResult);
	assert.equal(rootResult.parentPath, null);
});

test("browseDirectory 已与 PTY 同等开放：node_modules/.git 等目录不再隐藏", async () => {
	const root = makeTree();
	fs.mkdirSync(path.join(root, "node_modules"));
	fs.mkdirSync(path.join(root, ".git"));
	const result = await browseDirectory(root);
	assert.ok(result);
	const names = result.entries.map((e) => e.name);
	assert.ok(names.includes("node_modules"));
	assert.ok(names.includes(".git"));
});

test("browseDirectory 不存在/非目录/非法输入返回 null", async () => {
	assert.equal(await browseDirectory("/nonexistent-path-xyz"), null);
	const root = makeTree();
	assert.equal(await browseDirectory(path.join(root, "file.txt")), null);
	assert.equal(await browseDirectory("relative/path"), null);
});

test("expandHome 展开 ~ 与 ~/，相对路径拒绝", () => {
	const home = process.env.HOME;
	assert.equal(expandHome("~"), home);
	assert.equal(expandHome("~/a"), path.join(home, "a"));
	assert.equal(expandHome("/abs"), "/abs");
	assert.equal(expandHome("rel"), null);
	assert.equal(expandHome(""), null);
});

test("getBrowseDirectoryPath / getBrowseLeafSegment 叶子语义", () => {
	assert.equal(getBrowseDirectoryPath("/a/b/c"), "/a/b/");
	assert.equal(getBrowseDirectoryPath("/a/b/"), "/a/b/");
	assert.equal(getBrowseLeafSegment("/a/b/c"), "c");
	assert.equal(getBrowseLeafSegment("/a/b/"), "");
});
