/**
 * 自动重试的中间点不得收尾（2026-10-13 用户实测：重试横幅一闪就没、停止按钮也不见了）。
 *
 * 手法沿用 hooks/useAgentSessionThemeRefresh.test.mjs：从源码里抽出**真实的**
 * `finishAgentRun` 回调，用替身依赖驱动它。
 *
 * - `keepRun`（`agent_end` 带 `willRetry`）：内容照磁盘刷新（把失败那次尝试从时间线里
 *   去掉），但**不收尾** —— 不 completeRun、不 dispatch end、不 onAgentEnd、不清
 *   retryInfo。不收尾才不会把重试横幅 / 停止按钮 / 侧栏计时一起清掉。
 * - 同一次结束会有多路到达（`agent_end` / `prompt_done` / `agent_settled`），只允许收一次。
 * - 刷新期间重试的续跑已经开始（run id 前进）时，旧的收尾不得把新一轮收掉。
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

function makeEnv(options = {}) {
  const state = {
    promptRunId: 3,
    agentRunning: true,
    sendInFlight: false,
    finishingRunId: null,
    completedRunId: null,
  };
  const calls = {
    loadSession: 0, beginRunFinish: 0, releaseRunFinish: 0, completeRun: 0,
    dispatch: 0, onAgentEnd: 0, retryInfo: 0, agentPhase: 0, snapshots: 0,
  };
  const registry = {
    getRunState: () => ({ ...state }),
    beginRunFinish: (_sid, runId) => {
      calls.beginRunFinish += 1;
      if (state.promptRunId !== runId || state.finishingRunId !== null) return false;
      state.finishingRunId = runId;
      return true;
    },
    releaseRunFinish: (_sid, runId) => {
      calls.releaseRunFinish += 1;
      if (state.finishingRunId === runId) state.finishingRunId = null;
    },
    completeRun: (_sid, runId) => {
      calls.completeRun += 1;
      if (state.promptRunId !== runId) return false;
      state.agentRunning = false;
      state.completedRunId = runId;
      return true;
    },
  };
  const env = {
    getOrCreateBrowserSessionRuntimeRegistry: () => registry,
    sessionIdRef: { current: "s1" },
    loadSession: options.loadSession
      ? options.loadSession(calls, state)
      : async () => { calls.loadSession += 1; return { running: true, state: {} }; },
    applyAgentStateSnapshot: () => {},
    notifyAutoFollowEnd: () => {},
    finalizeRunningToolExecutions: (snapshots) => snapshots,
    getToolExecutionSnapshots: (snapshots) => snapshots,
    setToolExecutionSnapshots: () => { calls.snapshots += 1; },
    toolExecutionBufferRef: { current: new Map() },
    dispatch: () => { calls.dispatch += 1; },
    onAgentEnd: () => { calls.onAgentEnd += 1; },
    setAgentPhase: () => { calls.agentPhase += 1; },
    setRetryInfo: () => { calls.retryInfo += 1; },
  };
  return { env, state, calls, registry };
}

test("keepRun（agent_end 带 willRetry）：刷新内容但不收尾，重试横幅/停止按钮/计时都留着", async () => {
  const { env, state, calls } = makeEnv();
  const finish = extractCallback(env, "finishAgentRun");

  await finish("s1", 3, { keepRun: true });

  assert.equal(calls.loadSession, 1, "内容要照磁盘刷新（去掉失败那次尝试）");
  assert.equal(calls.completeRun, 0, "中间点不得把本轮收掉");
  assert.equal(calls.dispatch, 0, "不得派发视图收尾");
  assert.equal(calls.onAgentEnd, 0, "不得触发 run 结束回调");
  assert.equal(calls.retryInfo, 0, "不得清重试横幅");
  assert.equal(calls.agentPhase, 0);
  assert.equal(state.agentRunning, true, "运行态必须留着");
  assert.equal(state.finishingRunId, null, "finally 必须把 claim 放掉，不能卡住后面的收尾");
});

test("不带 keepRun（最终收尾）：照常收口", async () => {
  const { env, state, calls } = makeEnv();
  const finish = extractCallback(env, "finishAgentRun");

  await finish("s1", 3);

  assert.equal(calls.loadSession, 1);
  assert.equal(calls.completeRun, 1);
  assert.equal(calls.dispatch, 1);
  assert.equal(calls.onAgentEnd, 1);
  assert.equal(calls.retryInfo, 1);
  assert.equal(calls.snapshots, 1);
  assert.equal(state.completedRunId, 3);
  assert.equal(state.agentRunning, false);
});

test("同一次结束多路到达（agent_end / prompt_done / agent_settled）：只收一次", async () => {
  const { env, calls } = makeEnv();
  const finish = extractCallback(env, "finishAgentRun");

  await finish("s1", 3);
  await finish("s1", 3);
  await finish("s1", 3);

  assert.equal(calls.loadSession, 1, "已经收过尾就不再重复拉取");
  assert.equal(calls.onAgentEnd, 1, "onAgentEnd 只允许一次（它会刷新侧栏/收尾视图）");
  assert.equal(calls.completeRun, 1);
});

test("刷新期间重试的续跑已经开始：旧的收尾不得把新一轮收掉", async () => {
  const { env, state, calls } = makeEnv({
    loadSession: (callsRef, stateRef) => async () => {
      callsRef.loadSession += 1;
      // 磁盘刷新期间 SDK 的续跑 agent_start 到了：run id 前进、claim 被新一轮清掉
      stateRef.promptRunId = 4;
      stateRef.finishingRunId = null;
      return { running: true, state: {} };
    },
  });
  const finish = extractCallback(env, "finishAgentRun");

  await finish("s1", 3);

  assert.equal(calls.completeRun, 1, "会尝试收掉旧 run");
  assert.equal(state.completedRunId, null, "但不得把新一轮（run 4）标成已结束");
  assert.equal(calls.dispatch, 0, "token 不匹配时不得派发视图收尾");
  assert.equal(calls.onAgentEnd, 0);
});

const KEYWORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "default", "delete", "do", "else",
  "export", "extends", "finally", "for", "function", "if", "import", "in", "instanceof", "let",
  "new", "return", "super", "switch", "this", "throw", "try", "typeof", "var", "void", "while",
  "with", "yield", "async", "await", "of", "as", "true", "false", "null", "undefined",
  "interface", "type", "enum", "implements", "declare", "readonly", "public", "private",
  "protected", "static", "satisfies", "keyof", "infer", "is", "asserts", "namespace", "abstract",
]);

/**
 * 把回调里用到的自由标识符粗略收集出来（局部声明的排除掉）。
 * 目的是给 `new Function(...keys)` 备齐形参名；多余的名字无害。
 */
function freeNames(fnText) {
  const declared = new Set();
  for (const m of fnText.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of fnText.matchAll(/\b(?:const|let|var)\s*[\{\[]([^\}\]]*)[\}\]]/g)) {
    for (const part of m[1].split(",")) {
      const cleaned = part.split(":").pop().trim().replace(/^\.\.\./, "");
      if (/^[A-Za-z_$][\w$]*$/.test(cleaned)) declared.add(cleaned);
    }
  }
  for (const m of fnText.matchAll(/\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>/g)) declared.add(m[1]);
  const used = new Set();
  for (const m of fnText.matchAll(/(?<![\.\w$])([A-Za-z_$][\w$]*)\b/g)) {
    if (!declared.has(m[1]) && !KEYWORDS.has(m[1])) used.add(m[1]);
  }
  return [...used];
}

/** 抽出真实回调，并把自由标识符全部绑好（缺的走 env，再缺走全局，最后给个空函数）。 */
function extractWithFillers(env, name) {
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
  const names = freeNames(expression);
  const values = names.map((n) => (
    n in env ? env[n] : (typeof globalThis[n] !== "undefined" ? globalThis[n] : () => {})
  ));
  return new Function(...names, js + "; return extracted;")(...values);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 事件分支 -> 真实 finishAgentRun -> registry 的端到端：判据是 `willRetry` 严格为 true
 * 才 keepRun。不是源码形状断言 —— 真的调 handleAgentEvent，看 registry 的运行态。
 */
function driveTerminalEvent(event) {
  const { env, state, calls } = makeEnv();
  env.refreshServerSessionStats = () => {};
  env.applyLiveContextUsage = () => {};
  env.addNotice = () => {};
  env.setServerPref = () => {};
  env.setAgentPhase = () => { calls.agentPhase += 1; };
  env.dispatch = () => { calls.dispatch += 1; };
  env.finishAgentRun = extractCallback(env, "finishAgentRun");
  const onEvent = extractWithFillers(env, "handleAgentEvent");
  onEvent(event);
  return { state, calls, settle: () => sleep(20) };
}

test("事件分支：agent_end 带 willRetry 走 keepRun，不收尾", async () => {
  const { state, calls, settle } = driveTerminalEvent({ type: "agent_end", willRetry: true });
  await settle();
  assert.equal(calls.loadSession, 1, "内容照刷");
  assert.equal(state.agentRunning, true, "重试中间点不得判空闲（停止按钮/计时）");
  assert.equal(calls.onAgentEnd, 0, "不得触发 run 结束回调");
  assert.equal(calls.retryInfo, 0, "不得清重试横幅");
});

test("事件分支：agent_end 不带 willRetry、或显式 false，都照常收尾", async () => {
  for (const event of [{ type: "agent_end" }, { type: "agent_end", willRetry: false }]) {
    const { state, calls, settle } = driveTerminalEvent(event);
    await settle();
    assert.equal(state.agentRunning, false, JSON.stringify(event) + " 应当收尾");
    assert.equal(calls.onAgentEnd, 1, JSON.stringify(event) + " 应当收尾");
  }
});

test("事件分支：agent_settled（退避期间被中止）也收尾", async () => {
  const { state, calls, settle } = driveTerminalEvent({ type: "agent_settled", aborted: true });
  await settle();
  assert.equal(state.agentRunning, false, "agent_settled 必须收尾");
  assert.equal(calls.onAgentEnd, 1);
});
