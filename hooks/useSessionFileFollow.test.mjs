/**
 * 跨进程会话文件跟随的接线守卫。
 *
 * 行为散在三处：tail 路由的探测语义、客户端的跟随循环、服务端增量投影接口。
 * 任何一处退回旧实现都不会报错，只会让「对端在跑/手改文件」又变成看不见。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("tail 路由：只读探测，区分 localLive / reset / externalRewrite", () => {
  const route = read("../app/api/sessions/[id]/tail/route.ts");
  assert.match(route, /sessionService\.resolvePath\(id\)/, "未解析会话文件路径");
  assert.match(route, /sessionService\.getLive\(id\)/, "未回报本进程是否有 live host（三态互斥要用）");
  assert.match(route, /sessionService\.isLockedByOther\(id\)/, "未探测对端 writer（外部改写保护要用）");
  assert.match(route, /waitForSessionFileChange\(filePath, stamp, wait, req\.signal\)/, "缺少长轮询等待");
  assert.match(route, /const MAX_WAIT_MS = 10_000;/, "等待上限应为 10s");
  assert.match(route, /unavailable\(id\)/, "失败应返回安全空态而不是错误页");
});

test("文件层：首次只建基线，没变化不读尾巴，截断/换 inode 交给调用方判", () => {
  const lib = read("../lib/session-file-tail.ts");
  assert.match(lib, /const wantsTail = previous === null \|\| changed \|\| regressed;/, "空闲探测不应每轮读 64KB 尾巴");
  assert.match(lib, /reset: regressed && !writerActive/, "无 writer 才判 reset");
  assert.match(lib, /externalRewrite: regressed && writerActive/, "有 writer 时应判 externalRewrite");
  assert.match(lib, /FILE_FOLLOW_POLL_MS = 2_000/, "缺少 inotify 失效的兜底对账");
});

test("客户端：三态互斥 + 守卫 + 增量补回", () => {
  const hook = read("./useAgentSession.ts");
  assert.match(hook, /\/api\/sessions\/\$\{encodeURIComponent\(sid\)\}\/tail\?/, "未接 tail 探测");
  assert.match(hook, /probe\.localLive === true[\s\S]{0,400}schedule\(5_000\)/, "live 态应让 SSE 独占时间线");
  assert.match(hook, /probe\.externalRewrite === true[\s\S]{0,400}followNoticeRef\.current\(/, "外部改写未提示");
  assert.match(hook, /probe\.reset === true[\s\S]{0,400}silentFailure: true/, "reset 未走静默全量重载");
  assert.match(hook, /if \(outcome === "skipped"\)[\s\S]{0,400}schedule\(1_000\)/, "追加被跳过时未保留增量");
  assert.match(
    hook,
    /isBaselineProbe &&[\s\S]{0,120}probe\.lastEntryId !== entryIdsRef\.current/,
    "建基线时没有补上「加载 → 基线」之间漏掉的追加",
  );
  assert.match(hook, /document\.visibilityState !== "visible"\) return;/, "后台标签仍在跟随");
  assert.match(hook, /if \(historyLoadingRef\.current\) return "skipped";/, "翻历史时未让路");
  assert.match(hook, /if \(hasMoreAfterRef\.current\) return "skipped";/, "跳读窗口未受保护");
  assert.match(hook, /const controller = new AbortController\(\);/, "后台追加未使用独立 abort（会打断用户分页）");
});
