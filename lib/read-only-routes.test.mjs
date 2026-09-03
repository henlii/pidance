import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { sessionService } = await jiti.import("@/lib/session-service");
const { POST: agentPost } = await jiti.import("../app/api/agent/[id]/route.ts");
const { GET: eventsGet } = await jiti.import("../app/api/agent/[id]/events/route.ts");
const { PATCH: sessionPatch, DELETE: sessionDelete } = await jiti.import("../app/api/sessions/[id]/route.ts");
const { POST: autoNamePost } = await jiti.import("../app/api/sessions/[id]/auto-name/route.ts");
const { GET: stateGet } = await jiti.import("../app/api/sessions/[id]/state/route.ts");

const params = { params: Promise.resolve({ id: "readonly-session" }) };
const request = (body) => new Request("http://localhost/api/test", {
  method: body === undefined ? "GET" : "POST",
  ...(body === undefined ? {} : {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }),
});

async function assertReadOnly(response) {
  const body = await response.json();
  assert.equal(response.status, 403, JSON.stringify(body));
  assert.deepEqual(body, { error: "Subagent sessions are read-only" });
}

test("只读 session 的写 route 直接返回 403 且不进入写路径", async () => {
  const originalIsReadOnly = sessionService.isReadOnly;
  const originalSend = sessionService.send;
  const originalStart = sessionService.start;
  const originalEnsureLive = sessionService.ensureLive;
  let writes = 0;
  sessionService.isReadOnly = async () => true;
  // 真实 ensureLive 会经 isReadOnly 门禁；此处再包一层确认 route 未绕过
  sessionService.ensureLive = async (id) => {
    if (await sessionService.isReadOnly(id)) {
      const { ReadOnlySubagentError } = await jiti.import("@/lib/session-service");
      throw new ReadOnlySubagentError();
    }
    writes++;
    throw new Error("写路径不应执行");
  };
  sessionService.send = async () => { writes++; throw new Error("写路径不应执行"); };
  sessionService.start = async () => { writes++; throw new Error("写路径不应执行"); };

  try {
    await assertReadOnly(await agentPost(request({ type: "prompt", message: "test" }), params));
    await assertReadOnly(await eventsGet(new Request("http://localhost/api/test"), params));
    await assertReadOnly(await sessionPatch(request({ name: "new name" }), params));
    await assertReadOnly(await sessionDelete(new Request("http://localhost/api/test", { method: "DELETE" }), params));
    await assertReadOnly(await autoNamePost(new Request("http://localhost/api/test", { method: "POST" }), params));
    assert.equal(writes, 0);
  } finally {
    sessionService.isReadOnly = originalIsReadOnly;
    sessionService.send = originalSend;
    sessionService.start = originalStart;
    sessionService.ensureLive = originalEnsureLive;
  }
});

test("events GET 不会把门禁内部异常伪装成 403", async () => {
  const originalIsReadOnly = sessionService.isReadOnly;
  sessionService.isReadOnly = async () => { throw new Error("门禁内部错误"); };
  try {
    const response = await eventsGet(new Request("http://localhost/api/test"), params);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "门禁内部错误" });
  } finally {
    sessionService.isReadOnly = originalIsReadOnly;
  }
});

test("state GET：readOnly 时不调用 getLive/ensureLive（源码契约 + stub）", async () => {
  const originalIsReadOnly = sessionService.isReadOnly;
  const originalGetLive = sessionService.getLive;
  const originalEnsureLive = sessionService.ensureLive;
  let ensureCalls = 0;
  let getLiveCalls = 0;
  sessionService.isReadOnly = async () => true;
  sessionService.getLive = () => {
    getLiveCalls += 1;
    return undefined;
  };
  sessionService.ensureLive = async () => {
    ensureCalls += 1;
    throw new Error("不应 ensureLive");
  };

  try {
    const response = await stateGet(new Request("http://localhost/api/test"), params);
    // 无真实 session 文件 → 404（在 isReadOnly 之前）；有文件 → readOnly 响应
    if (response.status === 200) {
      assert.deepEqual(await response.json(), { live: false, activeRun: false, readOnly: true });
      assert.equal(getLiveCalls, 0);
    } else {
      assert.equal(response.status, 404);
    }
    assert.equal(ensureCalls, 0);
  } finally {
    sessionService.isReadOnly = originalIsReadOnly;
    sessionService.getLive = originalGetLive;
    sessionService.ensureLive = originalEnsureLive;
  }
});

test("state GET：非 readOnly 且无 live 时不 ensureLive", async () => {
  const originalIsReadOnly = sessionService.isReadOnly;
  const originalGetLive = sessionService.getLive;
  const originalEnsureLive = sessionService.ensureLive;
  let ensureCalls = 0;
  sessionService.isReadOnly = async () => false;
  sessionService.getLive = () => undefined;
  sessionService.ensureLive = async () => {
    ensureCalls += 1;
    throw new Error("不应 ensureLive");
  };

  try {
    const response = await stateGet(new Request("http://localhost/api/test"), {
      params: Promise.resolve({ id: "no-live-session" }),
    });
    if (response.status === 200) {
      assert.deepEqual(await response.json(), { live: false, activeRun: false });
    } else {
      assert.equal(response.status, 404);
    }
    assert.equal(ensureCalls, 0);
  } finally {
    sessionService.isReadOnly = originalIsReadOnly;
    sessionService.getLive = originalGetLive;
    sessionService.ensureLive = originalEnsureLive;
  }
});

test("events GET：无本进程 live 时不启动 host，返回 404", async () => {
  const originalIsReadOnly = sessionService.isReadOnly;
  const originalGetLive = sessionService.getLive;
  sessionService.isReadOnly = async () => false;
  sessionService.getLive = () => undefined;
  try {
    const response = await eventsGet(new Request("http://localhost/api/test"), {
      params: Promise.resolve({ id: "no-live" }),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Agent is not live" });
  } finally {
    sessionService.isReadOnly = originalIsReadOnly;
    sessionService.getLive = originalGetLive;
  }
});

test("Issue #6 相关 route 不再同时 import session-service 与 rpc-manager", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const routes = [
    "app/api/sessions/[id]/route.ts",
    "app/api/sessions/[id]/context/route.ts",
    "app/api/sessions/[id]/state/route.ts",
    "app/api/sessions/[id]/auto-name/route.ts",
    "app/api/agent/[id]/events/route.ts",
  ];
  for (const rel of routes) {
    const src = readFileSync(`${root}${rel}`, "utf8");
    assert.match(src, /session-service/, `${rel} 应依赖 session-service`);
    assert.equal(
      /from ["']@\/lib\/rpc-manager["']/.test(src),
      false,
      `${rel} 不得 import rpc-manager`,
    );
  }
});

test("sessions GET/context 使用 getReadView；state 使用 getLive 不 ensureLive（源码）", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const sessionRoute = readFileSync(`${root}app/api/sessions/[id]/route.ts`, "utf8");
  assert.match(sessionRoute, /getNavigationSnapshot/);
  assert.match(sessionRoute, /sessionService\.(destroy|deleteSession)/);
  assert.doesNotMatch(sessionRoute, /getRpcSession|startRpcSession|resolveSessionManagerForRead/);

  const contextRoute = readFileSync(`${root}app/api/sessions/[id]/context/route.ts`, "utf8");
  assert.match(contextRoute, /getContextPage/);
  assert.doesNotMatch(contextRoute, /getReadView|getRpcSession|resolveSessionManagerForRead|session-reader/);

  const stateRoute = readFileSync(`${root}app/api/sessions/[id]/state/route.ts`, "utf8");
  assert.match(stateRoute, /getAgentState/);
  assert.match(stateRoute, /ensureLive/);
  assert.doesNotMatch(stateRoute, /getRpcSession|startRpcSession/);

  const autoName = readFileSync(`${root}app/api/sessions/[id]/auto-name/route.ts`, "utf8");
  assert.match(autoName, /autoNameSession/);
  assert.doesNotMatch(autoName, /getRpcSession|startRpcSession|ensureLive/);

  const exportRoute = readFileSync(`${root}app/api/sessions/[id]/export/route.ts`, "utf8");
  assert.match(exportRoute, /sessionService\.exportSession/);
  assert.doesNotMatch(exportRoute, /patchExportHtml|execFile|pi-session-io|session-reader/);


  const events = readFileSync(`${root}app/api/agent/[id]/events/route.ts`, "utf8");
  assert.match(events, /sessionService\.getLive/);
  assert.doesNotMatch(events, /ensureLive|getRpcSession|startRpcSession/);
});
