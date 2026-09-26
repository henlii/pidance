/**
 * 主题变了 → 把已投影行按 entryId 换色（issue #109）。
 *
 * 手法沿用 hooks/useAgentSessionCapabilityNotices.test.mjs：从源码里抽出**真实回调**，
 * 用注入的依赖驱动它。这里额外守住「信号确实被订阅」——刷新逻辑再对，没接上也是白搭，
 * 而订阅写在 useEffect 里没法在这里跑，所以那条用精确表达式断言（不是裸标识符，
 * 免得被旁边的注释或另一处调用蒙混过关）；「信号 → 回调」的行为由真实信号模块驱动。
 *
 * 为什么不能用 loadSession 重拉一页：那条路走 tail 归并（见
 * lib/browser-session-runtime-registry.test.mjs 的对照组），换不到已 prepend 的更早页，
 * 跳读历史时还会把窗口整段换成尾页。所以这里同时断言**没有**调用 loadSession。
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
const { DEFAULT_SESSION_HISTORY_PAGE } = await jiti.import("../lib/session-context-window.ts");

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

const custom = (lines) => ({
  role: "custom",
  customType: "qa",
  content: "probe",
  display: true,
  renderedLines: lines,
});

function makeEnv(options = {}) {
  const {
    sessionId = "s1",
    visibility = "visible",
    entryIds = ["e1", "e2"],
    messages = [custom(["old"])],
    responses = [{ context: { messages: [custom(["new-1"]), custom(["new-2"])], entryIds: ["e1", "e2"] } }],
    fetchThrows = false,
  } = options;
  const calls = { fetch: [], refresh: [], loadSession: [] };
  let responseIndex = 0;
  const env = {
    sessionIdRef: { current: sessionId },
    entryIdsRef: { current: entryIds },
    activeLeafIdRef: { current: null },
    themeRefreshAbortRef: { current: null },
    themeRefreshPendingRef: { current: false },
    document: { visibilityState: visibility },
    // 注入的是真实模块里的常量；两个局部常量在源码模块作用域，测试只能给同值替身。
    DEFAULT_SESSION_HISTORY_PAGE,
    THEME_REFRESH_MAX_ROWS: 500,
    THEME_REFRESH_MAX_HOPS: 4,
    isAbortError: () => false,
    getOrCreateBrowserSessionRuntimeRegistry: () => ({
      getSnapshot: () => ({ messages }),
      // syncOnTabReturn 还要读写事件源；这里给「没有流」的最小替身。
      getEventSource: () => null,
      refreshRenderedLines: (sid, msgs, ids) => {
        calls.refresh.push({ sid, msgs, ids });
        return true;
      },
    }),
    fetch: async (url) => {
      calls.fetch.push(String(url));
      if (fetchThrows) throw new Error("boom");
      const body = responses[Math.min(responseIndex, responses.length - 1)];
      responseIndex += 1;
      return { ok: true, json: async () => body };
    },
    loadSession: (...args) => {
      calls.loadSession.push(args);
      return Promise.resolve(null);
    },
  };
  return { env, calls };
}

/** 把真实回调装进 env（`refreshProjectionForTheme` 会调用它）。 */
function withRealRefresh(env) {
  env.refreshRenderedLinesForTheme = extractCallback(env, "refreshRenderedLinesForTheme");
  return env;
}

test("可见标签：按 entryId 重取新色并交给 registry 套回，且**不**走 loadSession", async () => {
  const { env, calls } = makeEnv();
  withRealRefresh(env);
  const refresh = extractCallback(env, "refreshProjectionForTheme");

  refresh("dark");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.fetch.length, 1, "只发一次读请求");
  const url = calls.fetch[0];
  assert.match(url, /^\/api\/sessions\/s1\/context\?/, "走既有读接口");
  assert.match(url, /around=e1/, "从最早的已加载条起（覆盖已 prepend 的更早页）");
  assert.match(url, /toEnd=1/, "一路取到最新（尾部也要换色）");
  assert.match(url, /deferThinking=1/);
  assert.equal(calls.loadSession.length, 0, "不再用 loadSession 重拉一页");
  assert.equal(calls.refresh.length, 1, "响应交给 registry 按 entryId 套回");
  assert.equal(calls.refresh[0].sid, "s1");
  assert.deepEqual(calls.refresh[0].ids, ["e1", "e2"]);
  assert.equal(calls.refresh[0].msgs[0].renderedLines[0], "new-1");
});

test("隐藏标签：不拉（后台标签不该改自己的阅读窗口），只记一个待办", async () => {
  const { env, calls } = makeEnv({ visibility: "hidden" });
  withRealRefresh(env);
  const refresh = extractCallback(env, "refreshProjectionForTheme");

  refresh("light");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls.fetch, [], "隐藏时不发请求");
  assert.equal(calls.refresh.length, 0);
  assert.equal(env.themeRefreshPendingRef.current, true, "记下待办，等回前台补");
});

test("隐藏期间记下的待办：回前台（syncOnTabReturn）补一次换色，且只补一次", async () => {
  const { env } = makeEnv();
  let refreshed = 0;
  env.refreshRenderedLinesForTheme = () => {
    refreshed += 1;
  };
  env.ensureEventsConnected = () => {};
  env.reconcileAgentState = async () => {};
  const sync = extractCallback(env, "syncOnTabReturn");

  await sync();
  assert.equal(refreshed, 0, "没有待办时不补（回前台的重拉尾页不算换色）");

  env.themeRefreshPendingRef.current = true;
  await sync();
  assert.equal(refreshed, 1, "有待办时补一次");
  assert.equal(env.themeRefreshPendingRef.current, false, "补过就清掉待办");

  await sync();
  assert.equal(refreshed, 1, "不得重复补");
});

test("没有当前会话 / 没有已加载条 / 会话没有 custom 投影行时不发请求", async () => {
  const cases = [
    { name: "没有会话", options: { sessionId: null } },
    { name: "没有已加载条", options: { entryIds: [] } },
    { name: "没有 custom 投影行", options: { messages: [{ role: "user", content: "hi" }] } },
  ];
  for (const item of cases) {
    const { env, calls } = makeEnv(item.options);
    withRealRefresh(env);
    const refresh = extractCallback(env, "refreshProjectionForTheme");
    refresh("dark");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls.fetch, [], `${item.name}：不该发请求`);
  }
});

test("响应里没有消息时不调用 registry（不空发布）", async () => {
  const { env, calls } = makeEnv({ responses: [{ context: { messages: [], entryIds: [] } }] });
  withRealRefresh(env);
  const refresh = extractCallback(env, "refreshProjectionForTheme");

  refresh("dark");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.refresh.length, 0);
});

test("已加载窗口装不下时用 after 续跳，直到覆盖到尾部", async () => {
  const { env, calls } = makeEnv({
    entryIds: ["e1", "e5", "e9"],
    responses: [
      { context: { messages: [custom(["new-1"])], entryIds: ["e1", "e5"] } },
      { context: { messages: [custom(["new-9"])], entryIds: ["e9"] } },
    ],
  });
  withRealRefresh(env);
  const refresh = extractCallback(env, "refreshProjectionForTheme");

  refresh("dark");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.fetch.length, 2, "第一屏没到尾部就再跳一次");
  assert.match(calls.fetch[0], /around=e1/);
  assert.match(calls.fetch[1], /after=e5/, "第二跳从上一屏的末条之后继续");
  assert.doesNotMatch(calls.fetch[1], /around=/);
  assert.deepEqual(calls.refresh.map((call) => call.ids), [["e1", "e5"], ["e9"]]);
});

test("换色请求失败不抛、不置错误态（颜色停在旧档位是可见的既有内容）", async () => {
  const { env, calls } = makeEnv({ fetchThrows: true });
  withRealRefresh(env);
  const refresh = extractCallback(env, "refreshProjectionForTheme");

  refresh("dark");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.refresh.length, 0);
});

test("信号被真正订阅：hook 里存在把 refreshProjectionForTheme 挂到 subscribePiThemeApplied 的 effect", () => {
  // 只防「把 effect 删掉」这类静默失联；真正的「信号 → 回调」行为由下一条用真实信号模块驱动。
  const source = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");
  assert.ok(
    source.includes("useEffect(() => subscribePiThemeApplied(refreshProjectionForTheme), [refreshProjectionForTheme])"),
    "缺少订阅 effect：信号没人听，刷新逻辑等于没接上",
  );
});

test("真实信号驱动真实回调：广播 → notify → 回调被调用一次；同档位回显不重复", async () => {
  const { env, calls } = makeEnv();
  let refreshes = 0;
  env.refreshRenderedLinesForTheme = () => {
    refreshes += 1;
  };
  const refresh = extractCallback(env, "refreshProjectionForTheme");
  resetPiThemeSignalForTests();
  const unsubscribe = subscribePiThemeApplied(refresh);
  try {
    const { notifyPiThemeAppliedFromPrefsPayload } = await jiti.import("../lib/pi-theme-signal.ts");
    notifyPiThemeAppliedFromPrefsPayload({ type: "prefs", changed: { theme: { mode: "dark", style: "chamber" } } });
    notifyPiThemeAppliedFromPrefsPayload({ type: "prefs", changed: { theme: { mode: "dark", style: "chamber" } } });
    notifyPiThemeAppliedFromPrefsPayload({ type: "prefs", changed: { "theme.mode": "light" } });
    assert.equal(refreshes, 2, "两次真实换档位各拉一次（同档位回显被去重）");
    assert.deepEqual(calls.fetch, [], "回调里走的是注入的替身，不该真发请求");
  } finally {
    unsubscribe();
    resetPiThemeSignalForTests();
  }
});

test("重置会清掉去重记忆：reset 之后同档位也会重新通知", () => {
  resetPiThemeSignalForTests();
  assert.equal(notifyPiThemeApplied("dark"), true, "第一次通知");
  assert.equal(notifyPiThemeApplied("dark"), false, "同档位不重复");
  resetPiThemeSignalForTests();
  assert.equal(notifyPiThemeApplied("dark"), true, "reset 清掉记忆后同档位应重新通知");
  resetPiThemeSignalForTests();
});
