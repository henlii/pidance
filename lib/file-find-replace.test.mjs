// 文件编辑器查找/替换的纯逻辑：边界都钉在这里，组件只接线。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { findMatches, replaceMatch, replaceAllMatches, stepMatchIndex } = await jiti.import("./file-find-replace.ts");

test("findMatches：大小写默认不敏感，区分大小写开关生效", () => {
	assert.deepEqual(findMatches("Foo foo FOO", "foo"), [
		{ start: 0, end: 3 },
		{ start: 4, end: 7 },
		{ start: 8, end: 11 },
	]);
	assert.deepEqual(findMatches("Foo foo FOO", "foo", { caseSensitive: true }), [{ start: 4, end: 7 }]);
	assert.deepEqual(findMatches("中文里有中文", "中文"), [
		{ start: 0, end: 2 },
		{ start: 4, end: 6 },
	]);
});

test("findMatches：空查询没有匹配；不重叠；找不到就是空数组", () => {
	assert.deepEqual(findMatches("aaa", ""), [], "空查询不该在每两个字符之间都匹配");
	assert.deepEqual(findMatches("aaaa", "aa"), [{ start: 0, end: 2 }, { start: 2, end: 4 }], "aaaa 里的 aa 是不重叠的两处");
	assert.deepEqual(findMatches("abc", "zzz"), []);
});

test("replaceMatch：替换一处；范围越界原样返回", () => {
	assert.equal(replaceMatch("hello world", { start: 6, end: 11 }, "there"), "hello there");
	assert.equal(replaceMatch("hello", { start: 3, end: 99 }, "x"), "hello", "越界不改内容");
});

test("replaceAllMatches：全部替换；替换串里的查询串不会被二次替换", () => {
	assert.deepEqual(replaceAllMatches("a-b-c", "-", " + "), { content: "a + b + c", count: 2 });
	assert.deepEqual(replaceAllMatches("aAa", "a", "aa"), { content: "aaaaaa", count: 3 }, "不会越换越长");
	assert.deepEqual(replaceAllMatches("aAa", "a", "aa", { caseSensitive: true }), { content: "aaAaa", count: 2 });
	assert.deepEqual(replaceAllMatches("abc", "zzz", "x"), { content: "abc", count: 0 });
	assert.deepEqual(replaceAllMatches("abc", "", "x"), { content: "abc", count: 0 });
});

test("stepMatchIndex：环形前进/后退，未定位时按方向落到首/末", () => {
	assert.equal(stepMatchIndex(-1, 5, 1), 0);
	assert.equal(stepMatchIndex(-1, 5, -1), 4);
	assert.equal(stepMatchIndex(4, 5, 1), 0, "最后一个再往后回到第一个");
	assert.equal(stepMatchIndex(0, 5, -1), 4, "第一个再往前回到最后一个");
	assert.equal(stepMatchIndex(2, 5, 1), 3);
	assert.equal(stepMatchIndex(0, 0, 1), -1, "没有匹配");
	assert.equal(stepMatchIndex(7, 3, 1), 0, "下标越界按未定位处理");
});
