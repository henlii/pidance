/**
 * 可用模型目录的过滤口径（/api/models 与「每模型开关」共用）。
 *
 * 这块是从 app/api/models/route.ts 抽出来的，行为必须与抽取前一致：
 * enabledModels 缺失/空 = 不过滤；每项认 `provider/model` 与裸 `model`；带思考后缀按同一模型；
 * 全部被排除时退回不过滤（不能把模型选择器整栏卸掉）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { applyEnabledModelsFilter, isModelEnabled, modelRefOf, stripThinkingSuffix } =
  await jiti.import("./models-available.ts");

function data() {
  return {
    models: { "cpa:a": "A", "cpa:b": "B", "oai:c": "C" },
    modelList: [
      { id: "a", name: "A", provider: "cpa" },
      { id: "b", name: "B", provider: "cpa" },
      { id: "c", name: "C", provider: "oai" },
    ],
    defaultModel: { provider: "cpa", modelId: "b" },
    thinkingLevels: { "cpa:a": ["low", "high"], "cpa:b": ["low"], "oai:c": ["low"] },
    thinkingLevelMaps: { "cpa:a": { high: "high" } },
    authConfigured: { cpa: true },
  };
}

test("stripThinkingSuffix 只剥思考级别后缀", () => {
  assert.equal(stripThinkingSuffix("cpa/a:high"), "cpa/a");
  assert.equal(stripThinkingSuffix("cpa/a:xhigh"), "cpa/a");
  assert.equal(stripThinkingSuffix("cpa/a"), "cpa/a");
  assert.equal(stripThinkingSuffix("cpa/a:weird"), "cpa/a:weird");
});

test("modelRefOf 生成 provider/id", () => {
  assert.equal(modelRefOf({ id: "grok-4.6", provider: "cpa" }), "cpa/grok-4.6");
});

test("isModelEnabled：缺失或空数组 = 全部允许", () => {
  assert.equal(isModelEnabled({ id: "a", provider: "cpa" }, null), true);
  assert.equal(isModelEnabled({ id: "a", provider: "cpa" }, []), true);
});

test("isModelEnabled：认 provider/model、裸 id 与思考后缀", () => {
  assert.equal(isModelEnabled({ id: "a", provider: "cpa" }, ["cpa/a"]), true);
  assert.equal(isModelEnabled({ id: "a", provider: "cpa" }, ["a"]), true);
  assert.equal(isModelEnabled({ id: "a", provider: "cpa" }, ["cpa/a:high"]), true);
  assert.equal(isModelEnabled({ id: "a", provider: "cpa" }, ["cpa/other"]), false);
});

test("过滤：只留白名单里的模型，且 models/thinking 同步收窄", () => {
  const out = applyEnabledModelsFilter(data(), ["cpa/a", "oai/c"]);
  assert.deepEqual(out.modelList.map((m) => `${m.provider}/${m.id}`), ["cpa/a", "oai/c"]);
  assert.deepEqual(Object.keys(out.models).sort(), ["cpa:a", "oai:c"]);
  assert.deepEqual(out.thinkingLevels["cpa:a"], ["low", "high"]);
  assert.equal(out.thinkingLevels["cpa:b"], undefined);
  assert.deepEqual(out.thinkingLevelMaps, { "cpa:a": { high: "high" } });
  // 默认模型被关掉 → 置空（否则会选中一个不可见的模型）
  assert.equal(out.defaultModel, null);
  assert.equal(out.authConfigured.cpa, true);
});

test("过滤：默认模型仍在白名单时保留", () => {
  const out = applyEnabledModelsFilter(data(), ["cpa/b"]);
  assert.deepEqual(out.defaultModel, { provider: "cpa", modelId: "b" });
});

test("过滤：白名单里全是不存在的引用 → 退回不过滤（不卸掉选择器）", () => {
  const out = applyEnabledModelsFilter(data(), ["nope/gone"]);
  assert.equal(out.modelList.length, 3);
  assert.deepEqual(out.defaultModel, { provider: "cpa", modelId: "b" });
});

test("过滤：null / 空数组 → 原样返回（不复制语义差异）", () => {
  const base = data();
  const out = applyEnabledModelsFilter(base, undefined);
  assert.equal(out.modelList.length, 3);
  assert.deepEqual(Object.keys(out.models).sort(), ["cpa:a", "cpa:b", "oai:c"]);
});
