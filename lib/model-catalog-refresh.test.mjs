/**
 * 刷新模型目录（lib）：成功要清缓存；失败要给出明确原因；SDK 版本不支持 refresh 要能说清楚。
 * 全程不触网（runtimeFactory 注入）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { ModelCatalogRefreshError, refreshModelCatalog } = await jiti.import("./model-catalog-refresh.ts");
const { loadModelsWithCache } = await jiti.import("./models-cache.ts");

test("成功：返回结果摘要，并让进程内模型缓存失效", async () => {
  const key = "refresh-cache-key";
  let loads = 0;
  await loadModelsWithCache(key, async () => {
    loads += 1;
    return { models: {}, modelList: [], defaultModel: null, thinkingLevels: {}, thinkingLevelMaps: {}, authConfigured: {} };
  });
  await loadModelsWithCache(key, async () => {
    loads += 1;
    return { models: {}, modelList: [], defaultModel: null, thinkingLevels: {}, thinkingLevelMaps: {}, authConfigured: {} };
  });
  assert.equal(loads, 1, "命中缓存：第二次不应重新 load");

  let refreshed = 0;
  const runtime = {
    refresh: async () => {
      refreshed += 1;
      return { providers: 3 };
    },
  };
  const { detail } = await refreshModelCatalog({ runtimeFactory: async () => runtime });
  assert.equal(refreshed, 1);
  assert.deepEqual(detail, { providers: 3 });

  // 缓存已失效 → 下一次重新 load
  await loadModelsWithCache(key, async () => {
    loads += 1;
    return { models: {}, modelList: [], defaultModel: null, thinkingLevels: {}, thinkingLevelMaps: {}, authConfigured: {} };
  });
  assert.equal(loads, 2);
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
    () => refreshModelCatalog({
      runtimeFactory: async () => ({
        refresh: async () => {
          throw new Error("offline");
        },
      }),
    }),
  );
  const after = await loadModelsWithCache(key, loader);
  assert.deepEqual(after.modelList, before.modelList);
  assert.equal(loads, 1, "失败不清缓存：列表仍来自原缓存");
});
