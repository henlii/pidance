/**
 * 「本会话刚被别的标签/端唤醒」时的补状态（issue #110）。
 *
 * 场景：本端打开的是一个空闲会话 —— attach 既不 wake 也不连流，而
 * `/api/agent/<id>/events` 对没有 live host 的会话直接 404。host 被别的标签/端唤醒后，
 * 本端既没有事件流、也没有 agent_start，插件在**宿主建立那一刻**注册的东西
 * （按键监听器计数、快捷键、补全 provider）就永远收不到，只能等下一次状态投影
 * （运行中 15s、空闲最长 120s）或整页刷新。
 *
 * 修法：复用已有的应用级流（`/api/agent/running/events`，运行集变化时才广播）当信号 ——
 * 本会话出现在运行集里且本端没有有效事件流时，**立刻对一次账**；状态还没 live 就短重试几次。
 *
 * 两条边界必须守住（issue #110 审查阻断）：
 * 1. **不要在这里补连事件流**。那条广播最早的一帧发生在宿主 `start()` 里绑定扩展的时候，
 *    此时 host 还没进 registry、状态里没有 `state`；而一旦补连，`hasActiveEventStream`
 *    变 true 会让定时对账掉到 `RECONCILE_IDLE_MS`（120s）且不再对账 —— 而那条流拿不到
 *    一次性事件（`lib/stream-snapshot.ts` 的 default 分支丢掉 `extension_ui_request`）。
 *    结果是状态比「不补连」更晚才投影。连流交给 `registry.reconcile` 里那句
 *    「live && !isCurrent → connectEvents」（那一次先拿到 state，会先投影）。
 * 2. **未 live 要短重试**：host 进 registry 之后运行集已经不含本会话，不会再有下一帧广播，
 *    「只对一次账」接不住那一拍。重试有上限，之后由定时对账兜底。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const SOURCE = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");

/** 抽出「body 里出现 marker 的那个 useEffect」的第一个参数（回调本身）。 */
function extractEffect(env, marker) {
  const tree = ts.createSourceFile("hook.tsx", SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) {
    if (ts.isCallExpression(node)
      && node.expression.getText(tree) === "useEffect"
      && node.arguments.length > 0
      && node.arguments[0].getText(tree).includes(marker)) {
      expression = node.arguments[0].getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(expression, "Missing useEffect containing " + marker + " in useAgentSession.ts");
  const js = ts.transpileModule("const extracted = " + expression + ";", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(env), js + "; return extracted;")(...Object.values(env));
}

/** 源码里的重试预算（跟着实现走，避免测试自己编一套数）。 */
const RETRY_MAX = Number(/const APP_EVENTS_WAKE_RETRY_MAX = (\d+);/.exec(SOURCE)?.[1]);
const RETRY_MS = Number(/const APP_EVENTS_WAKE_RETRY_MS = ([\d_]+);/.exec(SOURCE)?.[1].replace(/_/g, ""));
assert.ok(Number.isFinite(RETRY_MAX) && RETRY_MAX > 0, "APP_EVENTS_WAKE_RETRY_MAX 必须能从源码读出来");
assert.ok(Number.isFinite(RETRY_MS) && RETRY_MS > 0, "APP_EVENTS_WAKE_RETRY_MS 必须能从源码读出来");

/** 让 async 续体跑完（probe 里 await 了 reconcileAgentState）。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 记录式环境：订阅被记下来可手动喂 payload；定时器换成可手动驱动的假实现；
 * `reconcileAgentState` 按 options.liveResults 依次返回（默认一直 live）。
 */
function makeEnv(options = {}) {
  const calls = [];
  let listener = null;
  const timers = new Map();
  let nextTimerId = 1;
  let reconcileCount = 0;
  const liveResults = options.liveResults ?? [];
  const env = {
    calls,
    APP_EVENTS_WAKE_RETRY_MS: RETRY_MS,
    APP_EVENTS_WAKE_RETRY_MAX: RETRY_MAX,
    session: options.noSession ? null : { id: options.sessionId ?? "s1", ...(options.readOnly ? { readOnly: true } : {}) },
    subscribeAppEvents: (handler) => {
      calls.push({ kind: "subscribe" });
      listener = handler;
      return () => calls.push({ kind: "unsubscribe" });
    },
    getOrCreateBrowserSessionRuntimeRegistry: () => ({
      hasActiveEventStream: (sessionId) => {
        calls.push({ kind: "hasActiveEventStream", sessionId });
        return options.activeStream === true;
      },
    }),
    ensureEventsConnected: (sessionId) => calls.push({ kind: "ensureEventsConnected", sessionId }),
    reconcileAgentState: async (sessionId) => {
      calls.push({ kind: "reconcileAgentState", sessionId });
      const live = liveResults.length > 0 ? liveResults[Math.min(reconcileCount, liveResults.length - 1)] : true;
      reconcileCount += 1;
      return live;
    },
    setTimeout: (fn, ms) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { fn, ms });
      calls.push({ kind: "setTimeout", ms });
      return id;
    },
    clearTimeout: (id) => {
      if (timers.has(id)) {
        timers.delete(id);
        calls.push({ kind: "clearTimeout" });
      }
    },
  };
  return {
    env,
    emit: (payload) => listener?.(payload),
    kinds: () => calls.map((call) => call.kind),
    pendingTimers: () => [...timers.values()],
    runAllTimers: async () => {
      // 反复取出并跑「当前已排的」定时器，直到没有新的（重试会再排下一跳）。
      for (let guard = 0; guard < 50; guard += 1) {
        const next = [...timers.entries()][0];
        if (!next) return;
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      throw new Error("定时器没有收敛（可能重试没有上限）");
    },
  };
}

test("本会话出现在运行集里且本端没有有效事件流：立刻对账一次，且**不**补连事件流", () => {
  const { env, emit, kinds } = makeEnv();
  extractEffect(env, "subscribeAppEvents")({});
  emit({ type: "running", runningSessionIds: ["other", "s1"] });
  assert.deepEqual(kinds(), ["subscribe", "hasActiveEventStream", "reconcileAgentState"]);
  // 阻断回归的守门：补连会让 hasActiveEventStream 变 true，定时对账就掉到 120s 档。
  assert.equal(
    kinds().includes("ensureEventsConnected"),
    false,
    "这条路径不得补连事件流（会让定时对账从 15s 降到 120s）",
  );
});

test("运行集里没有本会话：什么都不做（广播是全局的）", () => {
  const { env, emit, kinds } = makeEnv();
  extractEffect(env, "subscribeAppEvents")({});
  emit({ type: "running", runningSessionIds: ["other"] });
  // 先判「有没有我」（便宜），再问本端有没有流，所以这里不该出现 hasActiveEventStream。
  assert.deepEqual(kinds(), ["subscribe"]);
});

test("本端已有有效事件流：不动（广播不是「你该重连」）", () => {
  const { env, emit, kinds } = makeEnv({ activeStream: true });
  extractEffect(env, "subscribeAppEvents")({});
  emit({ type: "running", runningSessionIds: ["s1"] });
  assert.deepEqual(kinds(), ["subscribe", "hasActiveEventStream"]);
});

test("状态还没 live 时短重试，直到服务端说 live 就停", async () => {
  // 第一次对账打的是「host 还没进 registry」那一拍（live=false），随后才 live。
  const { env, emit, kinds, pendingTimers, runAllTimers } = makeEnv({ liveResults: [false, true] });
  extractEffect(env, "subscribeAppEvents")({});
  emit({ type: "running", runningSessionIds: ["s1"] });
  await flush();
  assert.equal(kinds().filter((k) => k === "reconcileAgentState").length, 1, "先立刻对一次账");
  assert.equal(pendingTimers().length, 1, "未 live 应排一次重试");
  await runAllTimers();
  assert.equal(kinds().filter((k) => k === "reconcileAgentState").length, 2, "重试再对一次账");
  assert.equal(pendingTimers().length, 0, "live 之后不再排重试");
  assert.equal(kinds().includes("ensureEventsConnected"), false, "整条重试都不补连事件流");
});

test("重试有上限：一直不 live 也不会无限对账", async () => {
  const { env, emit, kinds, pendingTimers, runAllTimers } = makeEnv({ liveResults: [false] });
  extractEffect(env, "subscribeAppEvents")({});
  emit({ type: "running", runningSessionIds: ["s1"] });
  await flush();
  await runAllTimers();
  assert.equal(
    kinds().filter((k) => k === "reconcileAgentState").length,
    1 + RETRY_MAX,
    "总共 1 次即时 + 上限次重试",
  );
  assert.equal(pendingTimers().length, 0, "用完之后交给定时对账，不再自己排");
});

test("清理函数：退订并取消未决重试", async () => {
  const { env, emit, kinds, runAllTimers } = makeEnv({ liveResults: [false] });
  const cleanup = extractEffect(env, "subscribeAppEvents")({});
  emit({ type: "running", runningSessionIds: ["s1"] });
  await flush();
  const before = kinds().filter((k) => k === "reconcileAgentState").length;
  cleanup();
  await runAllTimers();
  assert.equal(kinds().includes("unsubscribe"), true, "清理函数应退订");
  assert.equal(
    kinds().filter((k) => k === "reconcileAgentState").length,
    before,
    "退订后未决重试不得再对账（否则切走会话还在写）",
  );
});

test("非运行集载荷（如偏好变更）不触发", () => {
  const { env, emit, kinds } = makeEnv();
  extractEffect(env, "subscribeAppEvents")({});
  emit({ type: "prefs", key: "theme" });
  emit({ type: "running" });
  emit(null);
  assert.deepEqual(kinds(), ["subscribe"]);
});

test("只读会话不订阅（不会有属于它的 host，随后的会话流才是 403）", () => {
  const { env, kinds } = makeEnv({ readOnly: true });
  extractEffect(env, "subscribeAppEvents")({});
  assert.deepEqual(kinds(), []);
});

test("没有会话时不订阅", () => {
  const { env, kinds } = makeEnv({ noSession: true });
  extractEffect(env, "subscribeAppEvents")({});
  assert.deepEqual(kinds(), []);
});

test("effect 的清理函数包含订阅的退订", () => {
  const { env, kinds } = makeEnv();
  const cleanup = extractEffect(env, "subscribeAppEvents")({});
  assert.equal(typeof cleanup, "function");
  cleanup();
  assert.equal(kinds().includes("unsubscribe"), true);
});
