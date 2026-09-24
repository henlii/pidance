/**
 * #91 的接线不变量（源码契约）。
 *
 * 这些是**结构守卫**：行为验证靠浏览器复现（连续两次导航不再出现永久 pending 的请求），
 * 但下面几条一旦被改回去，症状会以「连接又不够用 / 失败又停在空白」的形式悄悄回来，
 * 所以用源码契约把它们钉住（与 ChatWindow.test.mjs 既有做法一致）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const countOf = (source, needle) => source.split(needle).length - 1;

test("侧栏不再自己开 /api/agent/running/events，改走共用应用级流", () => {
  const source = read("./SessionSidebar.tsx");
  assert.equal(
    countOf(source, 'new EventSource("/api/agent/running/events")'),
    0,
    "一个页面只允许一条应用级流：侧栏自己再开一条会白占同源连接（#91）",
  );
  assert.ok(source.includes("subscribeAppEvents("), "运行集必须来自 subscribeAppEvents");
});

test("会话详情加载走带超时+重试的加载器，不再是无超时的裸 fetch", () => {
  const source = read("../hooks/useAgentSession.ts");
  assert.ok(source.includes("loadWithBoundedRetry("), "详情加载必须带超时与有界重试（否则饿住时永久 loading）");
  assert.ok(source.includes("DETAIL_LOAD_TIMEOUT_MS"), "必须有明确的超时常量");
  assert.ok(
    !/await fetch\(`\/api\/sessions\/\$\{encodeURIComponent\(sid\)\}\?/.test(source),
    "详情请求不得退回无超时的 fetch",
  );
  assert.ok(source.includes("retryLoadSession"), "必须暴露重试入口给聊天区");
  assert.ok(
    !source.includes("const hotRes = await fetch("),
    "热状态加载也要带超时（它挂着同样会把 loading 永久留住）",
  );
});

test("聊天区的加载失败分支给出可点重试", () => {
  const source = read("./ChatWindow.tsx");
  const errorStart = source.indexOf("  if (error) {");
  assert.ok(errorStart >= 0, "应当存在 if (error) 分支");
  const errorBranch = source.slice(errorStart, errorStart + 1_200);
  assert.ok(errorBranch.includes("retryLoadSession"), "失败分支必须能重试");
  assert.ok(errorBranch.includes('role="alert"'), "失败分支应对辅助技术可见");
  assert.ok(source.includes("chat_loadFailedHint"), "失败分支要给一句可读说明");
});

test("文件监听流被登记，且 bfcache 恢复后会重建", () => {
  const source = read("./FileViewer.tsx");
  assert.equal(
    countOf(source, 'new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId))'),
    5,
    "五个文件查看器各有一次 watch 建流（改动后应仍是 5 处）",
  );
  assert.equal(countOf(source, "trackLiveEventSource(es);"), 5, "每处都要登记（否则 pagehide 让不出连接）");
  assert.equal(countOf(source, "closeTrackedEventSource(es);"), 5, "清理路径要关闭 + 注销");
  assert.equal(
    countOf(source, "}, [filePath, sourceSessionId, restoreNonce]);"),
    3,
    "三个 watch effect 的依赖要含恢复计数",
  );
  assert.equal(
    countOf(source, "}, [filePath, isPdf, sourceSessionId, t, restoreNonce]);"),
    1,
    "DocumentViewer 的 watch effect 依赖要含恢复计数",
  );
  assert.equal(
    countOf(source, "}, [filePath, fetchContent, fetchGitDiff, sourceSessionId, restoreNonce]);"),
    1,
    "TextFileViewer 的 watch effect 依赖要含恢复计数",
  );
  assert.equal(countOf(source, "restoreNonce]);"), 5, "五个 watch effect 都要含恢复计数");
});
