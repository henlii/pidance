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
    snapshotEntryIds = null,
    snapshotMissing = false,
    // 窗口形态现在由**该会话 slot** 决定（registry 快照上的 hasMoreAfter），不再是视图 ref。
    hasMoreAfter = false,
    // 需要「两个会话各自不同形态」时用这个：{ [sid]: { entryIds?, messages?, hasMoreAfter? } }
    slots = null,
    onFetch = null,
  } = options;
  const calls = { fetch: [], refresh: [], loadSession: [] };
  let responseIndex = 0;
  const env = {
    sessionIdRef: { current: sessionId },
    entryIdsRef: { current: entryIds },
    activeLeafIdRef: { current: null },
    // 换色请求按会话各自可取消（见 useAgentSession 的注释）
    themeRefreshAbortRef: { current: new Map() },
    // 待办是按会话的集合（见 useAgentSession 的注释）
    themeRefreshPendingRef: { current: new Set() },
    document: { visibilityState: visibility },
    // 注入的是真实模块里的常量；两个局部常量在源码模块作用域，测试只能给同值替身。
    DEFAULT_SESSION_HISTORY_PAGE,
    THEME_REFRESH_MAX_ROWS: 500,
    THEME_REFRESH_MAX_HOPS: 4,
    THEME_REFRESH_MAX_PENDING: 8,
    isAbortError: () => false,
    getOrCreateBrowserSessionRuntimeRegistry: () => ({
      // 默认不给 entryIds（退回到 entryIdsRef）；snapshotEntryIds/snapshotMissing 用来验「按 slot 取数」。
      getSnapshot: (id) => {
        if (snapshotMissing) return null;
        if (slots) {
          const slot = slots[id];
          // 给了 slots 就只认它：不在里面的会话当「没有 slot」（已被回收 / 已删除）。
          if (!slot) return null;
          return {
            messages: slot.messages ?? messages,
            entryIds: slot.entryIds ?? entryIds,
            hasMoreAfter: slot.hasMoreAfter === true,
          };
        }
        return {
          messages,
          ...(snapshotEntryIds ? { entryIds: snapshotEntryIds } : {}),
          hasMoreAfter: hasMoreAfter === true,
        };
      },
      // syncOnTabReturn 还要读写事件源；这里给「没有流」的最小替身。
      getEventSource: () => null,
      refreshRenderedLines: (sid, msgs, ids) => {
        calls.refresh.push({ sid, msgs, ids });
        return true;
      },
    }),
    fetch: async (url) => {
      calls.fetch.push(String(url));
      if (onFetch) onFetch(url);
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

/** 把真实回调装进 env（`refreshProjectionForTheme` 会调用它）。
 *  注意顺序：记待办的辅助要**先**进 env —— 抽出来的函数体是按当时的 Object.keys(env)
 *  生成形参的，晚于抽取再加的键在函数体里是 ReferenceError。 */
function withRealRefresh(env) {
  if (!env.markThemeRefreshPending) env.markThemeRefreshPending = extractCallback(env, "markThemeRefreshPending");
  env.refreshRenderedLinesForTheme = extractCallback(env, "refreshRenderedLinesForTheme");
  return env;
}

/** 记待办的辅助也在 hook 体里（refreshProjectionForTheme 调用它）。 */
function withRealPendingMarker(env) {
  env.markThemeRefreshPending = extractCallback(env, "markThemeRefreshPending");
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
  withRealPendingMarker(env);
  const refresh = extractCallback(env, "refreshProjectionForTheme");

  refresh("light");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls.fetch, [], "隐藏时不发请求");
  assert.equal(calls.refresh.length, 0);
  assert.deepEqual([...env.themeRefreshPendingRef.current], ["s1"], "记下**该会话**的待办，等回前台补");
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

  env.themeRefreshPendingRef.current.add("s1");
  await sync();
  assert.equal(refreshed, 1, "有待办时补一次");
  assert.deepEqual([...env.themeRefreshPendingRef.current], [], "补过就清掉待办");

  await sync();
  assert.equal(refreshed, 1, "不得重复补");
});

test("隐藏期间换主题 + 切了会话：回前台补的是被切走那个会话（待办按会话记）", async () => {
  const { env } = makeEnv();
  withRealPendingMarker(env);
  const refreshed = [];
  env.refreshRenderedLinesForTheme = (sid) => {
    refreshed.push(sid);
  };
  env.ensureEventsConnected = () => {};
  env.reconcileAgentState = async () => {};
  const refresh = extractCallback(env, "refreshProjectionForTheme");
  const sync = extractCallback(env, "syncOnTabReturn");

  env.document.visibilityState = "hidden";
  refresh("light");
  assert.deepEqual([...env.themeRefreshPendingRef.current], ["s1"], "隐藏时待办记在当时的当前会话上");

  // 用户切到 s2 之后才回前台
  env.sessionIdRef.current = "s2";
  env.document.visibilityState = "visible";
  await sync();
  assert.deepEqual(refreshed, ["s1"], "补的是被切走的 s1 的 slot，不是现在的 s2");
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

test("跳读窗口：显式 toEnd=0 + 正中锚点（路由的 toEnd 缺省是「取到叶尾」，不写 0 等于没改）", async () => {
  const { env, calls } = makeEnv({
    hasMoreAfter: true,
    entryIds: ["e1", "e5", "e9"],
    responses: [{ context: { messages: [custom(["new-5"])], entryIds: ["e5"] } }],
  });
  withRealRefresh(env);
  const refresh = extractCallback(env, "refreshProjectionForTheme");

  refresh("dark");
  await new Promise((resolve) => setTimeout(resolve, 0));
  // 第一跳之后可能还有续跳，这里只钉第一跳（后面那条用例管续跳）。
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(calls.fetch[0], /toEnd=0/, "必须显式 toEnd=0：缺省等于取到叶尾，会把窗口之后几千条拉下来");
  assert.doesNotMatch(calls.fetch[0], /toEnd=1/);
  assert.match(calls.fetch[0], /around=e5/, "锚点取窗口正中（一跳覆盖整个 around 窗口）");
});

test("取数走该会话 slot 的已加载条，而不是当前视图（回前台补被切走会话的前提）", async () => {
  const { env, calls } = makeEnv({
    sessionId: "s2",
    entryIds: ["e1", "e2"],
    snapshotEntryIds: ["x1", "x2"],
    responses: [{ context: { messages: [custom(["new-1"])], entryIds: ["x1"] } }],
  });
  withRealRefresh(env);
  await env.refreshRenderedLinesForTheme("s1");
  assert.match(calls.fetch[0], /sessions\/s1\/context/, "请求发给目标会话");
  assert.match(calls.fetch[0], /around=x1/, "锚点取该会话 slot 的最早已加载条，不是当前视图的 e1");
  assert.doesNotMatch(calls.fetch[0], /leafId=/, "非当前会话不带 leafId（该用服务端自己的活动叶）");
});

test("窗口形态按**该会话 slot** 判定（切会话 / 后台补待办不会用错档位）", async () => {
  const { env, calls } = makeEnv({
    sessionId: "s1",
    slots: {
      s1: { entryIds: ["e1", "e2"], messages: [custom(["old"])], hasMoreAfter: false },
      s2: { entryIds: ["f1", "f3"], messages: [custom(["old"])], hasMoreAfter: true },
    },
  });
  withRealRefresh(env);

  // s2 是跳读窗口：哪怕现在看的是 s1，也必须显式 toEnd=0 + 正中锚点。
  await env.refreshRenderedLinesForTheme("s2");
  const s2First = calls.fetch.find((url) => url.includes("sessions/s2/context"));
  assert.ok(s2First, "给 s2 发了请求");
  assert.match(s2First, /toEnd=0/, "跳读窗口的会话补色不能取到叶尾");
  assert.match(s2First, /around=f3/, "锚点取该会话窗口正中");

  // s1 是尾部窗口：照旧 toEnd=1 + 最早锚点。
  await env.refreshRenderedLinesForTheme("s1");
  const s1First = calls.fetch.find((url) => url.includes("sessions/s1/context"));
  assert.ok(s1First, "给 s1 发了请求");
  assert.match(s1First, /toEnd=1/, "尾部窗口一次覆盖到叶尾");
  assert.match(s1First, /around=e1/);
});

test("两个会话一起补色：各自一个 controller，后一个不取消前一个", async () => {
  const { env, calls } = makeEnv({
    sessionId: "s1",
    slots: {
      s1: { entryIds: ["e1"], messages: [custom(["old"])], hasMoreAfter: false },
      s2: { entryIds: ["f1"], messages: [custom(["old"])], hasMoreAfter: false },
    },
  });
  const seen = [];
  env.fetch = (url, init) => {
    seen.push({ url: String(url), signal: init?.signal });
    const ids = String(url).includes("sessions/s1/") ? ["e1"] : ["f1"];
    return new Promise((resolve) => {
      setTimeout(() => resolve({ ok: true, json: async () => ({ context: { messages: [custom(["new"])], entryIds: ids } }) }), 30);
    });
  };
  withRealRefresh(env);

  const first = env.refreshRenderedLinesForTheme("s1");
  const second = env.refreshRenderedLinesForTheme("s2");
  assert.equal(seen.length, 2, "两个会话各发一次请求");
  // 共用一个 controller 时，第二次调用会把第一次 abort 掉 —— 被取消的会话永远换不上色。
  assert.equal(seen[0].signal.aborted, false, "给 s2 发请求不得取消 s1 的（必须各会话一个 controller）");
  await Promise.all([first, second]);
  assert.deepEqual([...calls.refresh.map((call) => call.sid)].sort(), ["s1", "s2"], "两个会话都套上了色");
});

test("回前台一次补多个待办：串行补到，slot 已经没了的跳过", async () => {
  const { env } = makeEnv({
    slots: { s1: { entryIds: ["e1"], messages: [custom(["old"])], hasMoreAfter: false } },
  });
  const order = [];
  const realFetch = env.fetch;
  env.fetch = async (url, init) => {
    order.push(String(url));
    return realFetch(url, init);
  };
  withRealRefresh(env);
  env.ensureEventsConnected = () => {};
  env.reconcileAgentState = async () => {};
  env.loadSession = () => Promise.resolve(null);
  const sync = extractCallback(env, "syncOnTabReturn");

  env.themeRefreshPendingRef.current.add("s1");
  env.themeRefreshPendingRef.current.add("gone");
  await sync();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(order.some((url) => url.includes("sessions/s1/")), "待办里的 s1 要补上");
  assert.ok(!order.some((url) => url.includes("sessions/gone/")), "slot 已经没了的会话跳过（不空发请求）");
  assert.deepEqual([...env.themeRefreshPendingRef.current], [], "消费完就清空待办");
});

test("视图切走仍写进该会话 slot，并把剩余跳数记成它的待办（不静默丢）", async () => {
  const { env, calls } = makeEnv({
    entryIds: ["e1", "e5", "e9"],
    responses: [{ context: { messages: [custom(["new-1"])], entryIds: ["e1"] } }],
    // 响应回来的那一刻用户已经切到别的会话
    onFetch: () => {
      env.sessionIdRef.current = "s2";
    },
  });
  withRealRefresh(env);
  withRealPendingMarker(env);
  await env.refreshRenderedLinesForTheme("s1");

  assert.equal(calls.refresh.length, 1, "这次响应仍要写进 s1 的 slot");
  assert.equal(calls.refresh[0].sid, "s1");
  assert.deepEqual([...env.themeRefreshPendingRef.current], ["s1"], "没覆盖完，记成 s1 的待办");
  assert.equal(calls.fetch.length, 1, "视图不在了就不再续跳（剩下交给待办）");
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

test("待办集合：同一会话只记一次（重记会刷到最近），超过上界丢最旧的", () => {
  const { env } = makeEnv();
  withRealPendingMarker(env);
  const mark = env.markThemeRefreshPending;
  const pending = env.themeRefreshPendingRef.current;

  mark("s1");
  mark("s1");
  assert.deepEqual([...pending], ["s1"], "同一会话不重复记");

  for (let i = 2; i <= 8; i += 1) mark("s" + i);
  assert.equal(pending.size, 8, "到上界为止不丢（上界就是 8）");

  // 重记一个**仍在集合里**的会话：必须排到队尾 —— 不刷位置的话下一轮淘汰的就是它。
  mark("s1");
  assert.deepEqual([...pending].at(-1), "s1", "重记要刷到最近");
  mark("s9");
  assert.equal(pending.size, 8, "超过上界就丢最旧的（否则隐藏期间看过的会话会无界滞留）");
  assert.equal(pending.has("s1"), true, "刚重记过的不该被淘汰");
  assert.equal(pending.has("s2"), false, "被淘汰的是最早的 s2");
  assert.equal(pending.has("s9"), true, "最新入队的留着");
});
