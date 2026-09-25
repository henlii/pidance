/**
 * 插件页头 / 页脚槽位的水合（issue #98）。
 *
 * 与 widget、折叠行标签同一类：插件在扩展加载时设一次之后基本不再调用，而那一刻
 * 浏览器常常还没订阅（一次性 SSE 事件直接丢）。所以 /state 快照必须能把它们补回来；
 * 反过来，**字段缺失时要保持本地现状** —— 旧 Host 不带这两个字段，顺手清成 null 会把
 * 刚通过 SSE 到达的槽位抹掉（与 widget / hiddenThinkingLabel 同一口径）。
 *
 * 手法沿用 hooks/useAgentSessionCapabilityNotices.test.mjs：从源码抽出真实回调，
 * 用注入的依赖驱动它，测的是 hook 里那段真代码而不是它的副本。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { sameSlotLines } = await jiti.import("../lib/extension-ui-bridge.ts");

/** 抽出 hook 源码里 `const <name> = useCallback((…) => {…}, […])` 的第一个参数（真实函数）。 */
function extractCallback(env, name) {
  const text = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("hook.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) {
    if (ts.isVariableDeclaration(node)
      && node.name.getText(tree) === name
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && node.initializer.arguments.length > 0) {
      expression = node.initializer.arguments[0].getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(expression, "Missing " + name + " in useAgentSession.ts");
  const js = ts.transpileModule("const extracted = " + expression + ";", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(env), js + "; return extracted;")(...Object.values(env));
}

function makeEnv() {
  const patches = [];
  const applied = { header: null, footer: null };
  const patchExtensionUiState = (patch) => {
    patches.push(patch);
    Object.assign(applied, patch);
  };
  // 真实回调依赖这三样：状态镜像（内容比较用）、patch、以及桥里的行比较函数。
  const applyExtensionSlots = extractCallback(
    { patchExtensionUiState, extensionUiStateRef: { current: applied }, sameSlotLines },
    "applyExtensionSlots",
  );
  return { applyExtensionSlots, patches, applied };
}

test("水合：页头 / 页脚各自独立写入", () => {
  const env = makeEnv();
  env.applyExtensionSlots({ extensionHeader: ["head"] });
  assert.deepEqual(env.patches, [{ header: ["head"] }], "只带页头时不该动页脚");

  env.applyExtensionSlots({ extensionFooter: ["foot"] });
  assert.deepEqual(env.patches.at(-1), { footer: ["foot"] }, "只带页脚时不该动页头");

  env.applyExtensionSlots({ extensionHeader: null, extensionFooter: ["foot 2"] });
  assert.deepEqual(env.applied, { header: null, footer: ["foot 2"] }, "null 是「插件恢复了内置」，要如实清掉");
});

test("水合：字段缺失保持本地现状（旧 Host 不能顺手清空）", () => {
  const env = makeEnv();
  const before = env.patches.length;
  env.applyExtensionSlots({});
  env.applyExtensionSlots(null);
  env.applyExtensionSlots(undefined);
  assert.equal(env.patches.length, before, "缺字段 / 没有状态时一次都不该写");
});

test("水合：空数组按「没有内容」处理（与适配器的替换语义一致）", () => {
  const env = makeEnv();
  env.applyExtensionSlots({ extensionFooter: [] });
  assert.equal(env.applied.footer, null, "空数组不该写成 []（界面按 null 判有没有槽位）");
  assert.equal(env.patches.length, 0, "本来就是 null，不必重复写");

  env.applyExtensionSlots({ extensionFooter: ["x"] });
  assert.deepEqual(env.applied.footer, ["x"]);
  env.applyExtensionSlots({ extensionFooter: [] });
  assert.equal(env.applied.footer, null, "有内容时收到空数组要清掉");
});

test("水合：内容相同的重复投影不写状态（运行中每 1s 回来一次，写一次就重渲一次）", () => {
  const env = makeEnv();
  env.applyExtensionSlots({ extensionHeader: ["a", "b"], extensionFooter: ["f"] });
  const writes = env.patches.length;
  assert.equal(writes, 2, "两个字段各写一次");

  // 新数组、内容相同：身份不同但内容一致，不该再写。
  env.applyExtensionSlots({ extensionHeader: ["a", "b"], extensionFooter: ["f"] });
  assert.equal(env.patches.length, writes, "内容没变就不该写（否则每秒重渲整棵界面）");

  // 内容变了要写。
  env.applyExtensionSlots({ extensionHeader: ["a", "c"] });
  assert.equal(env.patches.length, writes + 1);
  assert.deepEqual(env.applied.header, ["a", "c"]);
});
