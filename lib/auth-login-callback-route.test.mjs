/**
 * OAuth 手动码回调路由（issue #86）：token 只做一次性凭据，归属以挂起记录为准。
 *
 * 直接用挂起注册表（globalThis.__piLoginCallbacks）驱动 POST 处理器，不起服务：
 * 覆盖「完成、provider 不匹配、未知 token、缺参」四条，并守住取消路径的接线。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { POST } = await jiti.import("../app/api/auth/login/[provider]/route.ts");
const ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL("../app/api/auth/login/[provider]/route.ts", import.meta.url)),
  "utf8",
);

/** 每个用例用干净的注册表，避免跨用例串味。 */
function useRegistry() {
  const registry = new Map();
  globalThis.__piLoginCallbacks = registry;
  return registry;
}

function pending(registry, token, provider) {
  const calls = { resolved: [], rejected: [] };
  registry.set(token, {
    provider,
    resolve: (value) => calls.resolved.push(value),
    reject: (error) => calls.rejected.push(error),
  });
  return calls;
}

function post(provider, body) {
  return POST(
    new Request(`http://127.0.0.1:31415/api/auth/login/${provider}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ provider }) },
  );
}

test("回调完成：token 不含 provider 前缀也能成功，归属以挂起记录为准", async () => {
  const registry = useRegistry();
  const token = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"; // 纯 UUID，没有 provider 前缀
  const calls = pending(registry, token, "openai");

  const res = await post("openai", { token, code: "auth-code-1" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, provider: "openai" });
  assert.deepEqual(calls.resolved, ["auth-code-1"], "正确 provider 下应结算挂起 promise");
  assert.equal(registry.has(token), false, "结算后必须从注册表移除");
});

test("provider 不匹配：400，且不得结算、不得移除挂起记录", async () => {
  const registry = useRegistry();
  const token = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";
  const calls = pending(registry, token, "openai");

  const res = await post("anthropic", { token, code: "auth-code-2" });
  assert.equal(res.status, 400);
  assert.deepEqual(calls.resolved, [], "错 provider 不得结算");
  assert.equal(registry.has(token), true, "错 provider 不得吃掉挂起记录");
});

test("未知 token：404；缺参：400", async () => {
  const registry = useRegistry();

  const unknown = await post("openai", { token: "3f2504e0-4f89-41d3-9a0c-0305e82c3303", code: "x" });
  assert.equal(unknown.status, 404);
  assert.equal(registry.size, 0);

  assert.equal((await post("openai", { code: "x" })).status, 400);
  assert.equal((await post("openai", { token: "3f2504e0-4f89-41d3-9a0c-0305e82c3304" })).status, 400);
});

test("取消路径仍接线：SSE 收尾对挂起记录调 reject 并删除", () => {
  // reject 由 GET（SSE）的 cleanup 触发，那里需要 ModelRuntime 才能跑到，单测不驱动它；
  // 这里守住两条不可回退的接线：记录带 reject，且 cleanup 真的调它。
  assert.match(ROUTE_SOURCE, /registry\.get\(token\)\?\.reject\(/, "cleanup 必须调用记录的 reject");
  assert.match(ROUTE_SOURCE, /new Error\("Login cancelled"\)/, "取消原因要明确");
  assert.match(ROUTE_SOURCE, /provider,$/m, "挂起记录必须带 provider（POST 才能校验归属）");
});
