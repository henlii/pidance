/**
 * 能力提示的水合重放（issue #93）。
 *
 * 背景：宿主自己发的降级提示（notifyUnsupported / notifyLimitedSupport）走一次性
 * SSE 事件，而 host 启动、扩展加载、注册监听器都发生在浏览器订阅之前 —— 那一刻没有
 * 订阅者，事件直接丢掉，这条「可见降级」提示在实践中用户永远看不到
 * （实测：服务端日志 5 次、页面 DOM 0 次）。修法与 pendingExtensionRequests /
 * activeCustomUi 同一路子：状态快照带上、hydration 时补一遍。
 *
 * 但"只补一遍"还不够：快照在 host 存活期间一直留着，水合会反复发生，用户点掉提示后
 * 下一次水合会把它当成"还没显示过"再弹回来（关不掉）。所以补之前要按 id 认领
 * （claimNoticeHandoff）——本文件另一半测的就是这条。
 *
 * 手法沿用 hooks/useAgentSessionTabActivation.test.mjs：从源码里抽出真实回调，
 * 用注入的依赖驱动它；去重与 dismiss 用真实的通知队列。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { pickCapabilityNotices, applyExtensionUiRequest } = await jiti.import("../lib/extension-ui-bridge.ts");
const { createNoticeQueueStore } = await jiti.import("../lib/notice-queue-store.ts");
const { capabilityFeatureOf, loadSeenCapabilityFeatures, markCapabilityFeatureSeen } = await jiti.import("../lib/capability-notice-seen.ts");

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

/**
 * 一套"页面加载"的环境：真实的 claimNoticeHandoff + applyCapabilityNotices +
 * handleExtensionUiRequest（SSE 路径），共享一份 handedNoticeIdsRef 与通知队列。
 */
function makeEnv(options = {}) {
  const store = createNoticeQueueStore();
  // 「每种能力只提示一次」的记忆：默认每个 env 一份（= 新浏览器），传同一个就模拟整页刷新。
  const storage = options.storage ?? (() => {
    const map = new Map();
    return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => void map.set(k, v) };
  })();
  const hasSeenCapabilityFeature = (feature) => (feature ? loadSeenCapabilityFeatures(storage).has(feature) : false);
  const rememberCapabilityFeature = (feature) => markCapabilityFeatureSeen(storage, feature);
  store.activate("s1");
  const calls = [];
  const handedNoticeIdsRef = { current: new Set() };
  const claimNoticeHandoff = extractCallback({ handedNoticeIdsRef }, "claimNoticeHandoff");
  // 模拟 useNoticeState.addNotice 的会话回退：显式 sessionId 优先，缺省 / null 用当前会话。
  const addNotice = (notice) => {
    calls.push(notice);
    store.enqueue({ ...notice, sessionId: notice.sessionId ?? "s1" });
  };
  const applyCapabilityNotices = extractCallback(
    { pickCapabilityNotices, addNotice, claimNoticeHandoff, capabilityFeatureOf, hasSeenCapabilityFeature, rememberCapabilityFeature },
    "applyCapabilityNotices",
  );
  const handleExtensionUiRequest = extractCallback({
    applyExtensionUiRequest,
    extensionUiStateRef: { current: {} },
    commitExtensionUiState: () => {},
    claimNoticeHandoff,
    addNotice,
    addLiveActivity: () => {},
    setExtensionWindowTitle: () => {},
    // 插件的 setTheme 走这条（issue #97）：环境里不给的话，用例一旦构造出
    // setThemeMode 副作用就会是 ReferenceError 而不是断言失败。
    applyExternallyRequestedTheme: (mode) => {
      calls.push({ kind: "setThemeMode", mode });
    },
    opts: {},
    capabilityFeatureOf,
    hasSeenCapabilityFeature,
    rememberCapabilityFeature,
  }, "handleExtensionUiRequest");
  return { store, calls, storage, handedNoticeIdsRef, claimNoticeHandoff, applyCapabilityNotices, handleExtensionUiRequest };
}

const notice = (id) => ({ id, message: 'Extension UI "x" is limited', notifyType: "warning" });
const notifyRequest = (id, message) => ({ type: "extension_ui_request", id, method: "notify", message, notifyType: "warning" });

test("订阅前发出的能力提示：hydration 时补进来（宿主提示必须可见）", () => {
  const { applyCapabilityNotices, calls, store } = makeEnv();
  applyCapabilityNotices({
    sessionId: "s1",
    extensionCapabilityNotices: [{ ...notice("n1"), message: 'Extension UI "onTerminalInput" is limited by the Pidance web client: …' }],
  });
  assert.equal(calls.length, 1, "快照里有能力提示就必须补进通知队列");
  assert.equal(calls[0].id, "n1");
  assert.equal(calls[0].type, "warning", "能力提示是 warning，走重要档位（可见且不被自动过期）");
  assert.equal(store.queueLength("s1"), 1);
});

test("水合必须显式带上状态自己的会话 id：不能靠「此刻激活的是哪个会话」", () => {
  const { applyCapabilityNotices, calls, store } = makeEnv();
  // 冷挂载：会话切换与首次 loadSession 同 tick 时，通知队列的"当前会话"可能还停在
  // 上一个会话/空。那时若省略 sessionId，通知会进错队列，这条提示永远不会显示。
  applyCapabilityNotices({ sessionId: "s1", extensionCapabilityNotices: [notice("n1")] });
  assert.equal(calls[0].sessionId, "s1", "必须把状态自己的 sessionId 传给 addNotice");
  assert.equal(store.queueLength("s1"), 1, "归属正确的会话才显示得出来");
  // 旧 Host 不带 sessionId 时退回"当前会话"（不凭空造一个 id）——队列按 activeSessionId 收。
  // 换一个能力名：这一条验的是"显式带 sessionId"，不是一次性抑制
  applyCapabilityNotices({ extensionCapabilityNotices: [{ ...notice("n2"), message: 'Extension UI "anotherFeature" is limited' }] });
  assert.equal(calls[1].sessionId, null, "缺 sessionId 时按既有语义走当前会话（null = 当前）");
  assert.equal(store.queueLength("s1"), 2, "缺 sessionId 的那条也要落进当前会话的队列");
});

// ---------------------------------------------------------------------------
// P0：关掉提示后不得被下一次水合弹回来
// ---------------------------------------------------------------------------

test("关掉提示后再次水合不得弹回来（快照一直在，水合会反复发生）", () => {
  const { applyCapabilityNotices, store } = makeEnv();
  const state = { sessionId: "s1", extensionCapabilityNotices: [notice("n1")] };
  applyCapabilityNotices(state);
  assert.equal(store.queueLength("s1"), 1, "先正常补进来");
  store.dismiss("n1"); // 用户点掉：队列里删掉，没有"已关闭"集合
  assert.equal(store.queueLength("s1"), 0);
  // reconcile / prompt 收尾 / 切回前台 / run 结束都会再水合一次
  applyCapabilityNotices(state);
  applyCapabilityNotices(state);
  assert.equal(store.queueLength("s1"), 0, "关掉之后的水合必须跳过（否则等于关不掉）");
  assert.deepEqual(store.getVisible(), [], "可见列表也不能再冒出来");
});

test("页面已订阅时发出的提示（走 SSE 事件）也要认领：关掉后水合同样不得弹回来", () => {
  const { handleExtensionUiRequest, applyCapabilityNotices, store } = makeEnv();
  // 新建会话 / 换 cwd 会让宿主在页面已订阅之后才加载扩展 → 提示走 SSE 到达这条分支。
  handleExtensionUiRequest(notifyRequest("n7", 'Extension UI "onTerminalInput" is limited by the Pidance web client: …'));
  assert.equal(store.queueLength("s1"), 1, "SSE 到达时正常显示");
  store.dismiss("n7");
  applyCapabilityNotices({ sessionId: "s1", extensionCapabilityNotices: [notice("n7")] });
  assert.equal(store.queueLength("s1"), 0, "同一条 id 已通过 SSE 交过，水合必须跳过");
});

test("认领按 id：插件自己的 notify 占用的 id 不影响别的宿主提示", () => {
  const { handleExtensionUiRequest, applyCapabilityNotices, store } = makeEnv();
  // 插件通知走同一条 SSE 分支，因此也会被记进"已交给队列"的集合——但它不在重放
  // 集合里（水合只带宿主能力提示），所以它既不会被重放，也不该挡住别的提示。
  handleExtensionUiRequest(notifyRequest("p1", "subagent failed"));
  assert.equal(store.queueLength("s1"), 1);
  store.dismiss("p1");
  applyCapabilityNotices({ sessionId: "s1", extensionCapabilityNotices: [notice("n8")] });
  assert.equal(store.queueLength("s1"), 1, "另一个 id 的宿主提示照常进来");
  applyCapabilityNotices({ sessionId: "s1", extensionCapabilityNotices: [] });
  assert.equal(store.queueLength("s1"), 1, "插件通知不在快照里，所以水合不会把它重放出来");
});

test("同一个浏览器里同一种能力只提示一次：整页刷新也不再弹（storage 是共享的）", () => {
  const storage = (() => {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => void map.set(k, v),
    };
  })();
  const first = makeEnv({ storage });
  first.applyCapabilityNotices({ sessionId: "s1", extensionCapabilityNotices: [notice("n1")] });
  assert.equal(first.store.queueLength("s1"), 1, "第一次要看到");
  first.store.dismiss("n1");
  // 整页刷新：新 hook 实例 + 新通知队列，但 localStorage 还在（这就是用户看到的"还是报"）。
  const second = makeEnv({ storage });
  second.applyCapabilityNotices({ sessionId: "s1", extensionCapabilityNotices: [notice("n1")] });
  assert.equal(second.store.queueLength("s1"), 0, "同一能力刷新后不得再提示");
  // 换了能力（新插件/新边界）仍然要提示一次。
  second.applyCapabilityNotices({
    sessionId: "s1",
    extensionCapabilityNotices: [{ ...notice("n2"), message: 'Extension UI "brandNewFeature" is limited' }],
  });
  assert.equal(second.store.queueLength("s1"), 1, "新能力仍要提示");
});

test("切走再切回同一会话不算刷新：本页已经交过就不重弹", () => {
  const { applyCapabilityNotices, store } = makeEnv();
  const stateA = { sessionId: "s1", extensionCapabilityNotices: [notice("n1")] };
  applyCapabilityNotices(stateA);
  store.dismiss("n1");
  // 切到别的会话再切回来（同一个 hook 实例 = 同一份 ref；ChatWindow 不会因切会话重挂载）
  store.activate("s2");
  store.activate("s1");
  applyCapabilityNotices(stateA);
  assert.equal(store.queueLength("s1"), 0, "切回来不得重弹（不是整页刷新）");
});

// ---------------------------------------------------------------------------
// 订阅前后各到一次 / 缺字段 / 两条水合路径
// ---------------------------------------------------------------------------

test("同一条在订阅前后各到一次：只显示一条（认领 + 队列去重）", () => {
  const { applyCapabilityNotices, store } = makeEnv();
  // 真实顺序：先订阅到的（SSE）→ 后快照补的（hydration）
  store.enqueue({ sessionId: "s1", id: "n1", message: "x", type: "warning" });
  const state = { sessionId: "s1", extensionCapabilityNotices: [notice("n1")] };
  applyCapabilityNotices(state);
  applyCapabilityNotices(state);
  assert.equal(store.queueLength("s1"), 1, "同 id 到两次只显示一条（否则每次 hydrate 都多一条）");
});

test("缺字段（旧 Host）不得凭空造通知", () => {
  const { applyCapabilityNotices, calls, store } = makeEnv();
  applyCapabilityNotices({});
  applyCapabilityNotices(null);
  applyCapabilityNotices({ extensionCapabilityNotices: undefined });
  assert.deepEqual(calls, [], "缺字段（旧 Host）不得凭空造通知");
  assert.equal(store.queueLength("s1"), 0);
});

test("两条 hydration 路径都要补能力提示（否则冷挂载那条仍然看不到）", () => {
  const text = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("hook.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const bodies = { applyExtensionUiProjection: "", applyAgentStateSnapshot: "" };
  function visit(node) {
    if (ts.isVariableDeclaration(node)
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && node.initializer.arguments.length > 0) {
      const name = node.name.getText(tree);
      if (name in bodies) bodies[name] = node.initializer.arguments[0].getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  for (const [name, body] of Object.entries(bodies)) {
    assert.ok(body.length > 0, "Missing " + name + " in useAgentSession.ts");
    void body;
  }
  // #110 之后两条路径**共用同一份投影**：热状态那条自己应用字段，
  // run 结束/reconcile 那条委托过去。断言委托存在（并禁止它再逐字段抄一遍），
  // 否则又会退化成「漏抄一个字段」。
  assert.match(bodies.applyExtensionUiProjection, /applyCapabilityNotices\(state\)/, "统一投影必须补能力提示（冷挂载那条路径）");
  assert.match(bodies.applyAgentStateSnapshot, /applyExtensionUiProjection\(state\)/, "run 结束/reconcile 路径必须委托给统一投影");
  assert.doesNotMatch(bodies.applyAgentStateSnapshot, /applyCapabilityNotices\(state\)/, "不要在单条路径里再逐字段抄一遍扩展 UI 投影");
});

test("SSE 那条通知分支必须认领（否则页面已订阅时发出的提示仍然关不掉）", () => {
  const text = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("hook.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body = "";
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "handleExtensionUiRequest" && node.initializer) {
      body = node.initializer.getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(body.length > 0, "Missing handleExtensionUiRequest");
  // 接线断言：真实行为由上面「走 SSE 事件」那条测试覆盖。
  assert.match(body, /claimNoticeHandoff\(effect\.id\)/, "notice 分支必须先认领再入队");
});

test("插件的 setTheme 事件把壳的明暗交给主题切换（issue #97）", () => {
  const { handleExtensionUiRequest, calls } = makeEnv();
  handleExtensionUiRequest({ type: "extension_ui_request", id: "t1", method: "setTheme", mode: "light" });
  assert.deepEqual(
    calls.filter((c) => c.kind === "setThemeMode"),
    [{ kind: "setThemeMode", mode: "light" }],
    "SSE 到达的 setTheme 必须真的走到壳的主题切换（漏接就是「插件切了主题但界面没变」）",
  );
});
