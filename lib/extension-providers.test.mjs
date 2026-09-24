/**
 * 扩展 provider 列表：纯映射 + 缓存 + 失败降级。
 *
 * 不加载真实扩展（loaderFactory 注入），也不读任何凭据。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { invalidateExtensionProvidersCache, listExtensionProviders, mapExtensionProviders } =
  await jiti.import("./extension-providers.ts");

test("原生 provider 与配置注册都进来，按显示名排序", () => {
  const entries = mapExtensionProviders({
    nativeProviders: [
      { provider: { id: "zeta", name: "Zeta Gateway", models: [{ id: "a" }, { id: "b" }] }, extensionPath: "/ext/z.ts" },
    ],
    configRegistrations: [
      { name: "alpha", config: { name: "Alpha Cloud", models: [{ id: "m1" }] }, extensionPath: "/ext/a.ts" },
    ],
  });

  assert.deepEqual(
    entries.map((e) => [e.id, e.displayName, e.source, e.modelCount]),
    [
      ["alpha", "Alpha Cloud", "extension", 1],
      ["zeta", "Zeta Gateway", "extension", 2],
    ],
  );
});

test("同一 id 先到先得（原生优先），缺 name 时退回 id", () => {
  const entries = mapExtensionProviders({
    nativeProviders: [{ provider: { id: "dup" } }],
    configRegistrations: [{ name: "dup", config: { name: "Later" } }, { name: "only-config" }],
  });
  assert.deepEqual(entries.map((e) => e.id).sort(), ["dup", "only-config"]);
  assert.equal(entries.find((e) => e.id === "dup").displayName, "dup");
  assert.equal(entries.find((e) => e.id === "only-config").displayName, "only-config");
});

test("畸形注册记录安全忽略，不抛错", () => {
  const entries = mapExtensionProviders({
    nativeProviders: [{ provider: null }, { provider: { name: "   " } }, {}],
    configRegistrations: [{ name: "" }, { name: 42 }, { name: "ok", config: "not-an-object" }],
  });
  assert.deepEqual(entries.map((e) => e.id), ["ok"]);
  assert.equal(entries[0].modelCount, 0);
});

test("加载失败降级为空列表并带出原因；结果被缓存，失效入口能清掉", async () => {
  invalidateExtensionProvidersCache();
  let calls = 0;
  const failing = () => async () => {
    calls += 1;
    throw new Error("boom");
  };

  const first = await listExtensionProviders({ cwd: "/tmp/qa-ext-1", loaderFactory: failing });
  assert.deepEqual(first.providers, []);
  assert.match(first.error, /boom/);

  const second = await listExtensionProviders({ cwd: "/tmp/qa-ext-1", loaderFactory: failing });
  assert.equal(second.error, first.error);
  assert.equal(calls, 1, "同一 cwd 应命中缓存，不重复加载扩展");

  invalidateExtensionProvidersCache();
  await listExtensionProviders({ cwd: "/tmp/qa-ext-1", loaderFactory: failing });
  assert.equal(calls, 2, "失效后应重新加载");

  // 不同 cwd 各自一份
  await listExtensionProviders({ cwd: "/tmp/qa-ext-2", loaderFactory: failing });
  assert.equal(calls, 3);
  invalidateExtensionProvidersCache();
});

test("并发调用共享同一次加载（in-flight 去重）", async () => {
  invalidateExtensionProvidersCache();
  let started = 0;
  const loader = () => async () => {
    started += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { configRegistrations: [{ name: "p1", config: { name: "P1" } }], nativeProviders: [] };
  };

  const [a, b] = await Promise.all([
    listExtensionProviders({ cwd: "/tmp/qa-ext-3", loaderFactory: loader }),
    listExtensionProviders({ cwd: "/tmp/qa-ext-3", loaderFactory: loader }),
  ]);
  assert.equal(started, 1);
  assert.deepEqual(a.providers, b.providers);
  assert.equal(a.providers[0].id, "p1");
  invalidateExtensionProvidersCache();
});

test("失效后起飞的结果不再写回缓存（in-flight 期间装/卸插件不被旧结果覆盖）", async () => {
  invalidateExtensionProvidersCache();
  const cwd = "/tmp/qa-ext-inval";
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = () => async () => {
    await gate;
    return { configRegistrations: [{ name: "old", config: { name: "OLD" } }], nativeProviders: [] };
  };

  const pending = listExtensionProviders({ cwd, loaderFactory: slow });
  // 加载还在飞的时候失效（模拟此时装了插件 / 模型配置变更）
  invalidateExtensionProvidersCache();
  release();
  const first = await pending;
  assert.equal(first.providers[0]?.id, "old", "调用方拿到的仍是那次加载的结果");

  // 下一次调用必须重新加载，而不是命中失效期间的旧结果
  let calls = 0;
  const fresh = () => async () => {
    calls += 1;
    return { configRegistrations: [{ name: "new", config: { name: "NEW" } }], nativeProviders: [] };
  };
  const after = await listExtensionProviders({ cwd, loaderFactory: fresh });
  assert.equal(calls, 1, "失效之后必须重新加载");
  assert.equal(after.providers[0]?.id, "new");
  invalidateExtensionProvidersCache();
});
