import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSessionService, ReadOnlySubagentError, httpStatusForSessionError, READ_ONLY_SUBAGENT_ERROR, projectAgentState } = await jiti.import("./session-service.ts");
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
      // #31：临时启动 key 改为唯一值（毫秒时间戳会在同毫秒并发时碰撞）
      assert.match(sessionId, /^__new__[0-9a-f-]{36}$/, "启动 key 必须是唯一 id");
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
  // 树导航的判定与落地在 session-tree-navigation（#90 起 Host 的 live 路径与 Service 的离线路径
  // 共用同一份），所以三条不变量都钉在那里：判定（两个命令）× 落地调用。
  const treeNav = await readFile(new URL("./session-tree-navigation.ts", import.meta.url), "utf8");
  // 对话推进（agent_end）后清除 sidecar，避免下次 open 回退过期 leaf
  assert.match(host, /clearLeafSidecar/);
  assert.match(host, /case "agent_end"/);
  // 目标是文件末尾：必须清 sidecar
  assert.match(treeNav, /entryId === sessionManager\.getLastEntryId\(\)[\s\S]*?clearSidecar: true/);
  assert.match(treeNav, /clearSidecar: turnEnd === sessionManager\.getLastEntryId\(\)/);
  assert.match(treeNav, /if \(plan\.clearSidecar\) clearLeafSidecar\(sessionFile\)/);
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
  assert.equal(httpStatusForSessionError(new Error("Session is being deleted")), 409);
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

test("deleteSession：删掉的子会话不留只读视图缓存", async () => {
  const root = mkdtempSync(join(tmpdir(), "svc-del-sub-"));
  const agentDir = mkdtempSync(join(tmpdir(), "svc-del-sub-agent-"));
  const stamp = "2026-01-01T00:00:00.000Z";
  const parentFile = join(root, "parent.jsonl");
  // 子代理布局：<父会话名>/<runId>/run-N/session.jsonl，父文件里有指向它的 metadata 行
  const childDir = join(root, "parent", "12345678", "run-0");
  mkdirSync(childDir, { recursive: true });
  const childFile = join(childDir, "session.jsonl");
  writeFileSync(childFile, JSON.stringify({ type: "session", version: 3, id: "child-1", timestamp: stamp, cwd: "/tmp" }) + "\n");
  writeFileSync(parentFile, [
    JSON.stringify({ type: "session", version: 3, id: "s-del-sub", timestamp: stamp, cwd: "/tmp" }),
    JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "subagent", details: { results: [{ sessionFile: childFile }] } } }),
  ].join("\n") + "\n");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const { openCachedSessionReadView, sessionReadCacheStats } = await jiti.import("./session-read-manager-cache.ts");
    openCachedSessionReadView(childFile);
    assert.equal(sessionReadCacheStats().entries, 1, "测试前提：子会话已在只读视图缓存里");

    const service = createSessionService({
      listAllSessions: async () => [],
      resolveSessionPath: async () => parentFile,
      getRpcSession: () => null,
      getRunningRpcSessionIds: () => [],
      invalidateSessionListCache: () => {},
    });

    const result = await service.deleteSession("s-del-sub");
    assert.equal(result.skippedSubagents, 0, "合法子会话应被删除");
    assert.equal(existsSync(childFile), false);
    assert.equal(sessionReadCacheStats().entries, 0, "删掉的子会话不得留在只读视图缓存里");
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(root, { recursive: true, force: true });
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


test("deleteSession：远端 writer lease 存在时拒绝 unlink，避免跨进程写入已删除文件", async () => {
  const dir = mkdtempSync(join(tmpdir(), "svc-del-remote-"));
  const agentDir = mkdtempSync(join(tmpdir(), "svc-del-remote-agent-"));
  const file = join(dir, "session.jsonl");
  const sessionId = "12345678-1234-1234-1234-123456789abc";
  writeFileSync(file, `${JSON.stringify({
    type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp",
  })}\\n`);
  mkdirSync(join(agentDir, "pidance-running-leases"), { recursive: true });
  writeFileSync(join(agentDir, "pidance-running-leases", `${sessionId}.json`), JSON.stringify({
    pid: 1, sessionId, heartbeatAt: Date.now(), startedAt: Date.now() - 100,
  }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const service = createSessionService({
      listAllSessions: async () => [{ id: sessionId, cwd: "/tmp", path: file, created: "", modified: "", messageCount: 0, firstMessage: "" }],
      resolveSessionPath: async () => file,
      getRpcSession: () => undefined,
      waitForSessionStart: async () => null,
      archiveAgentDir: () => agentDir,
      invalidateSessionListCache: () => {},
    });
    const state = await service.getAgentState(sessionId);
    assert.deepEqual(state, { live: false, activeRun: false, lockedByOther: true });
    await assert.rejects(
      () => service.deleteSession(sessionId),
      (error) => error instanceof Error && error.message.includes("locked by another Pidance process"),
    );
    assert.equal(existsSync(file), true);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("deleteSession：文件已不存在时幂等完成，不把 ENOENT 变成服务错误", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "svc-del-missing-agent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const service = createSessionService({
      listAllSessions: async () => [],
      resolveSessionPath: async () => null,
      getRpcSession: () => undefined,
      waitForSessionStart: async () => null,
      archiveAgentDir: () => agentDir,
      invalidateSessionListCache: () => {},
    });
    const result = await service.deleteSession("missing-session");
    assert.deepEqual(result, { skippedSubagents: 0 });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("deleteSession：删除进行中阻止新的 ensureLive，避免 unlink 后继续启动 writer", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "svc-del-lock-agent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let release;
  const startGate = new Promise((resolve) => { release = resolve; });
  try {
    const service = createSessionService({
      listAllSessions: async () => [],
      resolveSessionPath: async () => null,
      getRpcSession: () => undefined,
      waitForSessionStart: async () => startGate,
      archiveAgentDir: () => agentDir,
      invalidateSessionListCache: () => {},
    });
    const deleting = service.deleteSession("deleting-session");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await assert.rejects(
      () => service.ensureLive("deleting-session"),
      /Session is being deleted/,
    );
    release();
    assert.deepEqual(await deleting, { skippedSubagents: 0 });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("deleteSession：同一会话并发 DELETE 单飞，第二次不重复 unlink", async () => {
  const dir = mkdtempSync(join(tmpdir(), "svc-del-race-"));
  const agentDir = mkdtempSync(join(tmpdir(), "svc-del-race-agent-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, `${JSON.stringify({
    type: "session", version: 3, id: "race-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp",
  })}\n`);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let pathResolutions = 0;
  try {
    const service = createSessionService({
      listAllSessions: async () => [{ id: "race-session", cwd: "/tmp", path: file, created: "", modified: "", messageCount: 0, firstMessage: "" }],
      resolveSessionPath: async () => {
        pathResolutions += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return file;
      },
      getRpcSession: () => undefined,
      waitForSessionStart: async () => null,
      archiveAgentDir: () => agentDir,
      invalidateSessionListCache: () => {},
    });
    const results = await Promise.all([
      service.deleteSession("race-session"),
      service.deleteSession("race-session"),
    ]);
    assert.deepEqual(results[0], { skippedSubagents: 0 });
    assert.deepEqual(results[1], { skippedSubagents: 0 });
    assert.equal(pathResolutions, 1, "同一会话删除应共享 in-flight 操作");
    assert.equal(existsSync(file), false);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("projectAgentState：light 只剥离 systemPrompt，其余字段原样", () => {
  const state = {
    isBashRunning: true,
    isStreaming: false,
    thinkingLevel: "high",
    systemPrompt: "x".repeat(30_000),
  };
  const light = projectAgentState(state, { light: true });
  assert.equal(light.systemPrompt, undefined, "systemPrompt 是最大且几乎不变的字段");
  assert.equal(light.isBashRunning, true);
  assert.equal(light.thinkingLevel, "high", "运行标志与档位必须保留");
  // 语义：键缺失 = 本次不更新，消费方不会把已有值清掉。
  assert.equal("systemPrompt" in light, false);
});

test("projectAgentState：非 light、非法输入一律原样返回", () => {
  const state = { systemPrompt: "keep", isStreaming: true };
  assert.deepEqual(projectAgentState(state), state);
  assert.deepEqual(projectAgentState(state, { light: false }), state);
  assert.equal(projectAgentState(null, { light: true }), null);
  assert.equal(projectAgentState(undefined, { light: true }), undefined);
  assert.deepEqual(projectAgentState(["a"], { light: true }), ["a"]);
});

// ---------------------------------------------------------------------------
// Issue #29：导航交接与 writer busy
// 从导航命令内部调用 destroyAsync 会等这条命令自己结束（自等待死锁），
// 因此由发起命令的 Host 显式传入 handoff；离线写必须先 await 它。
// ---------------------------------------------------------------------------

test("导航交接：Service 先 await host 的 handoff，再打开磁盘 SessionManager", async () => {
  const dir = mkdtempSync(join(tmpdir(), "svc-handoff-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, `${JSON.stringify({
    type: "session", version: 3, id: "ho", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp",
  })}\n`);
  const order = [];
  const { openSessionView } = await jiti.import("./pi-session-io.ts");
  try {
    const service = createSessionService({
      getRpcSession: () => undefined,
      resolveSessionPath: async () => file,
      openSessionView: (path) => {
        order.push("open");
        return openSessionView(path);
      },
      listAllSessions: async () => [],
      invalidateSessionListCache: () => {},
    });
    await assert.rejects(
      () => service.selectLeafExact("ho", "missing-entry", { handoff: async () => { order.push("handoff"); } }),
      /not found/,
    );
    assert.deepEqual(order, ["handoff", "open"], "必须先交出 writer 再开磁盘 writer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("离线写 busy 映射 409：命令仍在进行时 fail closed", async () => {
  const { SESSION_WRITER_BUSY_MESSAGE } = await jiti.import("./sdk-session-host.ts");
  assert.equal(httpStatusForSessionError(new Error(SESSION_WRITER_BUSY_MESSAGE)), 409);
});


// ---------------------------------------------------------------------------
// Issue #31：新建会话的提交事务与显式取消
//
// 现状缺口：createAndPrompt 只在响应返回后才知道真实 sessionId；真实 id 未返回
// 时 Stop 只能取消本地 fetch，服务端仍可能继续跑；新建临时 key 用毫秒时间戳，
// 同毫秒并发会合并到同一 host。下面先固定目标行为。
// ---------------------------------------------------------------------------

/** 可控的 fake host：send 行为可注入，便于模拟预检/启动各阶段。 */
function createControllableSession(id, onSend) {
  const calls = [];
  let destroyed = false;
  return {
    id,
    isAlive: () => !destroyed,
    isRunning: () => false,
    send: async (command) => {
      calls.push(command);
      return onSend ? onSend(command) : { ok: true };
    },
    destroy: () => { destroyed = true; },
    destroyAsync: async () => { destroyed = true; },
    inner: { sessionManager: { getLeafId: () => null, getEntries: () => [], getSessionFile: () => `/tmp/${id}.jsonl` } },
    calls,
    get destroyed() { return destroyed; },
  };
}

test("#31 新建临时启动 key 唯一：同毫秒不同 cwd 不合并到同一 host", async () => {
  const seen = [];
  const service = createSessionService({
    existsSync: () => true,
    now: () => 1_700_000_000_000, // 固定同一毫秒
    startRpcSession: async (sessionId, _file, cwd) => {
      seen.push({ sessionId, cwd });
      return { session: createControllableSession(`s-${seen.length}`), realSessionId: `s-${seen.length}` };
    },
    allowFileRoot: () => {},
    invalidateSessionListCache: () => {},
  });

  await service.createNew({ cwd: "/a", command: { type: "ensure_session" } });
  await service.createNew({ cwd: "/b", command: { type: "ensure_session" } });

  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].sessionId, seen[1].sessionId, "同一毫秒的两个新建不得共用启动 key");
  assert.deepEqual(seen.map((s) => s.cwd), ["/a", "/b"], "cwd 不得混用");
});

test("#31 提交可查询：登记 submission 后能按 id 查到状态", async () => {
  const live = createControllableSession("sub-1", () => ({ status: "accepted" }));
  const service = createSessionService({
    existsSync: () => true,
    now: () => 1,
    startRpcSession: async () => ({ session: live, realSessionId: "sub-1" }),
    allowFileRoot: () => {},
    invalidateSessionListCache: () => {},
  });

  const result = await service.createNew({
    cwd: "/project",
    command: { type: "prompt", message: "hi", submissionId: "sub-abc" },
  });
  assert.equal(result.sessionId, "sub-1");

  const info = service.getSubmission("sub-abc");
  assert.ok(info, "提交必须可查询");
  assert.equal(info.sessionId, "sub-1");
  assert.ok(["accepted", "running", "completed"].includes(info.status), `非预期状态 ${info.status}`);
});

test("#31 取消先到：晚到的同 id 创建不得启动 prompt", async () => {
  let sent = null;
  const live = createControllableSession("sub-cancel-first", (command) => {
    if (command.type === "prompt") sent = command;
    return { status: "accepted" };
  });
  const service = createSessionService({
    existsSync: () => true,
    now: () => 1,
    startRpcSession: async () => ({ session: live, realSessionId: "sub-cancel-first" }),
    allowFileRoot: () => {},
    invalidateSessionListCache: () => {},
  });

  // 取消先到（tomstone 有界保留）
  const cancelResult = await service.cancelSubmission("sub-late");
  assert.ok(cancelResult, "取消请求必须被受理");
  assert.equal(cancelResult.status, "pending", "未落地时只能报 pending，不冒充已停止");

  // 晚到的创建必须被可辨地拒绝（而不是静默启动一个已被取消的运行）
  await assert.rejects(
    () => service.createNew({
      cwd: "/project",
      command: { type: "prompt", message: "should not run", submissionId: "sub-late" },
    }),
    /cancelled/i,
  );
  assert.equal(sent, null, "已取消的提交不得启动 prompt");
});

test("#31 取消发生在启动阶段：startRpcSession 之后不得继续提交 prompt", async () => {
  let releaseStart;
  const gate = new Promise((resolve) => { releaseStart = resolve; });
  let promptSent = false;
  const live = createControllableSession("sub-start-cancel", (command) => {
    if (command.type === "prompt") promptSent = true;
    return { status: "accepted" };
  });
  const service = createSessionService({
    existsSync: () => true,
    now: () => 1,
    startRpcSession: async () => {
      await gate;
      return { session: live, realSessionId: "sub-start-cancel" };
    },
    allowFileRoot: () => {},
    invalidateSessionListCache: () => {},
  });

  const createPromise = service.createNew({
    cwd: "/project",
    command: { type: "prompt", message: "hi", submissionId: "sub-start" },
  });
  await new Promise((r) => setTimeout(r, 20));
  await service.cancelSubmission("sub-start");
  releaseStart();

  await createPromise.catch(() => {});
  assert.equal(promptSent, false, "启动阶段被取消后不得再发 prompt");
});

test("#31 受理后响应未回时取消：作用于原运行，不误伤后续新一轮", async () => {
  const aborts = [];
  const live = createControllableSession("sub-inflight", (command) => {
    if (command.type === "abort") aborts.push(command);
    return { status: "accepted" };
  });
  // 取消只作用于**已存在的 live host**；夹具必须让它可见（生产即 registry 里的 host）。
  const service = createSessionService({
    existsSync: () => true,
    now: () => 1,
    startRpcSession: async () => ({ session: live, realSessionId: "sub-inflight" }),
    getRpcSession: (id) => (id === "sub-inflight" ? live : undefined),
    allowFileRoot: () => {},
    invalidateSessionListCache: () => {},
  });

  await service.createNew({
    cwd: "/project",
    command: { type: "prompt", message: "hi", submissionId: "sub-run-1" },
  });
  const cancel = await service.cancelSubmission("sub-run-1");
  assert.ok(cancel);
  assert.equal(aborts.length, 1, "取消必须对原运行发 abort，且只发一次");
  assert.equal(cancel.status, "confirmed");

  // 新一轮（不同 submissionId）不受旧取消影响
  await service.createNew({
    cwd: "/project",
    command: { type: "prompt", message: "next", submissionId: "sub-run-2" },
  });
  assert.equal(aborts.length, 1, "旧取消不得误停新一轮");
});

test("#31 同 id 重复创建复用一个事务；不同内容复用 id 返回冲突", async () => {
  let promptCount = 0;
  const live = createControllableSession("sub-dedupe", (command) => {
    if (command.type === "prompt") promptCount += 1;
    return { status: "accepted" };
  });
  const service = createSessionService({
    existsSync: () => true,
    now: () => 1,
    startRpcSession: async () => ({ session: live, realSessionId: "sub-dedupe" }),
    allowFileRoot: () => {},
    invalidateSessionListCache: () => {},
  });

  const first = await service.createNew({
    cwd: "/project",
    command: { type: "prompt", message: "same", submissionId: "sub-dup" },
  });
  const second = await service.createNew({
    cwd: "/project",
    command: { type: "prompt", message: "same", submissionId: "sub-dup" },
  });
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(promptCount, 1, "同 id 同内容不得重复投递");

  await assert.rejects(
    () => service.createNew({
      cwd: "/project",
      command: { type: "prompt", message: "DIFFERENT", submissionId: "sub-dup" },
    }),
    /conflict|already/i,
    "同 id 不同内容必须冲突",
  );
});

test("#31 取消未登记的提交：登记 tombstone 并只报 pending", async () => {
  const service = createSessionService({
    existsSync: () => true,
    allowFileRoot: () => {},
    invalidateSessionListCache: () => {},
  });
  const result = await service.cancelSubmission("never-seen");
  assert.equal(result.status, "pending", "未确认停掉任何东西时不得报 confirmed");
  const info = service.getSubmission("never-seen");
  assert.ok(info, "取消必须留下可查询的 tombstone");
  assert.equal(info.status, "cancelled");
});

// ── 搜索范围过滤用 stale 目录（不随 agent 活动同步重建目录） ───────────────

test("searchFulltext：归档范围过滤取 stale 目录，不触发同步重建", async () => {
  const base = mkdtempSync(join(tmpdir(), "pidance-search-stale-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(base, "agent");
  const seen = [];
  try {
    const service = createSessionService({
      listAllSessions: async (options) => {
        seen.push(options);
        return [];
      },
    });

    const result = await service.searchFulltext("nothing-matches-here", { scope: "active" });
    assert.deepEqual(seen, [{ allowStale: true }], "范围过滤只允许用 stale 目录");
    assert.deepEqual(result.sessionIds, []);
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(base, { recursive: true, force: true });
  }
});

test("searchFulltext：scope=all 不读目录", async () => {
  const seen = [];
  const service = createSessionService({
    listAllSessions: async (options) => {
      seen.push(options);
      return [];
    },
  });
  await service.searchFulltext("nothing-matches-here", { scope: "all" });
  assert.deepEqual(seen, [], "scope=all 不需要目录投影");
});

test("getContextPage / getNavigationSnapshot：插件自定义 entry 经注入渲染器进入时间线（issue #71）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pidance-plugin-entry-"));
  try {
    const filePath = join(dir, "session.jsonl");
    const entries = [
      { type: "session", version: 3, id: "qa-plugin-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir },
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: "2026-01-01T00:00:01.000Z" },
      },
      {
        type: "custom",
        id: "x1",
        parentId: "u1",
        timestamp: "2026-01-01T00:00:02.000Z",
        customType: "qa.supervisor",
        data: { text: "reply" },
      },
    ];
    writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");

    const withRenderer = createSessionService({
      resolveSessionPath: async () => filePath,
      getRpcSession: () => undefined,
      resolveEntryLinesProvider: async () => (entry) => [`rendered ${entry.customType}`],
    });
    const page = await withRenderer.getContextPage("qa-plugin-session", { limit: 50 });
    const projected = page.context.messages.find((m) => m.customType === "qa.supervisor");
    assert.ok(projected, "注入渲染器后自定义 entry 必须进入时间线");
    assert.equal(projected.role, "custom");
    assert.deepEqual(projected.renderedLines, ["rendered qa.supervisor"]);

    // 同一个 service 的导航快照路径（/api/sessions/<id>）也是同一口径
    const snapshot = await withRenderer.getNavigationSnapshot("qa-plugin-session", {});
    const snapshotEntry = snapshot.context.messages.find((m) => m.customType === "qa.supervisor");
    assert.ok(snapshotEntry, "导航快照同样要带上渲染行");
    assert.deepEqual(snapshotEntry.renderedLines, ["rendered qa.supervisor"]);

    // 解析不到渲染器（插件没注册 / 扩展加载失败）→ 不投影，与历史行为一致
    const withoutRenderer = createSessionService({
      resolveSessionPath: async () => filePath,
      getRpcSession: () => undefined,
      resolveEntryLinesProvider: async () => null,
    });
    const plainPage = await withoutRenderer.getContextPage("qa-plugin-session", { limit: 50 });
    assert.equal(plainPage.context.messages.some((m) => m.customType === "qa.supervisor"), false);
    // 用户消息照常在（不因自定义 entry 不投影而丢内容）
    assert.equal(plainPage.context.messages.filter((m) => m.role === "user").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// 客户端把首屏拿到的**导航 leaf**（已从 context_edit 尾上溯）回传分页时，投影必须改用原始 leaf，
// 否则 SDK 写在链尾的 context_edit 不在路径上，「省略 / 替换」在分页与刷新里静默失效。
test("getContextPage：回传导航 leaf 时仍应用停在链尾的 context_edit", async () => {
  const entries = [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hi" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", provider: "t", model: "m", content: [{ type: "text", text: "original" }] } },
    { type: "context_edit", id: "ce1", parentId: "a1", timestamp: "2026-01-01T00:00:02.000Z", targetId: "a1", replacement: null },
  ];
  const manager = {
    getEntries: () => entries,
    getLeafId: () => "ce1",
    getTree: () => [],
    getHeader: () => ({ id: "live-1", cwd: "/tmp" }),
    getSessionName: () => "live-1",
  };
  const service = createSessionService({
    resolveSessionPath: async () => "/tmp/s.jsonl",
    getRpcSession: () => ({ isAlive: () => true, inner: { sessionManager: manager } }),
  });
  const page = await service.getContextPage("live-1", { leafId: "a1" });
  assert.deepEqual(page.context.entryIds, ["u1"]);
});
test("工具显示元数据：会话头读不出来只是没有元数据，不是投影失败（issue #75 修复轮）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "svc-meta-header-"));
  const file = join(dir, "session.jsonl");
  const entries = [
    { type: "session", version: 3, id: "meta-header", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "run it" }], timestamp: 1 },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "assistant",
        provider: "test",
        model: "test-model",
        content: [{ type: "toolCall", id: "t1", name: "mcp", arguments: { command: "status" } }],
      },
    },
  ];
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  const { openSessionManager } = await jiti.import("./pi-session-io.ts");
  const manager = openSessionManager(file);
  assert.ok(manager.getEntries().length >= 2, "前置：entries 本身要读得出来");

  // 投影里读会话头的那个路径指向目录（openSync → EISDIR）：修复前它抛在 try 外，
  // 整条只读投影会变成 500；修复后只是「这次没有元数据」，客户端回退工具名格式化。
  const unreadableHeader = join(dir, "not-a-file");
  mkdirSync(unreadableHeader, { recursive: true });

  let providerCalls = 0;
  const service = createSessionService({
    getRpcSession: () => undefined,
    resolveSessionPath: async () => unreadableHeader,
    openSessionManager: () => manager,
    resolveToolMetaProvider: async () => {
      providerCalls += 1;
      return (toolName) => (toolName === "mcp" ? { label: "MCP" } : null);
    },
  });

  const page = await service.getContextPage("meta-header", { limit: 50 });
  assert.ok(page.context, "会话头读不出来不能把只读投影变成失败");
  assert.ok(page.context.entryIds.includes("a1"), "投影内容不受影响（工具调用那条仍在）");
  assert.equal(providerCalls, 0, "头读不出来就不该去加载扩展");
  rmSync(dir, { recursive: true, force: true });
});
