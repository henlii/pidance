/**
 * Issue #100 审查修复：面板的收起由服务端驱动。
 *
 * 两条要锁住的行为：
 * 1. 收到 `extension_ui_settled` → 立刻把该 id 从待处理队列里移除，**不发**响应
 *    （宿主已经结算过了；多标签下响应只从一个标签发出，别的标签也要立刻收起）；
 * 2. 与结算**并发**的状态响应（在宿主结算之前序列化的，里面还有这个 id）不能把
 *    已经结束的面板装回来 —— 那是「倒计时到 0 面板还挂着」的另一半。
 *
 * 手法沿用 hooks/useAgentSessionCapabilityNotices.test.mjs：从源码里抽出真实回调，
 * 把依赖注进去驱动；队列推进用真实的 lib 纯函数。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  clearExtensionUiRequest,
  createEmptyExtensionUiState,
  filterSettledBlockingRequests,
  parseExtensionUiSettledId,
  pickBlockingExtensionRequests,
  projectBlockingHead,
  rememberSettledRequestId,
} = await jiti.import("../lib/extension-ui-bridge.ts");

/** 抽出 `const <name> = useCallback((…) => {…}, […])` 的第一个参数（真实函数）。 */
function extractCallback(file, env, name) {
  const text = readFileSync(new URL(file, import.meta.url), "utf8");
  const tree = ts.createSourceFile("src.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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
  assert.ok(expression, "Missing " + name + " in " + file);
  const js = ts.transpileModule("const extracted = " + expression + ";", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(env), js + "; return extracted;")(...Object.values(env));
}

const dialogRequest = (id) => ({
  type: "extension_ui_request",
  id,
  method: "select",
  title: "选一个",
  options: ["一", "二"],
});

/** 一套客户端环境：真实的队列推进 + 真实的两个 hook 回调，状态与 ref 与线上同形。 */
function makeEnv(initialQueue = []) {
  let state = {
    ...createEmptyExtensionUiState(),
    blockingQueue: initialQueue,
    dialog: initialQueue[0] ?? null,
  };
  const patches = [];
  const extensionUiStateRef = { current: state };
  const settledRequestIdsRef = { current: [] };
  const commitExtensionUiState = (next) => {
    state = next;
    extensionUiStateRef.current = next;
    patches.push(next);
  };
  const patchExtensionUiState = (patch) => commitExtensionUiState({ ...extensionUiStateRef.current, ...patch });

  // 真实回调（hooks/useExtensionUiState.ts）
  const dismissExtensionUiRequest = extractCallback(
    "./useExtensionUiState.ts",
    { extensionUiStateRef, commitExtensionUiState, clearExtensionUiRequest },
    "dismissExtensionUiRequest",
  );
  const markExtensionUiRequestSettled = extractCallback(
    "./useExtensionUiState.ts",
    { settledRequestIdsRef, rememberSettledRequestId },
    "markExtensionUiRequestSettled",
  );

  // 明确放一个间谍：结算路径**不许**回响应（宿主已经结算过了）。
  const respondToExtensionUi = (...args) => {
    throw new Error("extension_ui_settled 不该发响应：" + JSON.stringify(args));
  };

  const applyExtensionUiSettled = extractCallback(
    "./useAgentSession.ts",
    { parseExtensionUiSettledId, markExtensionUiRequestSettled, dismissExtensionUiRequest, respondToExtensionUi },
    "applyExtensionUiSettled",
  );

  const applyExtensionUiProjection = extractCallback(
    "./useAgentSession.ts",
    {
      applyActiveCustomUi: () => {},
      applyCapabilityNotices: () => {},
      // 合并 #96 后，这个回调里多了一句「应用插件折叠行标签」；它只改展示，
      // 与这里断言的队列过滤无关，所以给个空实现（少了它整段回调会 ReferenceError）。
      applyExtensionHiddenThinkingLabel: () => {},
      // 同理（issue #98）：这个回调里还多了一句「水合页头/页脚槽位」，与队列过滤无关。
      applyExtensionSlots: () => {},
      applyExtensionListenerCount: () => {},
      extensionUiStateRef,
      filterSettledBlockingRequests,
      patchExtensionUiState,
      pickBlockingExtensionRequests,
      projectBlockingHead,
      settledRequestIdsRef,
    },
    "applyExtensionUiProjection",
  );

  return {
    applyExtensionUiSettled,
    applyExtensionUiProjection,
    extensionUiStateRef,
    patches,
    settledRequestIdsRef,
    state: () => extensionUiStateRef.current,
  };
}

test("收到 extension_ui_settled：面板立刻消失，且不回响应", () => {
  const request = dialogRequest("req-1");
  const env = makeEnv([request]);
  assert.equal(env.state().dialog?.id, "req-1", "前置：面板正在显示");

  env.applyExtensionUiSettled({ type: "extension_ui_settled", id: "req-1", reason: "timeout" });

  assert.equal(env.state().dialog, null, "面板必须立刻收起（不等下一次状态投影）");
  assert.deepEqual(env.state().blockingQueue, [], "队列里也不能留");
  assert.deepEqual(env.settledRequestIdsRef.current, ["req-1"], "要记住这个 id，挡住迟到的快照");
});

test("extension_ui_settled 形状不对时什么都不做", () => {
  const env = makeEnv([dialogRequest("req-1")]);
  for (const bad of [null, "x", { type: "extension_ui_request", id: "req-1" }, { type: "extension_ui_settled" }]) {
    env.applyExtensionUiSettled(bad);
  }
  assert.equal(env.state().dialog?.id, "req-1", "面板不受影响");
  assert.deepEqual(env.settledRequestIdsRef.current, []);
});

test("结算后到达的旧快照不能再把面板装回来", () => {
  const request = dialogRequest("req-1");
  const env = makeEnv([request]);
  env.applyExtensionUiSettled({ type: "extension_ui_settled", id: "req-1", reason: "timeout" });
  env.patches.length = 0;

  // 这份状态响应是在宿主结算**之前**序列化的，里面还有那个 id。
  env.applyExtensionUiProjection({ pendingExtensionRequests: [request] });

  assert.equal(env.state().dialog, null, "已结算的面板不能被旧快照复活");
  assert.deepEqual(env.state().blockingQueue, []);
  assert.equal(
    env.patches.some((item) => (item.blockingQueue ?? []).some((entry) => entry.id === "req-1")),
    false,
    "不该有任何把 req-1 装回队列的提交",
  );
});

test("对照组：没有结算记录时，同一份快照照常装回（确认过滤不是恒真）", () => {
  const request = dialogRequest("req-1");
  const env = makeEnv([]);
  assert.equal(env.state().dialog, null);

  env.applyExtensionUiProjection({ pendingExtensionRequests: [request] });

  assert.equal(env.state().dialog?.id, "req-1", "另一个会话/没结算过的 id 仍要能水合出来");
});

test("结算只影响自己那个 id，队列里别的请求照常推进", () => {
  const first = dialogRequest("req-1");
  const second = dialogRequest("req-2");
  const env = makeEnv([first, second]);
  assert.equal(env.state().dialog?.id, "req-1");

  env.applyExtensionUiSettled({ type: "extension_ui_settled", id: "req-1", reason: "timeout" });

  assert.equal(env.state().dialog?.id, "req-2", "队首推进到下一个请求");
  assert.deepEqual(env.state().blockingQueue.map((item) => item.id), ["req-2"]);
});
