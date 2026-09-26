/**
 * 「本会话刚被别的标签/端唤醒」时的补连与补状态（issue #110）。
 *
 * 场景：本端打开的是一个空闲会话 —— attach 既不 wake 也不连流，而
 * `/api/agent/<id>/events` 对没有 live host 的会话直接 404。host 被别的标签/端唤醒后，
 * 本端既没有事件流、也没有 agent_start，插件在**宿主建立那一刻**注册的东西
 * （按键监听器计数、快捷键、补全 provider）就永远收不到，只能等下一次状态投影
 * （运行中 15s、空闲最长 120s）或整页刷新。
 *
 * 修法：复用已有的应用级流（`/api/agent/running/events`，运行集变化时才广播，
 * 心跳是注释帧）当信号 —— 本会话出现在运行集里且本端没有有效事件流时，补连一次并
 * reconcile 一次。这里测的就是这条触发器的边界：只认自己的会话、已有流就不动、
 * 只读会话不订阅。
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

/** 记录式环境：订阅被记下来，可以手动喂 payload。 */
function makeEnv(options = {}) {
  const calls = [];
  let listener = null;
  const env = {
    calls,
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
    reconcileAgentState: (sessionId) => calls.push({ kind: "reconcileAgentState", sessionId }),
  };
  return { env, emit: (payload) => listener?.(payload), kinds: () => calls.map((call) => call.kind) };
}

test("本会话出现在运行集里且本端没有有效事件流：补连一次 + reconcile 一次", () => {
  const { env, emit, kinds } = makeEnv();
  extractEffect(env, "subscribeAppEvents")({});
  emit({ type: "running", runningSessionIds: ["other", "s1"] });
  assert.deepEqual(kinds(), ["subscribe", "hasActiveEventStream", "ensureEventsConnected", "reconcileAgentState"]);
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

test("非运行集载荷（如偏好变更）不触发", () => {
  const { env, emit, kinds } = makeEnv();
  extractEffect(env, "subscribeAppEvents")({});
  emit({ type: "prefs", key: "theme" });
  emit({ type: "running" });
  emit(null);
  assert.deepEqual(kinds(), ["subscribe"]);
});

test("只读会话不订阅（SSE 会 403）", () => {
  const { env, kinds } = makeEnv({ readOnly: true });
  extractEffect(env, "subscribeAppEvents")({});
  assert.deepEqual(kinds(), []);
});

test("没有会话时不订阅", () => {
  const { env, kinds } = makeEnv({ noSession: true });
  extractEffect(env, "subscribeAppEvents")({});
  assert.deepEqual(kinds(), []);
});

test("effect 的清理函数就是订阅的退订", () => {
  const { env, kinds } = makeEnv();
  const cleanup = extractEffect(env, "subscribeAppEvents")({});
  assert.equal(typeof cleanup, "function");
  cleanup();
  assert.deepEqual(kinds(), ["subscribe", "unsubscribe"]);
});
