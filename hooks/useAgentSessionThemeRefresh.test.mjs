/**
 * 主题变了 → 重拉当前会话一页（issue #109）。
 *
 * 手法沿用 hooks/useAgentSessionCapabilityNotices.test.mjs：从源码里抽出**真实回调**，
 * 用注入的依赖驱动它。这里额外守住「信号确实被订阅」——刷新逻辑再对，没接上也是白搭，
 * 而订阅写在 useEffect 里没法在这里跑，所以那条用精确表达式断言（不是裸标识符，
 * 免得被旁边的注释或另一处调用蒙混过关）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { notifyPiThemeApplied, resetPiThemeSignalForTests, subscribePiThemeApplied } = await jiti.import(
  "../lib/pi-theme-signal.ts",
);

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

function makeEnv(sessionId) {
  const calls = [];
  const env = {
    sessionIdRef: { current: sessionId },
    loadSession: (...args) => {
      calls.push(args);
      return Promise.resolve(null);
    },
  };
  return { env, calls };
}

test("主题变更信号 → 重拉当前会话的 tail 页（不置 loading、不取状态）", () => {
  const { env, calls } = makeEnv("s9");
  const refresh = extractCallback(env, "refreshProjectionForTheme");
  refresh("dark");
  assert.deepEqual(calls, [["s9", false, false]], "应调用 loadSession(sid, false, false)");
});

test("没有当前会话时不发请求（空标签、正在切会话）", () => {
  // 注意别用默认参数区分 undefined：那会把「没有会话」当成没传参而落回默认值（本题踩过）。
  for (const sessionId of [null, undefined, ""]) {
    const { env, calls } = makeEnv(sessionId);
    const refresh = extractCallback(env, "refreshProjectionForTheme");
    refresh("light");
    assert.deepEqual(calls, [], `sessionId=${String(sessionId)} 时不该发请求`);
  }
});

test("信号被真正订阅：hook 里存在把 refreshProjectionForTheme 挂到 subscribePiThemeApplied 的 effect", () => {
  const source = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");
  assert.ok(
    source.includes("useEffect(() => subscribePiThemeApplied(refreshProjectionForTheme), [refreshProjectionForTheme])"),
    "缺少订阅 effect：信号没人听，刷新逻辑等于没接上",
  );
});

test("真实信号驱动真实回调：广播 → notify → 回调被调用一次；同档位回显不重复", async () => {
  const { env, calls } = makeEnv("s3");
  const refresh = extractCallback(env, "refreshProjectionForTheme");
  resetPiThemeSignalForTests();
  const unsubscribe = subscribePiThemeApplied(refresh);
  try {
    const { notifyPiThemeAppliedFromPrefsPayload } = await jiti.import("../lib/pi-theme-signal.ts");
    notifyPiThemeAppliedFromPrefsPayload({ type: "prefs", changed: { theme: { mode: "dark", style: "chamber" } } });
    notifyPiThemeAppliedFromPrefsPayload({ type: "prefs", changed: { theme: { mode: "dark", style: "chamber" } } });
    notifyPiThemeAppliedFromPrefsPayload({ type: "prefs", changed: { "theme.mode": "light" } });
    assert.deepEqual(calls, [["s3", false, false], ["s3", false, false]], "两次真实换档位各拉一次");
    assert.equal(notifyPiThemeApplied("dark"), true, "重置后第一次仍应通知");
  } finally {
    unsubscribe();
    resetPiThemeSignalForTests();
  }
});
