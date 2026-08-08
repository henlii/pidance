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
    assert.deepEqual(data.thinkingLevels["p1:m1"], ["off", "low"]);
    assert.equal(data.authConfigured.p1, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
