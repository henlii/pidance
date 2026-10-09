/**
 * 回前台的那次「重拉尾页」必须看结果（#：后台跑完切回来不刷新）。
 *
 * 背景：切后台期间模型可能已经跑完，浏览器冻结让 SSE 事件全丢；回前台唯一能补消息的路
 * 就是 syncOnTabReturn 里那一次 loadSession。而它可能什么都没补到 —— hydrate 在有 live 事件
 * 之后到达会被判 stale 整份丢弃，磁盘页也可能刚好早于最后一笔 append（页比时间线旧），
 * 两种情况都不报错。于是补一次校验：尾条没推进就再拉一次，最多补一次。
 *
 * 手法沿用 hooks/useAgentSessionThemeRefresh.test.mjs：从源码里抽出**真实回调**，注入依赖驱动。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

/** 抽出 hook 源码里 `const <name> = useCallback((…) => {…}, […])` 的第一个参数（真实函数）。 */
function extractCallback(env, name) {
  const text = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("hook.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(tree) === name &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.arguments.length > 0
    ) {
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

/** 造环境：entryIds 数组就是「时间线尾条」的载体，loadSession 的可选步骤会改它。 */
function makeEnv({ sessionId = "s1", steps = [] } = {}) {
  const slot = { entryIds: ["e1", "e2"] };
  const calls = { loadSession: [], waited: [] };
  let stepIndex = 0;
  const env = {
    sessionIdRef: { current: sessionId },
    themeRefreshPendingRef: { current: new Set() },
    getOrCreateBrowserSessionRuntimeRegistry: () => ({
      getSnapshot: (id) => (id === sessionId ? { entryIds: [...slot.entryIds] } : null),
      getEventSource: () => null,
    }),
    ensureEventsConnected: () => {},
    reconcileAgentState: async () => {},
    refreshRenderedLinesForTheme: async () => {},
    loadSession: async (...args) => {
      calls.loadSession.push(args);
      const step = steps[Math.min(stepIndex, steps.length - 1)];
      stepIndex += 1;
      if (typeof step === "function") step(slot, env);
      return null;
    },
    // 源码模块作用域的常量/工具在测试里给同值替身（抽取出来的函数按名字取自由变量）。
    TAB_RETURN_RELOAD_RETRY_MS: 800,
    delay: async (ms) => {
      calls.waited.push(ms);
    },
    lastEntryIdOfSlot: (snapshot) => {
      const ids = snapshot?.entryIds;
      return ids && ids.length > 0 ? ids[ids.length - 1] : null;
    },
  };
  return { env, calls, slot };
}

test("回前台重拉推进了尾条：只拉一次，不额外请求", async () => {
  const { env, calls } = makeEnv({ steps: [(slot) => slot.entryIds.push("e3")] });
  const sync = extractCallback(env, "syncOnTabReturn");
  await sync();
  assert.equal(calls.loadSession.length, 1, "尾条推进了就不该补跑");
  assert.deepEqual(calls.waited, [], "不该等");
});

test("回前台重拉没推进尾条（stale 丢弃 / 页比时间线旧）：等一小会儿再补一次", async () => {
  const { env, calls } = makeEnv({ steps: [() => {}, (slot) => slot.entryIds.push("e3")] });
  const sync = extractCallback(env, "syncOnTabReturn");
  await sync();
  assert.equal(calls.loadSession.length, 2, "没推进就补跑一次");
  assert.deepEqual(calls.waited, [800], "补跑前要等一下（给落盘与 live 事件让路）");
});

test("两次都没推进：仍然只补一次，不无限重试", async () => {
  const { env, calls } = makeEnv({ steps: [() => {}, () => {}] });
  const sync = extractCallback(env, "syncOnTabReturn");
  await sync();
  assert.equal(calls.loadSession.length, 2, "最多补一次");
});

test("补跑前切走了会话：不再为旧会话重拉（不把 A 的刷新写进 B）", async () => {
  // 第一次重拉期间用户切到了别的会话，且这次没推进尾条 → 本来会触发补跑，必须被拦下。
  const { env, calls } = makeEnv({
    steps: [
      (_slot, e) => {
        e.sessionIdRef.current = "s2";
      },
    ],
  });
  const sync = extractCallback(env, "syncOnTabReturn");
  await sync();
  assert.equal(calls.loadSession.length, 1, "切走后不得再拉旧会话");
  assert.deepEqual(calls.waited, [], "切走后连等都不该等");
});
