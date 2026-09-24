/**
 * 扩展自持活注册表：查询语义与 fail-closed。
 *
 * 作用域口径（与上游一致）：`sessionId` 必填，`sessionFile` 可选，按 id 或文件命中。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  clearSessionLivenessProviders,
  hasActiveExternalWork,
  listSessionLivenessProviders,
  registerSessionLiveness,
} = await jiti.import("./session-liveness.ts");

/** 会话 A / B 的身份（宿主查询时两项都给）。 */
const SESSION_A = { sessionId: "id-a", sessionFile: "/tmp/a.jsonl" };
const SESSION_B = { sessionId: "id-b", sessionFile: "/tmp/b.jsonl" };

test("注册即生效，注销后立即失效", () => {
  clearSessionLivenessProviders();
  let active = true;
  const unregister = registerSessionLiveness({ name: "mcp", sessionId: SESSION_A.sessionId, isActive: () => active });
  assert.equal(hasActiveExternalWork(SESSION_A), true);
  assert.deepEqual(listSessionLivenessProviders(), ["mcp"]);
  active = false;
  assert.equal(hasActiveExternalWork(SESSION_A), false);
  unregister();
  assert.deepEqual(listSessionLivenessProviders(), []);
});

test("按 sessionId 命中：另一个会话不受影响", () => {
  clearSessionLivenessProviders();
  registerSessionLiveness({ name: "scoped-by-id", sessionId: "id-a", isActive: () => true });
  assert.equal(hasActiveExternalWork(SESSION_A), true);
  assert.equal(hasActiveExternalWork(SESSION_B), false, "别的会话不能被无关键住");
  clearSessionLivenessProviders();
});

test("按 sessionFile 命中（只给文件也算本会话）", () => {
  clearSessionLivenessProviders();
  registerSessionLiveness({
    name: "scoped-by-file",
    sessionId: "id-other",
    sessionFile: "/tmp/a.jsonl",
    isActive: () => true,
  });
  assert.equal(hasActiveExternalWork(SESSION_A), true);
  assert.equal(hasActiveExternalWork(SESSION_B), false);
  clearSessionLivenessProviders();
});

test("两条身份都不命中就不算本会话（不再有「省略就对所有会话生效」）", () => {
  clearSessionLivenessProviders();
  registerSessionLiveness({ name: "elsewhere", sessionId: "id-x", sessionFile: "/tmp/x.jsonl", isActive: () => true });
  assert.equal(hasActiveExternalWork(SESSION_A), false);
  assert.equal(hasActiveExternalWork(SESSION_B), false);
  clearSessionLivenessProviders();
});

test("fail-closed：provider 抛错按不活跃处理，且只告警一次", () => {
  clearSessionLivenessProviders();
  registerSessionLiveness({
    name: "broken",
    sessionId: SESSION_A.sessionId,
    isActive: () => {
      throw new Error("provider exploded");
    },
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.equal(hasActiveExternalWork(SESSION_A), false, "抛错不得让会话被永久保活");
    assert.equal(hasActiveExternalWork(SESSION_A), false);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1, "空闲窗口每轮都会问，不能每轮刷日志");
  clearSessionLivenessProviders();
});

test("同一会话有多个 provider 时，任一为真即保活", () => {
  clearSessionLivenessProviders();
  registerSessionLiveness({ name: "idle-one", sessionId: SESSION_A.sessionId, isActive: () => false });
  registerSessionLiveness({ name: "busy-one", sessionId: SESSION_A.sessionId, isActive: () => true });
  assert.equal(hasActiveExternalWork(SESSION_A), true);
  clearSessionLivenessProviders();
});

test("只认严格 true：返回真值但非布尔一律按不活跃（fail-closed）", () => {
  clearSessionLivenessProviders();
  registerSessionLiveness({ name: "truthy", sessionId: SESSION_A.sessionId, isActive: () => "yes" });
  assert.equal(hasActiveExternalWork(SESSION_A), false);
  clearSessionLivenessProviders();
});

test("形状非法的注册被忽略（缺 sessionId 也算非法），不抛错、不进注册表", () => {
  clearSessionLivenessProviders();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.doesNotThrow(() => {
      registerSessionLiveness({ name: "", sessionId: SESSION_A.sessionId, isActive: () => true });
      registerSessionLiveness({ name: "no-session-id", isActive: () => true });
      registerSessionLiveness({ name: "no-isActive", sessionId: SESSION_A.sessionId });
      registerSessionLiveness(null);
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(listSessionLivenessProviders(), []);
});

test("同名重复注册各自独立：先返回的注销不会删掉后注册的", () => {
  clearSessionLivenessProviders();
  const unregisterFirst = registerSessionLiveness({ name: "dup", sessionId: SESSION_A.sessionId, isActive: () => false });
  registerSessionLiveness({ name: "dup", sessionId: SESSION_A.sessionId, isActive: () => true });
  assert.deepEqual(listSessionLivenessProviders(), ["dup", "dup"], "各自一份，不互相覆盖");
  assert.equal(hasActiveExternalWork(SESSION_A), true);

  unregisterFirst();
  assert.equal(hasActiveExternalWork(SESSION_A), true, "后注册的仍必须在册");
  assert.deepEqual(listSessionLivenessProviders(), ["dup"]);
  clearSessionLivenessProviders();
});

test("注销幂等：重复调用不抛错", () => {
  clearSessionLivenessProviders();
  const unregister = registerSessionLiveness({ name: "once", sessionId: SESSION_A.sessionId, isActive: () => true });
  unregister();
  assert.doesNotThrow(() => unregister());
  assert.deepEqual(listSessionLivenessProviders(), []);
});

test("查询身份两项都缺时不保活（宿主没给身份就不猜作用域）", () => {
  clearSessionLivenessProviders();
  registerSessionLiveness({ name: "any", sessionId: SESSION_A.sessionId, isActive: () => true });
  assert.equal(hasActiveExternalWork({}), false);
  clearSessionLivenessProviders();
});
