/**
 * /api/models/refresh 路由：把刷新结果映射成明确的状态码与响应体。
 *
 * 走 createRefreshHandler 注入假刷新器：不触网、不依赖真实凭据，也不启动服务。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { createRefreshHandler } = await jiti.import("../app/api/models/refresh/route.ts");
const { ModelCatalogRefreshError } = await jiti.import("./model-catalog-refresh.ts");

const post = (handler) => handler(new Request("http://localhost/api/models/refresh", { method: "POST" }));

test("成功：200 + ok + 结果摘要", async () => {
  const handler = createRefreshHandler(async () => ({ detail: { providers: 5 } }));
  const res = await post(handler);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, detail: { providers: 5 } });
});

test("网络失败：502 + 明确原因（界面据此提示）", async () => {
  const handler = createRefreshHandler(async () => {
    throw new ModelCatalogRefreshError("network", "getaddrinfo ENOTFOUND models.example");
  });
  const res = await post(handler);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.code, "network");
  assert.match(body.error, /ENOTFOUND/);
});

test("SDK 不可用：503（可选依赖未安装，与 OAuth 登录同一条策略）", async () => {
  const handler = createRefreshHandler(async () => {
    throw new ModelCatalogRefreshError("unavailable", "ModelRuntime is not available");
  });
  const res = await post(handler);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "unavailable");
});

test("未知异常：500，不冒充刷新失败以外的语义", async () => {
  const handler = createRefreshHandler(async () => {
    throw new Error("kaboom");
  });
  const res = await post(handler);
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /kaboom/);
});
