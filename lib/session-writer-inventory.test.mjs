/**
 * P1 会话 writer 清单与单写者契约（#20）。
 *
 * 目的：
 * 1. 固定当前所有会写 Pi JSONL / leaf sidecar 的生产路径，防止迁移期静默新增 writer。
 * 2. 用源码门禁约束：live 外部进程存活时不得直接 openSessionFile 写盘。
 * 3. 行为测试：ExternalRpcSession.appendActivity 在进程存活时拒绝写。
 *
 * 迁移到 SdkSessionHost 后，本文件应改为断言唯一 writer 为 Pi SessionManager，
 * 并删除 ExternalRpcSession 相关断言。
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url).pathname;

/** 生产路径上已知的 session JSONL writer 清单（迁移期权威表）。 */
const KNOWN_SESSION_WRITERS = [
  {
    owner: "lib/session-service.ts",
    ops: ["appendActivity", "appendCommandEntry", "selectLeafExact", "branchFromAssistant", "createSessionFromLeaf"],
    rule: "live 无 inner.sessionManager 时先 destroy，再 Pi SessionManager 写",
  },
  {
    owner: "lib/sdk-session-host.ts",
    ops: ["prompt", "fork", "navigate_tree", "append_activity", "set_session_name"],
    rule: "同进程 SessionManager 写；持有 session ownership lock",
  },
  {
    owner: "app/api/sessions/[id]/route.ts",
    ops: ["PATCH name", "DELETE reparent children header"],
    rule: "改名 live 走 set_session_name；无 live 才 openSessionView；DELETE 先 destroy",
  },
  {
    owner: "app/api/sessions/[id]/auto-name/route.ts",
    ops: ["appendSessionInfo fallback"],
    rule: "set_session_name 失败时先 destroy live 再 openSessionView",
  },
  {
    owner: "lib/session-leaf-sidecar.ts",
    ops: ["writeLeafSidecar", "clearLeafSidecar"],
    rule: "Pi schema 外产品元数据；调用方保证外部 pi 已 quiesce/destroy",
  },
  {
    owner: "lib/pi-session-io.ts",
    ops: ["append*", "branch", "createBranchedSession", "_rewriteFile"],
    rule: "迁移期 legacy 实现；不得被 Route 在 live 存活时直接调用",
  },
];

test("writer 清单：条目完整且 owner 文件存在", async () => {
  assert.ok(KNOWN_SESSION_WRITERS.length >= 6);
  for (const item of KNOWN_SESSION_WRITERS) {
    const path = join(ROOT, item.owner);
    const body = await readFile(path, "utf8");
    assert.ok(body.length > 0, `${item.owner} 应存在`);
    assert.ok(item.ops.length > 0);
    assert.ok(item.rule.length > 0);
  }
});

test("SessionService.appendActivity：仅 hasInProcessManager 时走 live.appendActivity", async () => {
  const svc = await readFile(new URL("./session-service.ts", import.meta.url), "utf8");
  assert.match(svc, /hasInProcessManager/);
  assert.match(svc, /inner\?\.sessionManager/);
  // 无 in-process manager 时 destroy
  assert.match(svc, /if \(live\?\.isAlive\(\)\) \{\s*service\.destroy\(sessionId\);/);
});

test("SdkSessionHost 持有 ownership lock 并用 SessionManager 写 activity", async () => {
  const src = await readFile(new URL("./sdk-session-host.ts", import.meta.url), "utf8");
  assert.match(src, /tryAcquireSessionLock/);
  assert.match(src, /appendCustomEntry/);
  assert.match(src, /createAgentSessionRuntime/);
  assert.match(src, /createWebExtensionUIAdapter/);
});

test("live-session-registry 启动 SDK host", async () => {
  const src = await readFile(new URL("./live-session-registry.ts", import.meta.url), "utf8");
  assert.match(src, /startSdkSessionHost/);
  assert.doesNotMatch(src, /ExternalRpcSession/);
});

test("auto-name fallback：写盘前 destroy live（源码门禁）", async () => {
  const route = await readFile(
    new URL("../app/api/sessions/[id]/auto-name/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /sessionService\.destroy\(id\)/);
  assert.match(route, /appendSessionInfo/);
  const destroyIdx = route.indexOf("sessionService.destroy(id)");
  const appendIdx = route.indexOf("appendSessionInfo");
  assert.ok(destroyIdx >= 0 && appendIdx >= 0 && destroyIdx < appendIdx);
});

test("sessions PATCH 改名：live 走 set_session_name，无 live 才磁盘写", async () => {
  const route = await readFile(
    new URL("../app/api/sessions/[id]/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /live\?\.isAlive\(\)/);
  assert.match(route, /type: \"set_session_name\"/);
  assert.match(route, /appendSessionInfo/);
});
