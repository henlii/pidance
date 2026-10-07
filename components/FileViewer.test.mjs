// 文件编辑器查找/替换的**接线**钉在这里（匹配与替换的边界在 lib/file-find-replace.test.mjs）。
// 这些是源码形状断言：它们拦不住的所有行为错，都交给浏览器 QA 与纯逻辑单测。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "FileViewer.tsx"), "utf8");

test("文件编辑器：Ctrl/Cmd+F 开本文件查找；替换走 FileEditorState，不直接写文件", () => {
	assert.match(source, /if \(key === "f" && !event\.shiftKey\) \{[\s\S]{0,220}openFind\(\);/, "Ctrl/Cmd+F 没接到 openFind");
	assert.match(
		source,
		/const applyFindEdit = \(next: string\) => \{\s*forceBoundaryRef\.current = true;\s*handleEditorChange\(next\);/,
		"替换没走 handleEditorChange（会绕过脏标记/撤销/冲突检测）",
	);
	assert.match(source, /replaceAllMatches\(visibleContent, findQuery, replaceQuery, \{ caseSensitive: matchCase \}\)/, "全部替换没接纯逻辑");
	assert.match(source, /findMatches\(findContent, findQuery, \{ caseSensitive: matchCase \}\)/, "匹配没接纯逻辑");
});

test("文件编辑器：只读（没有编辑器）时不给查找替换入口", () => {
	assert.match(
		source,
		/\{displayMode === "source" && writable && buffer && dispatchBuffer && \(\s*<button[\s\S]{0,240}viewer_find/,
		"查找入口的可用性判断丢了：只读模式下渲染的是 SyntaxHighlighter，没有可聚焦的 textarea",
	);
	assert.match(source, /\{findOpen && displayMode === "source" && writable && buffer && dispatchBuffer && \(/, "查找条没有同样的可用性判断");
});
