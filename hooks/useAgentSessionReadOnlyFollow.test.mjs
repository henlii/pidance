/**
 * 只读（子代理）会话的内容跟随：防抖、命中判定与三条守卫。
 *
 * 这个 effect 没有 host、连不到 per-session 事件流，靠应用级流里的
 * `subagent-runs-changed` 触发尾页重拉。行为上要守住四件事：
 * 1. 只认 `subagent-runs-changed`，且 `sessionIds` 必须含本会话 id；
 * 2. 成串事件合并成一次重拉；
 * 3. 跳读窗口（hasMoreAfter）与正在翻历史（historyLoading）时不重拉 ——
 *    尾页归并会把整段时间线换成最新一屏，用户正在看的那段直接消失；
 * 4. 重拉走静默失败，不把正文换成错误页。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const SOURCE = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");

/** 抽出包含 marker 的那个 useEffect（此处用事件名定位，避开别的 effect）。 */
function extractEffect(env, marker) {
  const tree = ts.createSourceFile("hook.tsx", SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) {
    if (!expression
      && ts.isCallExpression(node)
      && node.expression.getText(tree) === "useEffect"
      && node.arguments.length > 0
      && node.arguments[0].getText(tree).includes(marker)) {
      expression = node.arguments[0].getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(expression, "Missing useEffect containing " + marker);
  const js = ts.transpileModule("const extracted = " + expression + ";", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(env), js + "; return extracted;")(...Object.values(env));
}

const DEBOUNCE_MS = Number(/const READ_ONLY_CONTENT_RELOAD_DEBOUNCE_MS = ([\d_]+);/.exec(SOURCE)?.[1].replace(/_/g, ""));
assert.ok(Number.isFinite(DEBOUNCE_MS) && DEBOUNCE_MS > 0, "READ_ONLY_CONTENT_RELOAD_DEBOUNCE_MS 必须能从源码读出来");

function makeEnv(options = {}) {
  const calls = [];
  let listener = null;
  const timers = new Map();
  let nextTimerId = 1;
  const sid = options.sid ?? "child-session";
  const env = {
    READ_ONLY_CONTENT_RELOAD_DEBOUNCE_MS: DEBOUNCE_MS,
    session: options.noSession ? null : { id: sid, readOnly: options.writable ? undefined : true },
    sessionIdRef: { current: options.switchedAway ? "other-session" : sid },
    hasMoreAfterRef: { current: options.jumpWindow === true },
    historyLoadingRef: { current: options.historyLoading === true },
    loadSessionRef: {
      current: (...args) => calls.push({ kind: "loadSession", args }),
    },
    subscribeAppEvents: (handler) => {
      calls.push({ kind: "subscribe" });
      listener = handler;
      return () => calls.push({ kind: "unsubscribe" });
    },
    document: { visibilityState: options.hidden ? "hidden" : "visible" },
    setTimeout: (fn, ms) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
  };
  return {
    env,
    sid,
    emit: (payload) => listener?.(payload),
    kinds: () => calls.map((call) => call.kind),
    loads: () => calls.filter((call) => call.kind === "loadSession").map((call) => call.args),
    runTimers: () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); } },
    pendingTimers: () => timers.size,
  };
}

const frame = (sessionIds) => ({ type: "subagent-runs-changed", sessionIds });

test("命中本会话才重拉：用静默失败，不把正文换成错误页", () => {
  const { env, sid, emit, loads, runTimers } = makeEnv();
  extractEffect(env, "subagent-runs-changed")();
  emit(frame([sid]));
  runTimers();
  const calls = loads();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], sid);
  assert.deepEqual(calls[0][6], { silentFailure: true }, "后台跟随必须静默失败");
});

test("sessionIds 不含本会话：不重拉", () => {
  const { env, emit, loads, runTimers } = makeEnv();
  extractEffect(env, "subagent-runs-changed")();
  emit(frame(["some-other-child"]));
  runTimers();
  assert.equal(loads().length, 0);
});

test("别的应用级事件（运行集/偏好）不触发", () => {
  const { env, emit, loads, runTimers } = makeEnv();
  extractEffect(env, "subagent-runs-changed")();
  emit({ type: "running", runningSessionIds: [] });
  emit({ type: "prefs", key: "theme" });
  emit(null);
  runTimers();
  assert.equal(loads().length, 0);
});

test("成串事件合并成一次重拉", () => {
  const { env, sid, emit, loads, runTimers } = makeEnv();
  extractEffect(env, "subagent-runs-changed")();
  emit(frame([sid]));
  emit(frame([sid]));
  emit(frame([sid]));
  runTimers();
  assert.equal(loads().length, 1);
});

test("跳读窗口不重拉（尾页归并会把时间线整段换掉）", () => {
  const { env, sid, emit, loads, runTimers } = makeEnv({ jumpWindow: true });
  extractEffect(env, "subagent-runs-changed")();
  emit(frame([sid]));
  runTimers();
  assert.equal(loads().length, 0);
});

test("正在向上翻历史时不重拉（会 abort 那次分页）", () => {
  const { env, sid, emit, loads, runTimers } = makeEnv({ historyLoading: true });
  extractEffect(env, "subagent-runs-changed")();
  emit(frame([sid]));
  runTimers();
  assert.equal(loads().length, 0);
});

test("标签页隐藏时不重拉", () => {
  const { env, sid, emit, loads, runTimers } = makeEnv({ hidden: true });
  extractEffect(env, "subagent-runs-changed")();
  emit(frame([sid]));
  runTimers();
  assert.equal(loads().length, 0);
});

test("会话已经切走：未决的防抖要丢掉", () => {
  const { env, sid, emit, loads, runTimers } = makeEnv({ switchedAway: true });
  extractEffect(env, "subagent-runs-changed")();
  emit(frame([sid]));
  runTimers();
  assert.equal(loads().length, 0);
});

test("清理后退订并取消未决定时器", () => {
  const { env, sid, emit, loads, kinds, runTimers, pendingTimers } = makeEnv();
  const cleanup = extractEffect(env, "subagent-runs-changed")();
  emit(frame([sid]));
  assert.equal(pendingTimers(), 1);
  cleanup();
  assert.equal(pendingTimers(), 0);
  assert.equal(kinds().includes("unsubscribe"), true);
  runTimers();
  assert.equal(loads().length, 0);
});

test("非只读会话不订阅", () => {
  const { env, kinds } = makeEnv({ writable: true });
  extractEffect(env, "subagent-runs-changed")();
  assert.deepEqual(kinds(), []);
});

test("没有会话时不订阅", () => {
  const { env, kinds } = makeEnv({ noSession: true });
  extractEffect(env, "subagent-runs-changed")();
  assert.deepEqual(kinds(), []);
});
