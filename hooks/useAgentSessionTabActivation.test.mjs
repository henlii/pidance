/**
 * 回前台激活路径的可见性同步（issue #86 审查发现的缺口）。
 *
 * 背景：隐藏超阈值会关掉本标签的事件流，而 `connectEvents` 在「本标签不可见」时
 * 直接早退。`visibilitychange` 会先同步可见性，但 `focus` 可能在它之外单独到达
 * （同一浏览器内切换窗口、移动端冻结恢复）。那时若只 notify 不更新可见性，
 * `syncOnTabReturn → ensureEventsConnected → connectEvents` 会被早退吃掉，
 * 表现为回到前台后 SSE 根本不重建。
 *
 * 手法沿用 hooks/useAgentSessionQueue.test.mjs：从源码里抽出真实回调，
 * 用注入的 document / registry / recovery 驱动它。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

/** 抽出 hook 源码里的 `const onActivate = () => {…}`，并用注入环境执行。 */
function extractOnActivate(env) {
  const text = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("hook.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) {
    if (ts.isVariableDeclaration(node)
      && node.name.getText(tree) === "onActivate"
      && node.initializer
      && ts.isArrowFunction(node.initializer)) {
      expression = node.initializer.getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(expression, "Missing onActivate in useAgentSession.ts");
  const js = ts.transpileModule(`const extracted = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(env), `${js}; return extracted;`)(...Object.values(env));
}

/** 记录调用顺序的探针：可见性必须在 notify 之前同步。 */
function env(visibilityState) {
  const calls = [];
  return {
    calls,
    env: {
      document: { visibilityState },
      registry: { setTabVisibility: (visible) => calls.push(`visibility:${visible}`) },
      recovery: { notify: () => calls.push("notify") },
    },
  };
}

test("focus 且可见：先同步可见性、再走激活路径（顺序也要对）", () => {
  const { calls, env: e } = env("visible");
  extractOnActivate(e)();
  assert.deepEqual(
    calls,
    ["visibility:true", "notify"],
    "focus 到达时必须先 setTabVisibility(true)，否则 connectEvents 会早退、SSE 不重建",
  );
});

test("focus 但不可见：什么都不做（不 notify、不改可见性）", () => {
  const { calls, env: e } = env("hidden");
  extractOnActivate(e)();
  assert.deepEqual(calls, [], "不可见时的 focus 不该触发重连");
});
