import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  listModelsFromModelsJson,
  buildModelsDataFromDisk,
  buildModelsDataFromCatalog,
  mergeCatalogModels,
  thinkingLevelsFor,
} = await jiti.import("./models-catalog.ts");

test("listModelsFromModelsJson 解析 provider.models", () => {
  const dir = mkdtempSync(join(tmpdir(), "pidance-catalog-"));
  try {
    const modelsPath = join(dir, "models.json");
    writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          p1: {
            models: [
              { id: "m1", name: "Model One", reasoning: true },
              { id: "m2" },
            ],
          },
        },
      }),
      "utf8",
    );
    const list = listModelsFromModelsJson(modelsPath);
    assert.equal(list.length, 2);
    assert.equal(list[0].provider, "p1");
    assert.equal(list[0].name, "Model One");
    assert.equal(list[1].name, "m2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildModelsDataFromDisk 默认模型与 thinking", () => {
  const dir = mkdtempSync(join(tmpdir(), "pidance-catalog-"));
  try {
    const modelsPath = join(dir, "models.json");
    const settingsPath = join(dir, "settings.json");
    writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          p1: {
            models: [
              {
                id: "m1",
                name: "M1",
                reasoning: true,
                thinkingLevelMap: { off: null, low: "low" },
              },
            ],
          },
        },
      }),
      "utf8",
    );
    writeFileSync(
      settingsPath,
      JSON.stringify({ defaultProvider: "p1", defaultModel: "m1" }),
      "utf8",
    );
    const data = buildModelsDataFromDisk({
      modelsPath,
      settingsPath,
      authConfigured: { p1: true },
    });
    assert.deepEqual(data.defaultModel, { provider: "p1", modelId: "m1" });
    assert.equal(data.models["p1:m1"], "M1");
    // off:null 禁用；low 自定义；其余 omit 可用；xhigh/max 未映射 → 不含
    assert.deepEqual(data.thinkingLevels["p1:m1"], ["minimal", "low", "medium", "high"]);
    assert.equal(data.authConfigured.p1, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("thinkingLevelsFor 对齐 pi-ai getSupportedThinkingLevels", () => {
  assert.deepEqual(thinkingLevelsFor({ id: "a", name: "a", provider: "p" }), ["off"]);
  assert.deepEqual(
    thinkingLevelsFor({ id: "a", name: "a", provider: "p", reasoning: true }),
    ["off", "minimal", "low", "medium", "high"],
  );
  assert.deepEqual(
    thinkingLevelsFor({
      id: "a",
      name: "a",
      provider: "p",
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: null,
        max: "max",
      },
    }),
    ["off", "high", "max"],
  );
  assert.deepEqual(
    thinkingLevelsFor({
      id: "a",
      name: "a",
      provider: "p",
      reasoning: true,
      thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    }),
    ["off", "low", "medium", "high", "xhigh", "max"],
  );
});


test("mergeCatalogModels 仅合并已配置内置，models.json 覆盖同 id", () => {
  const custom = [
    { id: "custom-1", name: "C1", provider: "new-api" },
    { id: "deepseek-v4-flash", name: "via-new-api", provider: "new-api" },
  ];
  const builtins = [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "deepseek", reasoning: true },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", provider: "deepseek", reasoning: true },
    { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
  ];
  const merged = mergeCatalogModels(custom, builtins, { deepseek: true, "new-api": true });
  // custom 2 条 + deepseek 2 条（openai 未配置不纳入）
  assert.equal(merged.length, 4);
  assert.ok(merged.some((m) => m.provider === "deepseek" && m.id === "deepseek-v4-pro"));
  assert.ok(merged.some((m) => m.provider === "deepseek" && m.id === "deepseek-v4-flash"));
  assert.ok(!merged.some((m) => m.provider === "openai"));
  // 同 id 不同 provider 各自保留
  assert.ok(merged.some((m) => m.provider === "new-api" && m.id === "deepseek-v4-flash"));
});

test("buildModelsDataFromCatalog 含内置模型 thinking", () => {
  const data = buildModelsDataFromCatalog(
    [
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        provider: "deepseek",
        reasoning: true,
        thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
        contextWindow: 1000000,
        maxTokens: 384000,
      },
    ],
    {
      settingsPath: join(tmpdir(), "no-settings-" + Date.now() + ".json"),
      authConfigured: { deepseek: true },
    },
  );
  assert.equal(data.modelList.length, 1);
  assert.equal(data.modelList[0].provider, "deepseek");
  assert.deepEqual(data.thinkingLevels["deepseek:deepseek-v4-flash"], ["off", "high", "max"]);
  assert.equal(data.authConfigured.deepseek, true);
});
