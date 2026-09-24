/**
 * 远端刷新目录（models-store.json）的读入与合并（纯逻辑 + 磁盘 fixture）。
 *
 * 验收点（审查 #88 阻断 2）：刷新写进 store 之后，**目录读取侧真的能看到新模型** ——
 * 否则「刷新目录」按钮看起来成功、界面却什么都不变。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const {
  mergeCatalogWithOverlay,
  modelsStorePathFor,
  projectModelsStoreOverlay,
  readModelsStoreOverlay,
  resetModelsStoreOverlayCacheForTests,
} = await jiti.import("./model-store-catalog.ts");

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("modelsStorePathFor：与 SDK 的 FileModelsStore 同位置（models.json 同目录）", () => {
  assert.equal(modelsStorePathFor("/agent/models.json"), join("/agent", "models-store.json"));
});

test("projectModelsStoreOverlay：投影模型、按 provider 分组", () => {
  const overlay = projectModelsStoreOverlay({
    acme: {
      lastModified: Date.now(),
      models: [
        { id: "m1", provider: "acme", name: "M1", contextWindow: 1000 },
        { id: "m2" },
        { name: "没有 id" },
        "not-an-object",
      ],
    },
  });
  assert.deepEqual([...overlay.keys()], ["acme"]);
  assert.deepEqual(overlay.get("acme").map((m) => m.id), ["m1", "m2"]);
  assert.equal(overlay.get("acme")[0].name, "M1");
  assert.equal(overlay.get("acme")[0].provider, "acme");
  assert.equal(overlay.get("acme")[1].name, "m2", "缺 name 时回退 id");
});

test("新鲜度：远端条目不如本地内置目录新时整体丢弃（与 pi 的 remoteModels 同规则）", () => {
  const store = {
    acme: { lastModified: 100, models: [{ id: "old" }] },
    beta: { lastModified: 300, models: [{ id: "new" }] },
  };
  const overlay = projectModelsStoreOverlay(store, 200);
  assert.deepEqual([...overlay.keys()], ["beta"]);
  // 没有 lastModified 的条目在设了门槛时一律不采信
  const noStamp = projectModelsStoreOverlay({ acme: { models: [{ id: "x" }] } }, 200);
  assert.equal(noStamp.size, 0);
  // 拿不到内置生成时间时不设门槛
  assert.equal(projectModelsStoreOverlay(store, undefined).size, 2);
});

test("坏输入一律降级为空覆盖（不抛错）", () => {
  for (const raw of [null, 42, "x", [], { acme: null }, { acme: { models: "nope" } }]) {
    assert.equal(projectModelsStoreOverlay(raw, undefined).size, 0, JSON.stringify(raw));
  }
});

test("mergeCatalogWithOverlay：该 provider 整体被远端取代，其它 provider 原样保留", () => {
  const baseline = [
    { id: "a", name: "A", provider: "acme" },
    { id: "b", name: "B", provider: "acme" },
    { id: "c", name: "C", provider: "other" },
  ];
  const overlay = new Map([["acme", [{ id: "a", name: "A2", provider: "acme" }, { id: "d", name: "D", provider: "acme" }]]]);
  const merged = mergeCatalogWithOverlay(baseline, overlay);
  assert.deepEqual(
    merged.map((m) => `${m.provider}/${m.id}:${m.name}`),
    ["other/c:C", "acme/a:A2", "acme/d:D"],
  );
});

test("readModelsStoreOverlay：文件不存在/坏 JSON 都返回空表", () => {
  const dir = tempDir("pidance-store-");
  try {
    assert.equal(readModelsStoreOverlay({ storePath: join(dir, "missing.json") }).size, 0);
    const bad = join(dir, "models-store.json");
    writeFileSync(bad, "{ not json", "utf8");
    resetModelsStoreOverlayCacheForTests();
    assert.equal(readModelsStoreOverlay({ storePath: bad }).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readModelsStoreOverlay：按 mtime+size 缓存，刷新写盘后自动生效", () => {
  const dir = tempDir("pidance-store-");
  const store = join(dir, "models-store.json");
  try {
    resetModelsStoreOverlayCacheForTests();
    writeFileSync(store, JSON.stringify({ acme: { models: [{ id: "first" }] } }), "utf8");
    assert.deepEqual([...readModelsStoreOverlay({ storePath: store }).get("acme")].map((m) => m.id), ["first"]);

    // 同一份内容再读：即使缓存被清掉也必须拿到同样结果（缓存只是加速）
    assert.deepEqual([...readModelsStoreOverlay({ storePath: store }).get("acme")].map((m) => m.id), ["first"]);

    // 改写文件（模拟刷新）：内容变化必须被看到
    writeFileSync(store, JSON.stringify({ acme: { models: [{ id: "second" }, { id: "third" }] } }), "utf8");
    assert.deepEqual(
      [...readModelsStoreOverlay({ storePath: store }).get("acme")].map((m) => m.id),
      ["second", "third"],
      "刷新写盘后必须读到新目录",
    );
  } finally {
    resetModelsStoreOverlayCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});
