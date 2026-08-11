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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { readFile } from "node:fs/promises";

const jiti = createJiti(import.meta.url);
const ROOT = new URL("../", import.meta.url).pathname;

/** 生产路径上已知的 session JSONL writer 清单（迁移期权威表）。 */
const KNOWN_SESSION_WRITERS = [
  {
    owner: "lib/session-service.ts",
    ops: ["appendActivity", "appendCommandEntry", "selectLeafExact", "branchFromAssistant", "createSessionFromLeaf"],
    rule: "live 无 inner.sessionManager 时先 destroy，再 SessionFile 写",
  },
  {
    owner: "lib/pi-runtime/external-session.ts",
    ops: ["fork", "navigate_tree", "set_branch_label", "append_activity", "set_session_name(RPC)"],
    rule: "磁盘树写前 quiesce；append_activity 写后 destroy；进程存活时 appendActivity 抛错",
  },
  {
    owner: "app/api/sessions/[id]/route.ts",
    ops: ["PATCH name", "DELETE reparent children header"],
    rule: "改名 live 走 set_session_name；无 live 才 SessionFile；DELETE 先 destroy",
  },
  {
    owner: "app/api/sessions/[id]/auto-name/route.ts",
    ops: ["appendSessionInfo fallback"],
    rule: "set_session_name 失败时先 destroy live 再 SessionFile",
  },
  {
    owner: "lib/session-leaf-sidecar.ts",
    ops: ["writeLeafSidecar", "clearLeafSidecar"],
    rule: "Pi schema 外产品元数据；调用方保证外部 pi 已 quiesce/destroy",
  },
  {
    owner: "lib/session-file.ts",
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

test("ExternalRpcSession.append_activity：quiesce → 写盘 → destroy（源码顺序）", async () => {
  const src = await readFile(new URL("./pi-runtime/external-session.ts", import.meta.url), "utf8");
  const start = src.indexOf('case "append_activity"');
  assert.ok(start >= 0);
  const slice = src.slice(start, start + 500);
  assert.match(slice, /quiesceForTreeWrite/);
  assert.match(slice, /appendActivity\(/);
  assert.match(slice, /this\.destroy\(\)/);
  const q = slice.indexOf("quiesceForTreeWrite");
  const a = slice.indexOf("appendActivity");
  const d = slice.indexOf("this.destroy()");
  assert.ok(q < a && a < d, "顺序必须是 quiesce → append → destroy");
});

test("ExternalRpcSession.appendActivity：进程存活时拒绝写盘", async () => {
  const { ExternalRpcSession } = await jiti.import("./pi-runtime/external-session.ts");
  const dir = mkdtempSync(join(tmpdir(), "ext-act-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(
    file,
    JSON.stringify({
      type: "session",
      version: 3,
      id: "s1",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/tmp",
    }) + "\n",
  );
  try {
    const session = new ExternalRpcSession({
      sessionId: "s1",
      sessionFile: file,
      cwd: "/tmp",
      idleTimeoutMs: 60_000,
    });
    // 伪造仍存活的外部进程（jiti 下 TS private 仍为可写字段，与 ansi 测试同 idiom）
    session["process"] = { isAlive: () => true, stop: async () => {} };
    assert.throws(
      () => session.appendActivity({ kind: "result", title: "t", content: "c" }),
      /quiesce first|alive/i,
    );
    // 文件不得新增 activity 行
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /pidance\.activity/);
    session.destroy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
