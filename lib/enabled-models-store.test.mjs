/**
 * enabledModels 开关的纯逻辑 + 写盘纪律。
 *
 * 重点验两件事：
 * 1. 语义：不过滤（null/空）↔ 显式列表之间怎么切换；思考后缀归一；不允许关掉最后一个。
 * 2. 纪律：最小编辑（其它键逐字节不变）、读不出就不写、项目级覆盖时拒写。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const {
  EnabledModelsError,
  computeNextEnabledModels,
  applyEnabledModelsEdit,
  readEnabledModelsState,
  toggleEnabledModel,
  writeEnabledModels,
} = await jiti.import("./enabled-models-store.ts");

const ALL = ["cpa/deepseek-v4.1-flash", "cpa/grok-4.6", "openai/gpt-5"];

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ── computeNextEnabledModels ────────────────────────────────────────────────

test("未过滤时启用模型：不写盘（本来就是全开）", () => {
  assert.equal(computeNextEnabledModels(null, "cpa/grok-4.6", true, ALL), null);
  assert.equal(computeNextEnabledModels([], "cpa/grok-4.6", true, ALL), null);
});

test("已过滤时启用模型：追加该引用", () => {
  const next = computeNextEnabledModels(["cpa/grok-4.6"], "openai/gpt-5", true, ALL);
  assert.deepEqual(next, ["cpa/grok-4.6", "openai/gpt-5"]);
});

test("已过滤时启用已在列表里的模型：原样返回", () => {
  assert.deepEqual(
    computeNextEnabledModels(["cpa/grok-4.6"], "cpa/grok-4.6", true, ALL),
    ["cpa/grok-4.6"],
  );
});

test("未过滤时停用：物化成「可用集减去目标」", () => {
  assert.deepEqual(computeNextEnabledModels(null, "cpa/grok-4.6", false, ALL), [
    "cpa/deepseek-v4.1-flash",
    "openai/gpt-5",
  ]);
});

test("未过滤时停用一个不在可用集里的引用：不动（保持不过滤）", () => {
  assert.equal(computeNextEnabledModels(null, "nope/gone", false, ALL), null);
});

test("停用最后一个：明确拒绝，而不是静默变成全开", () => {
  assert.throws(
    () => computeNextEnabledModels(["cpa/grok-4.6"], "cpa/grok-4.6", false, ALL),
    (error) => error instanceof EnabledModelsError && error.code === "last-model",
  );
  assert.throws(
    () => computeNextEnabledModels(null, "cpa/grok-4.6", false, ["cpa/grok-4.6"]),
    (error) => error instanceof EnabledModelsError && error.code === "last-model",
  );
});

test("思考后缀按同一模型处理（:high 不影响开关判断）", () => {
  assert.equal(computeNextEnabledModels(null, "cpa/grok-4.6:high", true, ALL), null);
  assert.deepEqual(computeNextEnabledModels(["cpa/grok-4.6:high"], "cpa/grok-4.6", true, ALL), [
    "cpa/grok-4.6:high",
  ]);
  assert.deepEqual(
    computeNextEnabledModels(["cpa/grok-4.6:high", "openai/gpt-5"], "cpa/grok-4.6", false, ALL),
    ["openai/gpt-5"],
  );
});

test("空引用直接报 bad-request", () => {
  assert.throws(
    () => computeNextEnabledModels(null, "   ", true, ALL),
    (error) => error instanceof EnabledModelsError && error.code === "bad-request",
  );
});

// ── 写盘纪律 ────────────────────────────────────────────────────────────────

function seedSettings(dir, body) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "settings.json");
  writeFileSync(path, body, "utf8");
  return path;
}

test("最小编辑：只动 enabledModels，其它键取值不变", () => {
  const dir = tempDir("enabled-models-");
  try {
    const before = [
      "{",
      '  "theme": "chamber",',
      '  "enabledModels": ["cpa/grok-4.6"],',
      '  "tools": ["bash", "read"],',
      '  "nested": { "a": 1, "b": [2, 3] }',
      "}",
      "",
    ].join("\n");
    const path = seedSettings(dir, before);

    toggleEnabledModel("openai/gpt-5", true, ALL, { settingsPath: path });

    const afterText = readFileSync(path, "utf8");
    const beforeObj = JSON.parse(before);
    const afterObj = JSON.parse(afterText);
    delete beforeObj.enabledModels;
    delete afterObj.enabledModels;
    assert.deepEqual(afterObj, { theme: "chamber", tools: ["bash", "read"], nested: { a: 1, b: [2, 3] } });
    assert.deepEqual(JSON.parse(afterText).enabledModels, ["cpa/grok-4.6", "openai/gpt-5"]);
    // 其它行逐字节不变（把 enabledModels 那一行挖掉后比较全文）
    const strip = (text) => text.split("\n").filter((line) => !line.includes("enabledModels")).join("\n");
    assert.equal(strip(afterText), strip(before));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("恢复不过滤：删除该键，而不是写空数组", () => {
  const dir = tempDir("enabled-models-");
  try {
    const path = seedSettings(dir, '{\n  "enabledModels": ["cpa/grok-4.6"],\n  "theme": "chamber"\n}\n');
    writeEnabledModels(null, { settingsPath: path });
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.equal("enabledModels" in parsed, false);
    assert.equal(parsed.theme, "chamber");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings.json 读不出：拒绝写，文件字节不变", () => {
  const dir = tempDir("enabled-models-");
  try {
    const broken = '{\n  "theme": "chamber",\n  "oops": \n}\n';
    const path = seedSettings(dir, broken);
    assert.throws(
      () => toggleEnabledModel("cpa/grok-4.6", true, ALL, { settingsPath: path }),
      (error) => error instanceof EnabledModelsError && error.code === "unreadable",
    );
    assert.equal(readFileSync(path, "utf8"), broken);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("项目级覆盖 enabledModels：全局开关报 project-override 且不写", () => {
  const dir = tempDir("enabled-models-");
  try {
    const path = seedSettings(dir, '{ "theme": "chamber" }\n');
    const projectPath = seedSettings(join(dir, "proj"), '{ "enabledModels": ["openai/gpt-5"] }\n');
    assert.throws(
      () => toggleEnabledModel("cpa/grok-4.6", true, ALL, {
        settingsPath: path,
        projectSettingsPath: projectPath,
      }),
      (error) => error instanceof EnabledModelsError && error.code === "project-override",
    );
    assert.equal(readFileSync(path, "utf8"), '{ "theme": "chamber" }\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readEnabledModelsState：区分 未过滤 / 已过滤 / 项目覆盖 / 读不出", () => {
  const dir = tempDir("enabled-models-");
  try {
    const path = seedSettings(dir, '{ "enabledModels": [] }\n');
    assert.equal(readEnabledModelsState({ settingsPath: path }).enabledModels, null);

    writeFileSync(path, '{ "enabledModels": ["cpa/grok-4.6"] }\n', "utf8");
    assert.deepEqual(readEnabledModelsState({ settingsPath: path }).enabledModels, ["cpa/grok-4.6"]);

    const projectPath = seedSettings(join(dir, "proj"), '{ "enabledModels": ["openai/gpt-5"] }\n');
    assert.equal(
      readEnabledModelsState({ settingsPath: path, projectSettingsPath: projectPath }).projectOverride,
      true,
    );

    writeFileSync(path, "{ not json", "utf8");
    const state = readEnabledModelsState({ settingsPath: path });
    assert.equal(state.unreadable, true);
    assert.equal(state.enabledModels, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 纯文本手术的边界（applyEnabledModelsEdit）────────────────────────────────

test("键不存在：按文件缩进追加，其余字节不变", () => {
  const before = '{\n  "theme": "chamber",\n  "tools": ["bash"]\n}\n';
  const after = applyEnabledModelsEdit(before, ["a/b"]);
  assert.equal(after, '{\n  "theme": "chamber",\n  "tools": ["bash"],\n  "enabledModels": ["a/b"]\n}\n');
  assert.deepEqual(JSON.parse(after).tools, ["bash"]);
  assert.deepEqual(JSON.parse(after).enabledModels, ["a/b"]);
});

test("空对象：追加后仍是合法 JSON", () => {
  assert.equal(applyEnabledModelsEdit("{}", ["a/b"]), '{"enabledModels": ["a/b"]}');
  assert.equal(applyEnabledModelsEdit("{ }\n", ["a/b"]), '{ "enabledModels": ["a/b"]}\n');
  assert.equal(applyEnabledModelsEdit("{}", null), "{}");
});

test("键在末尾：删除时吃掉前一个逗号", () => {
  const before = '{\n  "theme": "chamber",\n  "enabledModels": ["a/b"]\n}\n';
  assert.equal(applyEnabledModelsEdit(before, null), '{\n  "theme": "chamber"\n}\n');
});

test("键在中间：删除时吃掉后随逗号与换行", () => {
  const before = '{\n  "enabledModels": ["a/b"],\n  "theme": "chamber"\n}\n';
  assert.equal(applyEnabledModelsEdit(before, null), '{\n  "theme": "chamber"\n}\n');
});

test("紧凑 JSON：替换值不改动其它部分", () => {
  const before = '{"theme":"chamber","enabledModels":["a/b"],"n":[1,2]}';
  const after = applyEnabledModelsEdit(before, ["x/y", "z/w"]);
  assert.equal(after, '{"theme":"chamber","enabledModels":["x/y","z/w"],"n":[1,2]}');
});

test("CRLF 文件：插入用 CRLF，且原样保留已有换行", () => {
  const before = '{\r\n  "theme": "chamber"\r\n}\r\n';
  const after = applyEnabledModelsEdit(before, ["a/b"]);
  assert.equal(after, '{\r\n  "theme": "chamber",\r\n  "enabledModels": ["a/b"]\r\n}\r\n');
});

test("嵌套同名键不受影响（只认顶层）", () => {
  const before = '{\n  "nested": { "enabledModels": ["inner"] },\n  "theme": "chamber"\n}\n';
  const after = applyEnabledModelsEdit(before, ["outer"]);
  const parsed = JSON.parse(after);
  assert.deepEqual(parsed.nested.enabledModels, ["inner"]);
  assert.deepEqual(parsed.enabledModels, ["outer"]);
});

test("值里含方括号/转义引号也能正确定位（不会被提前截断）", () => {
  const before = '{\n  "note": "a [b] \\"c\\"",\n  "enabledModels": ["a/b"],\n  "theme": "chamber"\n}\n';
  const after = applyEnabledModelsEdit(before, ["x/y"]);
  assert.deepEqual(JSON.parse(after).enabledModels, ["x/y"]);
  assert.equal(JSON.parse(after).note, 'a [b] "c"');
  assert.equal(JSON.parse(after).theme, "chamber");
});

test("裸 id 同时指向多个 provider 时：关掉其中一个不误伤另一个", () => {
  const twoProviders = ["a/1", "b/1", "a/2"];
  // 关 a/1：含义可能是 b/1 的裸条目要去掉，但 b/1 必须显式保留
  assert.deepEqual(computeNextEnabledModels(["1", "a/2"], "a/1", false, twoProviders), ["b/1", "a/2"]);
  // 开 a/1：裸 "1" 已经覆盖它 → 原样返回（不重复添加）
  assert.deepEqual(computeNextEnabledModels(["1"], "a/1", true, twoProviders), ["1"]);
  // 未过滤时关 a/1：物化出除目标外的全部
  assert.deepEqual(computeNextEnabledModels(null, "a/1", false, twoProviders), ["b/1", "a/2"]);
  // 裸 id 在目录里唯一时按原语义处理（settings.json 常见写法）
  assert.deepEqual(computeNextEnabledModels(["1", "a/2"], "a/1", false, ["a/1", "a/2"]), ["a/2"]);
  // 白名单里只有这一条裸 id、它覆盖的正是目标 → 关掉就没有启用的模型了，明确拒绝
  assert.throws(
    () => computeNextEnabledModels(["1"], "a/1", false, ["a/1", "a/2"]),
    (error) => error instanceof EnabledModelsError && error.code === "last-model",
  );
});

test("手术失败不退回整份重写（回归闸门）", () => {
  const source = readFileSync(new URL("./enabled-models-store.ts", import.meta.url), "utf8");
  const section = source.slice(source.indexOf("export function writeEnabledModels"));
  assert.ok(
    !/\{\s*\.\.\.read\.data\s*\}/.test(section),
    "writeEnabledModels 不得再构造 {...read.data} 整份序列化写回（会冲掉用户排版与其它键）",
  );
  assert.ok(/unsupported-shape/.test(section), "手术失败必须拒写并报 unsupported-shape（422）");
});
