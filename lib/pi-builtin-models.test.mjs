import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const {
  listBuiltinCatalogModels,
  resolvePiAiProvidersAllPath,
  resetBuiltinCatalogModelsCacheForTests,
} = await jiti.import("./pi-builtin-models.ts");

test("resolvePiAiProvidersAllPath 能找到已安装 pi-ai", () => {
  const path = resolvePiAiProvidersAllPath();
  assert.ok(path, "应解析到 pi-ai providers/all.js");
  assert.match(path, /providers[/\\]all\.js$/);
});

test("listBuiltinCatalogModels 含 deepseek 渠道模型", async () => {
  resetBuiltinCatalogModelsCacheForTests();
  const list = await listBuiltinCatalogModels();
  assert.ok(list.length > 0, "内置模型非空");
  const deep = list.filter((m) => m.provider === "deepseek");
  assert.ok(deep.some((m) => m.id === "deepseek-v4-flash"));
  assert.ok(deep.some((m) => m.id === "deepseek-v4-pro"));
  assert.equal(deep[0].reasoning, true);
});
