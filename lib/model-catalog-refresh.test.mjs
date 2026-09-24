/**
 * 刷新模型目录（lib）：成功才清缓存；失败要给出明确原因；SDK 版本不支持 refresh 要能说清楚。
 * 全程不触网（runtimeFactory 注入）。
 *
 * 关键回归点（审查 #88 阻断 1）：SDK 的 `refresh()` **不抛错**，provider 网络失败只记进
 * `errors` Map、请求中止只置 `aborted` —— 只捕 throw 会把失败当成功。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { ModelCatalogRefreshError, refreshModelCatalog } = await jiti.import("./model-catalog-refresh.ts");
const { invalidateModelsCache, loadModelsWithCache } = await jiti.import("./models-cache.ts");

function emptyModels() {
  return { models: {}, modelList: [], defaultModel: null, thinkingLevels: {}, thinkingLevelMaps: {}, authConfigured: {} };
}

test("成功：带 force/allowNetwork 调用 refresh、清缓存、返回成功摘要", async () => {
  const key = "refresh-cache-key";
  let loads = 0;
  await loadModelsWithCache(key, async () => {
    loads += 1;
    return emptyModels();
  });
  await loadModelsWithCache(key, async () => {
    loads += 1;
    return emptyModels();
  });
  assert.equal(loads, 1, "命中缓存：第二次不应重新 load");

  let refreshed = 0;
  let seenOptions = null;
  const invalidations = [];
  const runtime = {
    refresh: async (options) => {
      refreshed += 1;
      seenOptions = options;
      return { aborted: false, errors: new Map() };
    },
  };
  const { detail } = await refreshModelCatalog({
    runtimeFactory: async () => runtime,
    // 注入的钩子替掉默认失效入口，所以这里自己把真实缓存也清掉：
    // 既断言「成功会调失效钩子」，也保住「成功后下一次会重新 load」这条端到端断言。
    invalidate: () => {
      invalidations.push("invalidated");
      invalidateModelsCache();
    },
  });
  assert.equal(refreshed, 1);
  assert.deepEqual(detail, { aborted: false, failed: [] });
  // 不 force 的话 provider 侧 4 小时内直接跳过，刷新等于空转
  assert.equal(seenOptions?.force, true, "必须 force: true");
  assert.equal(seenOptions?.allowNetwork, true, "必须 allowNetwork: true");
  assert.deepEqual(invalidations, ["invalidated"], "成功后要清缓存");

  // 缓存已失效 → 下一次重新 load
  await loadModelsWithCache(key, async () => {
    loads += 1;
    return emptyModels();
  });
  assert.equal(loads, 2);
});

test("errors Map 非空：按 providers 失败抛出，且不清缓存", async () => {
  const invalidations = [];
  const runtime = {
    refresh: async () => ({
      aborted: false,
      errors: new Map([
        ["openrouter", new Error("getaddrinfo ENOTFOUND")],
        ["radius", new Error("502 Bad Gateway")],
      ]),
    }),
  };
  await assert.rejects(
    () =>
      refreshModelCatalog({
        runtimeFactory: async () => runtime,
        invalidate: () => invalidations.push("invalidated"),
      }),
    (error) =>
      error instanceof ModelCatalogRefreshError &&
      error.code === "providers" &&
      error.providers?.length === 2 &&
      /openrouter/.test(error.message) &&
      /ENOTFOUND/.test(error.message),
  );
  assert.deepEqual(invalidations, [], "失败不得清缓存");

  // errors 也可以是 JSON 化后的普通对象（跨进程/序列化后）
  await assert.rejects(
    () =>
      refreshModelCatalog({
        runtimeFactory: async () => ({
          refresh: async () => ({ aborted: false, errors: { cpa: "boom" } }),
        }),
      }),
    (error) => error instanceof ModelCatalogRefreshError && error.code === "providers",
  );
});

test("aborted：按中止抛出，且不清缓存", async () => {
  const invalidations = [];
  await assert.rejects(
    () =>
      refreshModelCatalog({
        runtimeFactory: async () => ({
          refresh: async () => ({ aborted: true, errors: new Map() }),
        }),
        invalidate: () => invalidations.push("invalidated"),
      }),
    (error) => error instanceof ModelCatalogRefreshError && error.code === "aborted",
  );
  assert.deepEqual(invalidations, [], "中止不算成功，不得清缓存");
});

test("refresh 抛错：转成 network 类型并保留原因", async () => {
  const runtime = {
    refresh: async () => {
      throw new Error("getaddrinfo ENOTFOUND models.example");
    },
  };
  await assert.rejects(
    () => refreshModelCatalog({ runtimeFactory: async () => runtime }),
    (error) =>
      error instanceof ModelCatalogRefreshError &&
      error.code === "network" &&
      /ENOTFOUND/.test(error.message),
  );
});

test("runtime 不支持 refresh：报 unavailable", async () => {
  await assert.rejects(
    () => refreshModelCatalog({ runtimeFactory: async () => ({}) }),
    (error) => error instanceof ModelCatalogRefreshError && error.code === "unavailable",
  );
});

test("失败路径不得让已有模型列表看起来变了（缓存保持可用）", async () => {
  const key = "refresh-failure-key";
  let loads = 0;
  const loader = async () => {
    loads += 1;
    return {
      models: { "a:b": "B" },
      modelList: [{ id: "b", name: "B", provider: "a" }],
      defaultModel: null,
      thinkingLevels: {},
      thinkingLevelMaps: {},
      authConfigured: {},
    };
  };
  const before = await loadModelsWithCache(key, loader);
  await assert.rejects(
    () =>
      refreshModelCatalog({
        runtimeFactory: async () => ({
          refresh: async () => ({ aborted: false, errors: new Map([["a", new Error("offline")]]) }),
        }),
      }),
  );
  const after = await loadModelsWithCache(key, loader);
  assert.deepEqual(after.modelList, before.modelList);
  assert.equal(loads, 1, "失败不清缓存：列表仍来自原缓存");
});

test("默认工厂：创建 runtime 时不刷（refreshOnCreate: false），由显式 force 刷新负责", () => {
  // 不这么做的话：create 阶段那次非 force 刷新会占掉 provider 的 4 小时新鲜度窗口，
  // 后面的显式刷新就变成空转 —— 这是「刷新目录」曾经完全不生效的成因之一。
  const source = readFileSync(new URL("./model-catalog-refresh.ts", import.meta.url), "utf8");
  assert.match(source, /refreshOnCreate: false/, "create 时必须关掉自动刷新");
  assert.match(source, /force: true/, "显式刷新必须 force");
});
