/**
 * 插件补全链（issue #101）：组装顺序、返回值三态、候选应用。
 * 纯逻辑，无 DOM。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  buildCompletionChain,
  classifyCompletionSuggestions,
  createBaseCompletionProvider,
  normalizeAppliedCompletion,
  normalizeCompletionItems,
} = await jiti.import("./autocomplete-providers.ts");

const provider = (overrides = {}) => ({
  getSuggestions: async () => null,
  applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
    const line = lines[cursorLine];
    const from = Math.max(0, cursorCol - prefix.length);
    const next = line.slice(0, from) + item.value + line.slice(cursorCol);
    return { lines: [...lines.slice(0, cursorLine), next, ...lines.slice(cursorLine + 1)], cursorLine, cursorCol: from + item.value.length };
  },
  ...overrides,
});

test("链底：没有候选，但能按前缀应用候选（插件的 applyCompletion 转发给它时才不会断）", async () => {
  const base = createBaseCompletionProvider();
  assert.equal(await base.getSuggestions(["@a"], 0, 2, { signal: new AbortController().signal }), null);
  const applied = base.applyCompletion(["@a"], 0, 2, { value: "src/app.ts", label: "app.ts" }, "@a");
  assert.deepEqual(applied, { lines: ["src/app.ts"], cursorLine: 0, cursorCol: 10 });
  assert.equal(base.shouldTriggerFileCompletion(["@a"], 0, 2), true);
});

test("链的组装顺序：后注册的包住先注册的（外层先跑，返回 null 时落到内层）", async () => {
  const order = [];
  const inner = provider({
    getSuggestions: async () => {
      order.push("inner");
      return { items: [{ value: "one", label: "one" }], prefix: "@" };
    },
  });
  const outer = (current) => provider({
    getSuggestions: async (lines, cursorLine, cursorCol, options) => {
      order.push("outer");
      // 与真实包装 provider 一样：自己没结果时落到下层（pi-fff 就是这么写的）。
      return current.getSuggestions(lines, cursorLine, cursorCol, options);
    },
  });
  const { provider: chain } = buildCompletionChain([() => inner, outer]);
  const result = await chain.getSuggestions(["@a"], 0, 2, { signal: new AbortController().signal });
  assert.deepEqual(order, ["outer", "inner"]);
  assert.deepEqual(result, { items: [{ value: "one", label: "one" }], prefix: "@" });
});
test("triggerCharacters 取并集（对齐 SDK 的 setupAutocompleteProvider）", () => {
  const { triggerCharacters, provider: chain } = buildCompletionChain([
    (current) => provider({ ...current, triggerCharacters: ["@"] }),
    (current) => provider({ ...current, triggerCharacters: ["#", "@"] }),
  ]);
  assert.deepEqual(triggerCharacters, ["@", "#"]);
  assert.deepEqual(chain.triggerCharacters, ["@", "#"]);
});

test("坏工厂被跳过，不影响后面的与链底（一个坏插件不该让补全整体失效）", () => {
  const { provider: chain, skipped } = buildCompletionChain([
    () => {
      throw new Error("boom");
    },
    () => null,
    (current) => provider({ ...current, triggerCharacters: ["@"] }),
  ]);
  assert.equal(skipped, 2);
  assert.deepEqual(chain.triggerCharacters, ["@"]);
});

test("返回值三态：null → none（回退本地）、[] → empty（不回退）、有候选 → items", () => {
  assert.deepEqual(classifyCompletionSuggestions(null), { kind: "none" });
  assert.deepEqual(classifyCompletionSuggestions(undefined), { kind: "none" });
  assert.deepEqual(classifyCompletionSuggestions({ items: [], prefix: "@" }), { kind: "empty" });
  assert.deepEqual(
    classifyCompletionSuggestions({ items: [{ value: "a.ts", label: "a.ts" }], prefix: "@a" }),
    { kind: "items", items: [{ value: "a.ts", label: "a.ts" }], prefix: "@a" },
  );
});

test("坏形状 → invalid（当失败处理，回退本地而不是显示空）", () => {
  assert.deepEqual(classifyCompletionSuggestions("nope"), { kind: "invalid" });
  assert.deepEqual(classifyCompletionSuggestions({ items: "nope" }), { kind: "invalid" });
  // 有 items 但每一条都没有 value → 输出坏了，不是「明确没有候选」
  assert.deepEqual(classifyCompletionSuggestions({ items: [{ label: "x" }] }), { kind: "invalid" });
  assert.deepEqual(classifyCompletionSuggestions({ items: [{ value: "" }] }), { kind: "invalid" });
});

test("候选归一化：丢掉没有 value 的、label 缺失退回 value、description 只留非空串", () => {
  assert.deepEqual(
    normalizeCompletionItems([
      { value: "a", label: "A", description: "d" },
      { value: "b" },
      { label: "no-value" },
      null,
      "x",
      { value: "c", description: "" },
    ]),
    [
      { value: "a", label: "A", description: "d" },
      { value: "b", label: "b" },
      { value: "c", label: "c" },
    ],
  );
});

test("应用候选的返回值归一化：形状不对一律 null（调用方保持文本不变）", () => {
  assert.deepEqual(
    normalizeAppliedCompletion({ lines: ["a"], cursorLine: 0, cursorCol: 1 }),
    { lines: ["a"], cursorLine: 0, cursorCol: 1 },
  );
  assert.equal(normalizeAppliedCompletion(null), null);
  assert.equal(normalizeAppliedCompletion({ lines: ["a"], cursorLine: 0 }), null);
  assert.equal(normalizeAppliedCompletion({ lines: [1], cursorLine: 0, cursorCol: 0 }), null);
  // 行号越界 / 列号越界：宁可不动文本，也不要写到一个不存在的位置
  assert.equal(normalizeAppliedCompletion({ lines: ["a"], cursorLine: 3, cursorCol: 0 }), null);
  assert.equal(normalizeAppliedCompletion({ lines: ["ab"], cursorLine: 0, cursorCol: 9 }), null);
});
