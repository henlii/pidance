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
    ops: ["appendActivity", "appendCommandEntry", "selectLeafExact", "branchFromAssistant", "createSessionFromLeaf", "renameSession", "reparentSessionFile"],
    rule: "离线写前 await destroyAsync；Pi SessionManager 唯一 JSONL writer",
  },
  {
    owner: "lib/sdk-session-host.ts",
    ops: ["prompt", "fork", "navigate_tree", "append_activity", "set_session_name"],
    rule: "同进程 SessionManager 写；同一 submissionId 不重复调 Pi",
  },
  {
    owner: "app/api/sessions/[id]/route.ts",
    ops: ["PATCH renameSession", "DELETE deleteSession"],
    rule: "Route 只调 SessionService",
  },
  {
    owner: "app/api/sessions/[id]/auto-name/route.ts",
    ops: ["renameSession fallback"],
    rule: "set_session_name 失败时 destroyAsync 再 renameSession",
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
  assert.match(svc, /awaitWriterReleased/);
});

test("SdkSessionHost 用 SessionManager 写 activity", async () => {
  const src = await readFile(new URL("./sdk-session-host.ts", import.meta.url), "utf8");
  assert.match(src, /appendCustomEntry/);
  assert.match(src, /createAgentSessionRuntime/);
  assert.match(src, /createWebExtensionUIAdapter/);
});

test("live-session-registry 启动 SDK host", async () => {
  const src = await readFile(new URL("./live-session-registry.ts", import.meta.url), "utf8");
  assert.match(src, /startSdkSessionHost/);
  assert.doesNotMatch(src, /ExternalRpcSession/);
});

test("auto-name fallback：写盘前 destroyAsync 再 renameSession", async () => {
  const route = await readFile(
    new URL("../app/api/sessions/[id]/auto-name/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /sessionService\.destroyAsync\(id\)/);
  assert.match(route, /sessionService\.renameSession/);
  const destroyIdx = route.indexOf("sessionService.destroyAsync(id)");
  const renameIdx = route.indexOf("sessionService.renameSession");
  assert.ok(destroyIdx >= 0 && renameIdx >= 0 && destroyIdx < renameIdx);
});

test("sessions PATCH 改名：只调 SessionService.renameSession", async () => {
  const route = await readFile(
    new URL("../app/api/sessions/[id]/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /sessionService\.renameSession/);
  assert.doesNotMatch(route, /openSessionView/);
  assert.doesNotMatch(route, /from \"@\/lib\/session-reader\"/);
});

test("生产代码不裸 writeFileSync 重写 Pi JSONL header", async () => {
  const svc = await readFile(new URL("./session-service.ts", import.meta.url), "utf8");
  assert.doesNotMatch(svc, /writeFileSync\(/);
  assert.match(svc, /reparentSessionFile/);
  assert.doesNotMatch(svc, /ExternalRpcSession/);
});
