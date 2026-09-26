/**
 * 扩展 UI 投影字段的应用**只能有一处**（issue #110）。
 *
 * 背景：`hooks/useAgentSession.ts` 里有两条「拿到服务端状态就应用」的路径：
 *
 * - `applyExtensionUiProjection(state)`：页面打开 / 切会话 / reconcile 用，**全字段**；
 * - `applyAgentStateSnapshot(sid, state)`：**run 结束**（agent_end 后 loadSession）与
 *   reconcile 用，原先逐字段抄了一遍，抄漏了 `applyExtensionShortcuts`。
 *
 * 于是插件注册的快捷键（以及任何以后新增的扩展 UI 字段）只有「页面打开/切会话」那条路
 * 会带上，其余时候要等下一次投影（空闲最长 120s）或整页刷新 —— 实测就是
 * 「Ctrl+Alt+7 按了没反应，刷新后立刻能用」。
 *
 * 所以这里守两件事：
 * 1. 同一份 state 走两条路径，**被应用的扩展 UI 字段集合必须一致**（以后新增字段如果
 *    只加在一条路上，这条断言就红）；
 * 2. run 结束路径必须真的应用 `extensionShortcuts`（#110 的具体回归）。
 *
 * 手法沿用 hooks/useAgentSessionCapabilityNotices.test.mjs：从源码里抽出真实回调，
 * 用注入的依赖驱动它（`applyAgentStateSnapshot` 注入的是**真实的**那条投影函数）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const SOURCE = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");

/** 抽出 hook 源码里 `const <name> = useCallback((…) => {…}, […])` 的第一个参数。 */
function extractCallback(env, name) {
  const tree = ts.createSourceFile("hook.tsx", SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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
 * 扩展 UI 的「字段 → 应用函数」对应表。字段名与 `AgentStateResponse` 一致。
 * 新增扩展 UI 投影字段时**只应该动这里和源码的投影函数**。
 */
const FIELD_PROBES = [
  { field: "extensionStatuses", apply: "applyStatuses", value: [{ key: "k", text: "v" }] },
  { field: "extensionWidgets", apply: "applyWidgets", value: [{ key: "w", lines: ["x"] }] },
  { field: "extensionTerminalInputListenerCount", apply: "applyListenerCount", value: 2 },
  { field: "extensionShortcuts", apply: "applyShortcuts", value: [{ key: "ctrl+alt+7", available: true }] },
  { field: "extensionAutocompleteProviderCount", apply: "applyAutocomplete", value: 1 },
  { field: "extensionHiddenThinkingLabel", apply: "applyHiddenThinkingLabel", value: "检索记忆…" },
  { field: "extensionHeader", apply: "applySlots", value: [] },
  { field: "extensionCapabilityNotices", apply: "applyCapabilityNotices", value: [{ id: "n1", message: "x" }] },
  { field: "pendingExtensionRequests", apply: "applyQueue", value: [{ id: "req-1", method: "input" }] },
  { field: "activeCustomUi", apply: "applyActiveCustomUi", value: null },
];

/** 一份「全部字段都带」的状态快照。 */
function fullState() {
  const state = {};
  for (const probe of FIELD_PROBES) state[probe.field] = probe.value;
  return state;
}

/** 造一份记录式环境：每个应用函数只记「自己被调用过」。 */
function makeEnv() {
  const applied = [];
  const env = {
    applied,
    patchExtensionUiState: (patch) => {
      for (const key of Object.keys(patch)) {
        // statuses / widgets / 阻塞队列走同一个 patch 入口，按 key 区分；其它 key 记为
        // `applyPatch:<key>`——新字段如果只走 patch 而没进投影函数/探针表，会被下面那条
        // 「投影覆盖每个字段」的断言抓住（否则它会混进 applyQueue 里悄悄通过）。
        if (key === "statuses") applied.push("applyStatuses");
        else if (key === "widgets") applied.push("applyWidgets");
        else if (key === "blockingQueue" || key === "dialog") applied.push("applyQueue");
        else applied.push("applyPatch:" + key);
      }
    },
    applyExtensionListenerCount: () => applied.push("applyListenerCount"),
    applyExtensionShortcuts: () => applied.push("applyShortcuts"),
    applyExtensionAutocomplete: () => applied.push("applyAutocomplete"),
    applyExtensionHiddenThinkingLabel: () => applied.push("applyHiddenThinkingLabel"),
    applyExtensionSlots: () => applied.push("applySlots"),
    applyCapabilityNotices: () => applied.push("applyCapabilityNotices"),
    applyActiveCustomUi: () => applied.push("applyActiveCustomUi"),
    filterSettledBlockingRequests: (queue) => queue,
    pickBlockingExtensionRequests: (value) => (Array.isArray(value) ? value : []),
    projectBlockingHead: () => ({}),
    extensionUiStateRef: { current: { blockingQueue: [] } },
    settledRequestIdsRef: { current: new Set() },
  };
  return env;
}

/**
 * 一套**共享同一个记录器**的环境：这样 applyAgentStateSnapshot 内部调用真实投影函数时，
 * 两个路径写的记录落在同一个数组里（分成两次运行、中间清空即可区分）。
 */
function makeSharedEnv() {
  const env = makeEnv();
  const applyExtensionUiProjection = extractCallback(env, "applyExtensionUiProjection");
  const applyAgentStateSnapshot = extractCallback({
    ...env,
    applyExtensionUiProjection,
    canApplyProjection: () => true,
    // 参数先求值：canApplyProjection 的两个实参里读了 sessionIdRef。
    sessionIdRef: { current: "s1" },
    setContextUsage: () => {},
    seedTurnMetricsFromState: () => {},
    setSystemPrompt: () => {},
    isThinkingLevel: () => false,
    applyRemoteThinking: () => {},
    setLastKnownModel: () => {},
    setIsCompacting: () => {},
    applyProjectedQueues: () => {},
  }, "applyAgentStateSnapshot");
  return { env, applyExtensionUiProjection, applyAgentStateSnapshot };
}

test("两条状态应用路径对同一份快照应用同一组扩展 UI 字段（新增字段漏抄一条就红）", () => {
  const shared = makeSharedEnv();
  shared.applyExtensionUiProjection(fullState());
  const viaProjection = new Set(shared.env.applied);
  shared.env.applied.length = 0;
  shared.applyAgentStateSnapshot("s1", fullState());
  const viaSnapshot = new Set(shared.env.applied);

  const missing = [...viaProjection].filter((name) => !viaSnapshot.has(name));
  assert.deepEqual(
    missing,
    [],
    "run 结束/reconcile 路径没有应用这些扩展 UI 字段：" + missing.join(", "),
  );
});

test("投影函数覆盖探针表里的每个字段（把某个字段从投影里删掉就红）", () => {
  const env = makeEnv();
  const projection = extractCallback(env, "applyExtensionUiProjection");
  projection(fullState());
  const applied = new Set(env.applied);
  const expected = [...new Set(FIELD_PROBES.map((probe) => probe.apply))];
  const missing = expected.filter((name) => !applied.has(name));
  assert.deepEqual(
    missing,
    [],
    "applyExtensionUiProjection 没有应用这些扩展 UI 字段：" + missing.join(", "),
  );
  // 未登记的 patch key（例如有人加了字段只走 patchExtensionUiState）：单独失败，
  // 提示把字段补进投影函数与 FIELD_PROBES。
  const unknownPatchKeys = [...applied].filter((name) => name.startsWith("applyPatch:"));
  assert.deepEqual(unknownPatchKeys, [], "投影写了未登记的 patch key：" + unknownPatchKeys.join(", "));
});

test("run 结束路径会应用插件快捷键清单（#110：Ctrl+Alt+7 要等刷新才生效）", () => {
  const shared = makeSharedEnv();
  shared.applyAgentStateSnapshot("s1", { extensionShortcuts: [{ key: "ctrl+alt+7", available: true }] });
  assert.ok(
    shared.env.applied.includes("applyShortcuts"),
    "run 结束路径必须应用 extensionShortcuts，否则插件快捷键要等页面重开",
  );
});

test("run 结束路径自己的会话级字段没有被这次收敛弄丢", () => {
  // 收敛只替换了「扩展 UI 字段」那一段：contextUsage / systemPrompt / model / 队列 /
  // 活动 custom 面板这些会话级字段仍必须照旧应用（否则是修一个漏、丢一批）。
  const env = makeEnv();
  const seen = [];
  const applyExtensionUiProjection = () => seen.push("projection");
  const applyAgentStateSnapshot = extractCallback({
    ...env,
    applyExtensionUiProjection,
    canApplyProjection: () => true,
    sessionIdRef: { current: "s1" },
    setContextUsage: () => seen.push("contextUsage"),
    seedTurnMetricsFromState: () => seen.push("turnMetrics"),
    setSystemPrompt: () => seen.push("systemPrompt"),
    isThinkingLevel: () => true,
    thinkingGenerationRef: { current: 1 },
    applyRemoteThinking: () => seen.push("thinkingLevel"),
    setLastKnownModel: () => seen.push("model"),
    setIsCompacting: () => seen.push("isCompacting"),
    applyProjectedQueues: () => seen.push("queuedMessages"),
  }, "applyAgentStateSnapshot");
  applyAgentStateSnapshot("s1", {
    contextUsage: { tokens: 1 },
    systemPrompt: "s",
    thinkingLevel: "high",
    model: { provider: "p", modelId: "m" },
    isCompacting: false,
    queuedMessages: [],
  });
  assert.deepEqual(seen, ["contextUsage", "turnMetrics", "systemPrompt", "thinkingLevel", "model", "isCompacting", "projection", "queuedMessages"]);
});
