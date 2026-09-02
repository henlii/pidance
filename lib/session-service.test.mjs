import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSessionService, ReadOnlySubagentError, httpStatusForSessionError, READ_ONLY_SUBAGENT_ERROR } = await jiti.import("./session-service.ts");
const { readLeafSidecar, writeLeafSidecar } = await jiti.import("./session-leaf-sidecar.ts");

function createFakeSession(id = "live-1", { alive = true } = {}) {
  const calls = [];
  let destroyed = false;
  return {
    id,
    isAlive: () => alive && !destroyed,
    send: async (command) => {
      calls.push(command);
      return { ok: true, command };
    },
    destroy: () => {
      destroyed = true;
    },
    inner: {
      sessionManager: {
        getLeafId: () => `leaf-${id}`,
        getEntries: () => [],
        getTree: () => [],
        getHeader: () => ({ id, cwd: "/tmp" }),
        getSessionName: () => id,
      },
    },
    calls,
    get destroyed() {
      return destroyed;
    },
  };
}

test("listSessions 聚合会话列表与运行中 id", async () => {
  const service = createSessionService({
    listAllSessions: async () => [{ id: "s1", cwd: "/tmp", path: "/tmp/s1.jsonl", created: "", modified: "", messageCount: 0, firstMessage: "" }],
    getRunningRpcSessionIds: () => ["s1"],
  });

  const result = await service.listSessions();
  assert.equal(result.sessions.length, 1);
  assert.deepEqual(result.runningSessionIds, ["s1"]);
});

test("getSessionInfo：按 id 返回单条；缺失 null；不启动 AgentSession", async () => {
  let started = 0;
  const target = {
    id: "s-target",
    cwd: "/proj",
    path: "/tmp/s-target.jsonl",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-02T00:00:00.000Z",
    messageCount: 2,
    firstMessage: "hi",
    projectRoot: "/proj",
  };
  const service = createSessionService({
    listAllSessions: async () => [
      { id: "other", cwd: "/x", path: "/tmp/other.jsonl", created: "", modified: "", messageCount: 0, firstMessage: "" },
      target,
    ],
    startRpcSession: async () => {
      started += 1;
      throw new Error("不应启动");
    },
    getRpcSession: () => undefined,
  });

  const found = await service.getSessionInfo("s-target");
  assert.deepEqual(found, target);
  assert.equal(await service.getSessionInfo("missing"), null);
  assert.equal(await service.getSessionInfo(""), null);
  assert.equal(started, 0);
});

test("send 优先走 live 会话快路径", async () => {
  const live = createFakeSession("live-1");
  let started = false;
  const service = createSessionService({
    getRpcSession: (id) => (id === "live-1" ? live : undefined),
    startRpcSession: async () => {
      started = true;
      throw new Error("should not start");
    },
    resolveSessionPath: async () => {
      throw new Error("should not resolve");
    },
  });

  const data = await service.send("live-1", { type: "get_state" });
  assert.equal(started, false);
  assert.deepEqual(live.calls, [{ type: "get_state" }]);
  assert.equal(data.ok, true);
});

test("send 在会话不存在时抛出 Session not found", async () => {
  const service = createSessionService({
    getRpcSession: () => undefined,
    resolveSessionPath: async () => null,
  });

  await assert.rejects(() => service.send("missing", { type: "get_state" }), /Session not found/);
});

test("createNew ensure_session 不发送首条 prompt", async () => {
  const live = createFakeSession("new-1");
  const allowed = [];
  let invalidated = false;
  const service = createSessionService({
    existsSync: () => true,
    now: () => 123,
    startRpcSession: async (sessionId, sessionFile, cwd, toolNames) => {
      assert.equal(sessionId, "__new__123");
      assert.equal(sessionFile, "");
      assert.equal(cwd, "/project");
      assert.deepEqual(toolNames, ["read"]);
      return { session: live, realSessionId: "new-1" };
    },
    allowFileRoot: (root) => allowed.push(root),
    invalidateSessionListCache: () => {
      invalidated = true;
    },
  });

  const result = await service.createNew({
    cwd: "/project",
    command: {
      type: "ensure_session",
      toolNames: ["read"],
      provider: "p",
      modelId: "m",
      thinkingLevel: "low",
    },
  });

  assert.equal(result.sessionId, "new-1");
  assert.equal(result.data, null);
  assert.deepEqual(allowed, ["/project"]);
  assert.equal(invalidated, true);
  assert.deepEqual(live.calls, [
    { type: "set_model", provider: "p", modelId: "m" },
    { type: "set_thinking_level", level: "low" },
  ]);
});

// ---------------------------------------------------------------------------
// P5 工具不收窄证据：新会话默认路径不传 preset allow-list，
// 工具不被 PRESET_DEFAULT / PRESET_FULL 收窄（P0c 下线后）。
// 显式 toolNames 的兼容传递已由上方「createNew ensure_session」测试覆盖
// （toolNames: ["read"] 原样直达 startRpcSession），此处不再重复。
// ---------------------------------------------------------------------------

test("createNew 默认路径不传 toolNames：工具不被 PRESET 收窄", async () => {
  const seen = [];
  const live = createFakeSession("new-default");
  const service = createSessionService({
    existsSync: () => true,
    now: () => 456,
    startRpcSession: async (sessionId, sessionFile, cwd, toolNames) => {
      seen.push({ sessionId, sessionFile, cwd, toolNames });
      return { session: live, realSessionId: "new-default" };
    },
    allowFileRoot: () => {},
    invalidateSessionListCache: () => {},
  });

  // 默认新会话：命令不含 toolNames → startRpcSession 收到 undefined，
  // rpc-manager 侧 toolsOption 保持 undefined（不传 allow-list），SDK 注册全部工具
  const result = await service.createNew({
    cwd: "/project",
    command: { type: "ensure_session" },
  });
  assert.equal(result.sessionId, "new-default");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].toolNames, undefined);
  // ensure_session 不发送首条 prompt
  assert.deepEqual(live.calls, []);
});

test("createNew 显式 toolNames=[] 按兼容语义直达（全关，非 PRESET 收窄）", async () => {
  const seen = [];
  const live = createFakeSession("new-off");
  const service = createSessionService({
    existsSync: () => true,
    now: () => 789,
    startRpcSession: async (_sessionId, _sessionFile, _cwd, toolNames) => {
      seen.push(toolNames);
      return { session: live, realSessionId: "new-off" };
    },
    allowFileRoot: () => {},
    invalidateSessionListCache: () => {},
  });

  await service.createNew({
    cwd: "/project",
    command: { type: "ensure_session", toolNames: [] },
  });
  assert.deepEqual(seen, [[]]);
});

test("createNew 非 ensure_session：首条 prompt 提交失败时抛错，不产生假成功", async () => {
  const live = createFakeSession("new-prompt-fail");
  live.send = async (command) => {
    if (command.type === "prompt") {
      // 模拟 wrapper 提交确认：prompt 预检/配置无效时 send 抛错（P0-1）
      throw new Error('Authentication failed for "provider". Credentials may have expired.');
    }
    return { ok: true, command };
  };
  const service = createSessionService({
    existsSync: () => true,
    now: () => 2026,
    startRpcSession: async () => ({ session: live, realSessionId: "new-prompt-fail" }),
    allowFileRoot: () => {},
    invalidateSessionListCache: () => {},
  });

  // 配置无效：createNew 抛明确错误，绝不静默返回 sessionId（不产生假成功）
  await assert.rejects(
    () => service.createNew({ cwd: "/project", command: { type: "prompt", message: "hi" } }),
    /Authentication failed/,
  );
});

test("session-service / rpc-manager 启动路径不引用工具 preset 常量（静态门禁）", async () => {
  const svc = await readFile(new URL("./session-service.ts", import.meta.url), "utf8");
  const rpc = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  // P0c：preset 常量与选择器函数不得进入会话创建路径
  const presetRef = /PRESET_NONE|PRESET_DEFAULT|PRESET_FULL|getToolNamesForPreset|getPresetFromTools/;
  assert.doesNotMatch(svc, presetRef);
  assert.doesNotMatch(rpc, presetRef);

  // 默认路径（toolNames 未定义）由 SdkSessionHost 创建会话时不传 tools allow-list
  const host = await readFile(new URL("./sdk-session-host.ts", import.meta.url), "utf8");
  assert.match(host, /toolNames && toolNames\.length > 0 \? toolNames : undefined/);
  assert.match(host, /noTools: toolNames && toolNames\.length === 0 \? "all" : undefined/);
});

test("只读 subagent 的 start/send/ensureLive 都不会启动 wrapper", async () => {
  let started = 0;
  const service = createSessionService({
    listAllSessions: async () => [{ id: "child", cwd: "/tmp", path: "/tmp/child.jsonl", created: "", modified: "", messageCount: 0, firstMessage: "", readOnly: true }],
    startRpcSession: async () => { started += 1; throw new Error("不应启动"); },
    getRpcSession: () => undefined,
    resolveSessionPath: async () => "/tmp/child.jsonl",
  });
  await assert.rejects(() => service.start("child", "/tmp/child.jsonl", "/tmp"), /read-only/);
  await assert.rejects(() => service.send("child", { type: "prompt" }), /read-only/);
  await assert.rejects(() => service.ensureLive("child"), (err) => err instanceof ReadOnlySubagentError);
  assert.equal(started, 0);
});

test("getReadView：live alive 时 source=live 且不 open 磁盘", async () => {
  const live = createFakeSession("s1");
  let opened = 0;
  const service = createSessionService({
    resolveSessionPath: async (id) => (id === "s1" ? "/tmp/s1.jsonl" : null),
    getRpcSession: (id) => (id === "s1" ? live : undefined),
    openSessionManager: () => {
      opened += 1;
      throw new Error("不应 open");
    },
    startRpcSession: async () => {
      throw new Error("不应 start");
    },
  });

  const view = await service.getReadView("s1");
  assert.equal(view?.source, "live");
  assert.equal(view?.filePath, "/tmp/s1.jsonl");
  assert.equal(view?.manager.getLeafId(), "leaf-s1");
  assert.equal(opened, 0);
});

test("getReadView：无 live 或 dead 时 source=disk", async () => {
  const dead = createFakeSession("s1", { alive: false });
  const diskMgr = {
    getLeafId: () => "disk-leaf",
    getEntries: () => [],
    getTree: () => [],
    getHeader: () => null,
    getSessionName: () => undefined,
  };
  let opened = 0;
  const service = createSessionService({
    resolveSessionPath: async () => "/tmp/s1.jsonl",
    getRpcSession: () => dead,
    openSessionManager: (path) => {
      assert.equal(path, "/tmp/s1.jsonl");
      opened += 1;
      return diskMgr;
    },
  });

  const view = await service.getReadView("s1");
  assert.equal(view?.source, "disk");
  assert.equal(view?.manager.getLeafId(), "disk-leaf");
  assert.equal(opened, 1);

  const serviceNoLive = createSessionService({
    resolveSessionPath: async () => "/tmp/s1.jsonl",
    getRpcSession: () => undefined,
    openSessionManager: () => {
      opened += 1;
      return diskMgr;
    },
  });
  const view2 = await serviceNoLive.getReadView("s1");
  assert.equal(view2?.source, "disk");
  assert.equal(opened, 2);
});

test("getReadView：不存在返回 null；readOnly 不影响只读浏览", async () => {
  let started = 0;
  const serviceMissing = createSessionService({
    resolveSessionPath: async () => null,
    startRpcSession: async () => {
      started += 1;
      throw new Error("不应 start");
    },
  });
  assert.equal(await serviceMissing.getReadView("missing"), null);

  const diskMgr = {
    getLeafId: () => "ro-leaf",
    getEntries: () => [],
    getTree: () => [],
    getHeader: () => null,
    getSessionName: () => undefined,
  };
  const serviceRo = createSessionService({
    listAllSessions: async () => [{
      id: "ro",
      cwd: "/tmp",
      path: "/tmp/ro.jsonl",
      created: "",
      modified: "",
      messageCount: 0,
      firstMessage: "",
      readOnly: true,
    }],
    resolveSessionPath: async () => "/tmp/ro.jsonl",
    getRpcSession: () => undefined,
    openSessionManager: () => diskMgr,
    startRpcSession: async () => {
      started += 1;
      throw new Error("不应 start");
    },
  });
  const view = await serviceRo.getReadView("ro");
  assert.equal(view?.source, "disk");
  assert.equal(view?.manager.getLeafId(), "ro-leaf");
  assert.equal(await serviceRo.isReadOnly("ro"), true);
  assert.equal(started, 0);
});

test("getLive：alive 返回 wrapper；dead/missing 返回 undefined 且不 start", async () => {
  const live = createFakeSession("alive");
  const dead = createFakeSession("dead", { alive: false });
  let started = 0;
  const service = createSessionService({
    getRpcSession: (id) => {
      if (id === "alive") return live;
      if (id === "dead") return dead;
      return undefined;
    },
    startRpcSession: async () => {
      started += 1;
      throw new Error("不应 start");
    },
  });

  assert.equal(service.getLive("alive"), live);
  assert.equal(service.getLiveSession("alive"), live);
  assert.equal(service.getLive("dead"), undefined);
  assert.equal(service.getLive("missing"), undefined);
  assert.equal(service.isLive("alive"), true);
  assert.equal(service.isLive("dead"), false);
  assert.equal(started, 0);
});

test("ensureLive：复用 alive；否则 resolve+start；not found / readOnly 拒绝", async () => {
  const live = createFakeSession("live");
  const started = [];
  const serviceReuse = createSessionService({
    getRpcSession: (id) => (id === "live" ? live : undefined),
    startRpcSession: async () => {
      throw new Error("不应 start");
    },
  });
  assert.equal(await serviceReuse.ensureLive("live"), live);

  const fresh = createFakeSession("fresh");
  const serviceStart = createSessionService({
    getRpcSession: () => undefined,
    resolveSessionPath: async (id) => (id === "fresh" ? "/tmp/fresh.jsonl" : null),
    openSessionCwd: (path) => {
      assert.equal(path, "/tmp/fresh.jsonl");
      return "/tmp/project";
    },
    startRpcSession: async (sessionId, sessionFile, cwd) => {
      started.push({ sessionId, sessionFile, cwd });
      return { session: fresh, realSessionId: sessionId };
    },
  });
  assert.equal(await serviceStart.ensureLive("fresh"), fresh);
  assert.deepEqual(started, [{ sessionId: "fresh", sessionFile: "/tmp/fresh.jsonl", cwd: "/tmp/project" }]);

  await assert.rejects(() => serviceStart.ensureLive("missing"), /Session not found/);

  const serviceRo = createSessionService({
    listAllSessions: async () => [{
      id: "ro",
      cwd: "/tmp",
      path: "/tmp/ro.jsonl",
      created: "",
      modified: "",
      messageCount: 0,
      firstMessage: "",
      readOnly: true,
    }],
    resolveSessionPath: async () => "/tmp/ro.jsonl",
    startRpcSession: async () => {
      throw new Error("不应 start");
    },
  });
  await assert.rejects(() => serviceRo.ensureLive("ro"), (err) => err instanceof ReadOnlySubagentError);
});

test("destroy：存在则 destroy（含 dead）；不存在 no-op", () => {
  const alive = createFakeSession("a");
  const dead = createFakeSession("d", { alive: false });
  const registry = new Map([
    ["a", alive],
    ["d", dead],
  ]);
  const service = createSessionService({
    getRpcSession: (id) => registry.get(id),
  });

  service.destroy("a");
  assert.equal(alive.destroyed, true);
  service.destroy("d");
  assert.equal(dead.destroyed, true);
  assert.doesNotThrow(() => service.destroy("missing"));
});

test("appendActivity：外部 RPC live 会话先 destroy 再写盘（单写者静态门禁）", async () => {
  const svc = await readFile(new URL("./session-service.ts", import.meta.url), "utf8");
  // 仅 in-process（inner.sessionManager）可走 live.appendActivity；外部 RPC 无 inner 时 destroy
  assert.match(svc, /hasInProcessManager/);
  assert.match(svc, /inner\?\.sessionManager/);
  assert.match(svc, /awaitWriterReleased/);
  const destroyIdx = svc.indexOf("await awaitWriterReleased(sessionId)");
  const openIdx = svc.indexOf("const manager = deps.openSessionView(filePath)");
  assert.ok(destroyIdx >= 0 && openIdx >= 0 && destroyIdx < openIdx);
});

test("appendActivity：外部 RPC live 行为——destroy 后写盘且不调用 live.appendActivity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "svc-act-"));
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
  let destroyed = 0;
  let appendCalls = 0;
  const live = {
    isAlive: () => destroyed === 0,
    appendActivity: () => {
      appendCalls += 1;
      throw new Error("external appendActivity 不得被调用");
    },
    destroy: () => {
      destroyed += 1;
    },
  };
  const service = createSessionService({
    getRpcSession: () => (destroyed === 0 ? live : undefined),
    resolveSessionPath: async () => file,
    invalidateSessionListCache: () => {},
  });
  try {
    const result = await service.appendActivity("s1", {
      kind: "result",
      title: "ok",
      content: "x",
    });
    assert.ok(result.entryId);
    assert.equal(destroyed, 1);
    assert.equal(appendCalls, 0);
    assert.match(readFileSync(file, "utf8"), /pidance\.activity/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("selectLeafExact：存活 live 先 destroy 再写 sidecar（单写者行为）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "svc-leaf-live-"));
  const file = join(dir, "session.jsonl");
  const idMid = "aaaa1111";
  const idTail = "bbbb2222";
  writeFileSync(
    file,
    [
      JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
      JSON.stringify({ type: "message", id: idMid, parentId: null, message: { role: "user", content: "mid" } }),
      JSON.stringify({ type: "message", id: idTail, parentId: idMid, message: { role: "user", content: "tail" } }),
    ].join("\n"),
  );
  let destroyed = 0;
  const live = {
    isAlive: () => destroyed === 0,
    destroy: () => {
      destroyed += 1;
    },
  };
  const service = createSessionService({
    getRpcSession: () => (destroyed === 0 ? live : undefined),
    resolveSessionPath: async () => file,
    invalidateSessionListCache: () => {},
  });
  try {
    const r = await service.selectLeafExact("s1", idMid);
    assert.equal(r.cancelled, false);
    assert.equal(destroyed, 1);
    assert.equal(readLeafSidecar(file), idMid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sessions PATCH 改名：live 走 set_session_name，无 live 走磁盘（单写者静态门禁）", async () => {
  const route = await readFile(
    new URL("../app/api/sessions/[id]/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /sessionService\.renameSession/);
  assert.match(route, /sessionService\.deleteSession\(id\)/);
  const svc = await readFile(new URL("./session-service.ts", import.meta.url), "utf8");
  assert.match(svc, /clearLeafSidecar\(filePath\)/);
  assert.match(svc, /type: "set_session_name"/);
  assert.match(svc, /awaitWriterReleased/);
});

test("leaf sidecar 防过期：agent_end 清 sidecar，末尾导航清过期 sidecar（静态门禁）", async () => {
  const host = await readFile(new URL("./sdk-session-host.ts", import.meta.url), "utf8");
  const svc = await readFile(new URL("./session-service.ts", import.meta.url), "utf8");
  // 对话推进（agent_end）后清除 sidecar，避免下次 open 回退过期 leaf
  assert.match(host, /clearLeafSidecar/);
  assert.match(host, /case "agent_end"/);
  // 目标是文件末尾：必须清 sidecar
  assert.match(
    svc,
    /if \(trimmedId === sessionManager\.getLastEntryId\(\)\) \{[\s\S]*?clearLeafSidecar\(filePath\)/,
  );
});

test("selectLeafExact 末尾导航清除过期 sidecar（行为）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "svc-leaf-"));
  const file = join(dir, "session.jsonl");
  const idMid = "aaaa1111";
  const idTail = "bbbb2222";
  writeFileSync(
    file,
    [
      JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
      JSON.stringify({ type: "message", id: idMid, parentId: null, message: { role: "user", content: "mid" } }),
      JSON.stringify({ type: "message", id: idTail, parentId: idMid, message: { role: "user", content: "tail" } }),
    ].join("\n"),
  );
  const service = createSessionService({
    getRpcSession: () => undefined,
    resolveSessionPath: async () => file,
    invalidateSessionListCache: () => {},
  });
  try {
    // 旧分支指针残留（模拟此前导航到中间分支后未清理）
    writeLeafSidecar(file, idMid);
    assert.equal(readLeafSidecar(file), idMid);
    // 导航到文件末尾分支：必须清除过期 sidecar，磁盘 open 恢复文件末尾
    const r1 = await service.selectLeafExact("s1", idTail);
    assert.equal(r1.cancelled, false);
    assert.equal(readLeafSidecar(file), null);
    // 非末尾导航仍正常持久化
    const r2 = await service.selectLeafExact("s1", idMid);
    assert.equal(r2.cancelled, false);
    assert.equal(readLeafSidecar(file), idMid);
    // 目标即当前 leaf：no-op，sidecar 不变
    const r3 = await service.selectLeafExact("s1", idMid);
    assert.equal(r3.cancelled, false);
    assert.equal(readLeafSidecar(file), idMid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P1-4：rpc-manager ↔ session-service 双向循环依赖消除——注入点
// startRpcSession 的三个调用路径（ensureLive / start / createNew）都必须把
// navigation actions 传给 wrapper；动作代理到本 service 实例的方法。
// ---------------------------------------------------------------------------

test("startRpcSession 三个启动路径均注入 navigation actions，且代理到本 service 实例", async () => {
  const received = [];
  const fresh = createFakeSession("nav-fresh");
  const service = createSessionService({
    getRpcSession: () => undefined,
    resolveSessionPath: async () => "/tmp/nav.jsonl",
    openSessionCwd: () => "/tmp",
    existsSync: () => true,
    now: () => 999,
    startRpcSession: async (_sessionId, _sessionFile, _cwd, _toolNames, navigationActions) => {
      received.push(navigationActions);
      return { session: fresh, realSessionId: "nav-fresh" };
    },
    allowFileRoot: () => {},
    invalidateSessionListCache: () => {},
  });

  await service.ensureLive("nav-fresh");
  await service.start("nav-fresh", "/tmp/nav.jsonl", "/tmp");
  await service.createNew({ cwd: "/tmp", command: { type: "ensure_session" } });

  assert.equal(received.length, 3);
  for (const actions of received) {
    assert.equal(typeof actions?.selectLeafExact, "function");
    assert.equal(typeof actions?.branchFromAssistant, "function");
    assert.equal(typeof actions?.createSessionFromLeaf, "function");
  }

  // 动作代理到本 service 实例：外部 RPC 下无 live 时走磁盘 branch，
  // 假路径/缺 entry 应明确失败（非哑函数），证明注入的是 createSessionService 落地实现。
  const navService = createSessionService({
    getRpcSession: () => undefined,
    resolveSessionPath: async () => "/tmp/nav-does-not-exist.jsonl",
    openSessionCwd: () => "/tmp",
    startRpcSession: async (_sessionId, _sessionFile, _cwd, _toolNames, navigationActions) => {
      // 无 live 时走磁盘；路径/entry 无效须抛错（文案随 SessionFile 状态略有差异）
      await assert.rejects(() => navigationActions.selectLeafExact("ghost", "e1"));
      await assert.rejects(() => navigationActions.branchFromAssistant("ghost", "a1"));
      await assert.rejects(() => navigationActions.createSessionFromLeaf("ghost", "e1"));
      return { session: fresh, realSessionId: "nav-fresh" };
    },
  });
  await navService.ensureLive("nav-fresh");
});

test("httpStatusForSessionError：只读 403、缺失 404、跨进程 running 409、其余 500", () => {
  assert.equal(httpStatusForSessionError(new ReadOnlySubagentError()), 403);
  assert.equal(httpStatusForSessionError(READ_ONLY_SUBAGENT_ERROR), 403);
  assert.equal(httpStatusForSessionError(new Error("Session not found")), 404);
  assert.equal(
    httpStatusForSessionError(new Error("Session is locked by another Pidance process (writable host ownership)")),
    409,
  );
  assert.equal(httpStatusForSessionError(new Error("boom")), 500);
});


test("deleteSession：running 先 abort → await destroyAsync → unlink，成功后清队列 prefs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "svc-del-"));
  const agentDir = mkdtempSync(join(tmpdir(), "svc-del-agent-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(
    file,
    JSON.stringify({
      type: "session",
      version: 3,
      id: "s-del",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/tmp",
    }) + "\n",
  );
  let aborted = 0;
  let destroyed = 0;
  const live = {
    isAlive: () => true,
    send: async (command) => {
      if (command.type === "abort") aborted += 1;
      return { ok: true };
    },
    destroy: () => {
      destroyed += 1;
    },
    destroyAsync: async () => {
      destroyed += 1;
    },
  };
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const { updatePidancePref } = await jiti.import("./pidance-prefs-file.ts");
    updatePidancePref("sessionQueue.s-del", ["a"], agentDir);
    updatePidancePref("sessionQueueHold.s-del", true, agentDir);

    const service = createSessionService({
      listAllSessions: async () => [{
        id: "s-del", cwd: "/tmp", path: file, created: "", modified: "", messageCount: 0, firstMessage: "",
      }],
      resolveSessionPath: async () => file,
      getRpcSession: () => live,
      getRunningRpcSessionIds: () => ["s-del"],
      invalidateSessionListCache: () => {},
    });

    const result = await service.deleteSession("s-del");
    assert.equal(result.skippedSubagents, 0);
    assert.equal(aborted, 1);
    assert.equal(destroyed, 1);
    assert.equal(existsSync(file), false);

    const prefs = JSON.parse(readFileSync(join(agentDir, "pidance-preferences.json"), "utf8"));
    assert.equal(prefs.sessionQueue?.["s-del"], undefined);
    assert.equal(prefs.sessionQueueHold?.["s-del"], undefined);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("A6: getAgentState 区分 live 与 activeRun；idle live 不是 running", async () => {
  const idle = {
    ...createFakeSession("idle"),
    isRunning: () => false,
    send: async () => ({ isStreaming: false, isPromptRunning: false }),
  };
  const busy = {
    ...createFakeSession("busy"),
    isRunning: () => true,
    send: async () => ({ isStreaming: true, isPromptRunning: true }),
  };
  const service = createSessionService({
    getRpcSession: (id) => (id === "idle" ? idle : id === "busy" ? busy : undefined),
    listAllSessions: async () => [],
  });
  assert.deepEqual(await service.getAgentState("missing"), { live: false, activeRun: false });
  const idleState = await service.getAgentState("idle");
  assert.equal(idleState.live, true);
  assert.equal(idleState.activeRun, false);
  const busyState = await service.getAgentState("busy");
  assert.equal(busyState.live, true);
  assert.equal(busyState.activeRun, true);
});

test("A6: 相同 submissionId 由 Host/send 返回同一 receipt", async () => {
  const calls = [];
  const live = createFakeSession("s1");
  live.send = async (command) => {
    calls.push(command);
    return { submissionId: command.submissionId, sessionId: "s1", status: "accepted" };
  };
  const service = createSessionService({
    getRpcSession: () => live,
    listAllSessions: async () => [{ id: "s1", cwd: "/tmp", path: "/tmp/s1.jsonl", created: "", modified: "", messageCount: 0, firstMessage: "" }],
  });
  const first = await service.submitPrompt("s1", { type: "prompt", message: "hi", submissionId: "same" });
  const second = await service.submitPrompt("s1", { type: "prompt", message: "hi", submissionId: "same" });
  assert.equal(first.status, "accepted");
  assert.equal(second.submissionId, first.submissionId);
});

test("A7: destroyAsync 并发重入共享同一 dispose 完成信号", async () => {
  let disposed = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const live = {
    isAlive: () => true,
    destroy: () => {},
    destroyAsync: () => {
      disposed += 1;
      return gate;
    },
  };
  const service = createSessionService({
    getRpcSession: () => live,
    listAllSessions: async () => [],
  });
  const first = service.destroyAsync("s1");
  const second = service.destroyAsync("s1");
  release();
  await Promise.all([first, second]);
  // destroyAsync 由 Service 转发 wrapper；并发调用仍必须到达 wrapper 一次以上
  assert.ok(disposed >= 1);
});

test("A7: destroyAsync 未完成前不得打开磁盘 SessionManager", async () => {
  const dir = mkdtempSync(join(tmpdir(), "svc-hang-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, `${JSON.stringify({
    type: "session", version: 3, id: "hang", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp",
  })}\n`);
  let opened = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const live = {
    isAlive: () => true,
    destroy: () => {},
    destroyAsync: () => gate,
  };
  const { openSessionView } = await jiti.import("./pi-session-io.ts");
  const service = createSessionService({
    getRpcSession: () => live,
    resolveSessionPath: async () => file,
    listAllSessions: async () => [{ id: "hang", cwd: "/tmp", path: file, created: "", modified: "", messageCount: 0, firstMessage: "" }],
    openSessionView: (path) => {
      opened += 1;
      return openSessionView(path);
    },
    invalidateSessionListCache: () => {},
  });
  const pending = service.appendCommandEntry("hang", { command: "/x" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(opened, 0);
  release();
  await pending;
  assert.ok(opened >= 1);
  rmSync(dir, { recursive: true, force: true });
});

test("A7: wrapper 已 dead 且 dispose 未完成时 rename 仍等待 destroyPromise", async () => {
  const dir = mkdtempSync(join(tmpdir(), "svc-dead-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, `${JSON.stringify({
    type: "session", version: 3, id: "dead", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp",
  })}\n`);
  let opened = 0;
  let destroyCalls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const live = {
    isAlive: () => false,
    destroy: () => {},
    destroyAsync: () => {
      destroyCalls += 1;
      return gate;
    },
  };
  const { openSessionView } = await jiti.import("./pi-session-io.ts");
  const service = createSessionService({
    getRpcSession: () => live,
    resolveSessionPath: async () => file,
    listAllSessions: async () => [{ id: "dead", cwd: "/tmp", path: file, created: "", modified: "", messageCount: 0, firstMessage: "" }],
    openSessionView: (path) => {
      opened += 1;
      return openSessionView(path);
    },
    invalidateSessionListCache: () => {},
  });
  const pending = service.renameSession("dead", "new-name");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(destroyCalls, 1);
  assert.equal(opened, 0, "dispose 完成前不得打开磁盘 SessionManager");
  release();
  await pending;
  assert.ok(opened >= 1);
  rmSync(dir, { recursive: true, force: true });
});
