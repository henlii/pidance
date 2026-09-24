/**
 * 扩展自持活注册表：查询语义与 fail-closed。
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

test("注册即生效，注销后立即失效", () => {
  clearSessionLivenessProviders();
  let active = true;
  const unregister = registerSessionLiveness({ name: "mcp", isActive: () => active });
  assert.equal(hasActiveExternalWork("/tmp/s.jsonl"), true);
  assert.deepEqual(listSessionLivenessProviders(), ["mcp"]);
  active = false;
  assert.equal(hasActiveExternalWork("/tmp/s.jsonl"), false);
  unregister();
  assert.deepEqual(listSessionLivenessProviders(), []);
});

test("sessionFile 限定：只对本会话生效", () => {
  clearSessionLivenessProviders();
  registerSessionLiveness({ name: "scoped", sessionFile: "/tmp/other.jsonl", isActive: () => true });
  assert.equal(hasActiveExternalWork("/tmp/s.jsonl"), false);
  assert.equal(hasActiveExternalWork("/tmp/other.jsonl"), true);
  clearSessionLivenessProviders();
});

test("fail-closed：provider 抛错按不活跃处理，且只告警一次", () => {
  clearSessionLivenessProviders();
  registerSessionLiveness({
    name: "broken",
    isActive: () => {
      throw new Error("provider exploded");
    },
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.equal(hasActiveExternalWork("/tmp/s.jsonl"), false, "抛错不得让会话被永久保活");
    assert.equal(hasActiveExternalWork("/tmp/s.jsonl"), false);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1, "空闲窗口每轮都会问，不能每轮刷日志");
  clearSessionLivenessProviders();
});

test("同一会话有多个 provider 时，任一为真即保活", () => {
  clearSessionLivenessProviders();
  registerSessionLiveness({ name: "idle-one", isActive: () => false });
  registerSessionLiveness({ name: "busy-one", isActive: () => true });
  assert.equal(hasActiveExternalWork("/tmp/s.jsonl"), true);
  clearSessionLivenessProviders();
});

test("只认严格 true：返回真值但非布尔一律按不活跃（fail-closed）", () => {
  clearSessionLivenessProviders();
  registerSessionLiveness({ name: "truthy", isActive: () => "yes" });
  assert.equal(hasActiveExternalWork("/tmp/s.jsonl"), false);
  clearSessionLivenessProviders();
});

test("形状非法的注册被忽略，不抛错、不进注册表", () => {
  clearSessionLivenessProviders();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.doesNotThrow(() => {
      registerSessionLiveness({ name: "", isActive: () => true });
      registerSessionLiveness({ name: "no-isActive" });
      registerSessionLiveness(null);
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(listSessionLivenessProviders(), []);
});

test("同名同会话重复注册只留一条（后注册覆盖先注册）", () => {
  clearSessionLivenessProviders();
  registerSessionLiveness({ name: "dup", isActive: () => false });
  registerSessionLiveness({ name: "dup", isActive: () => true });
  assert.deepEqual(listSessionLivenessProviders(), ["dup"]);
  assert.equal(hasActiveExternalWork("/tmp/s.jsonl"), true);
  clearSessionLivenessProviders();
});
