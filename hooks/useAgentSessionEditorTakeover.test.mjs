/**
 * 插件编辑器接管（issue #107）在 hook 里的两半：
 *
 * 1. **水合**：`/state` 的 `extensionEditorComponent` 快照补回接管内容（插件在页面订阅前
 *    就设好了工厂，一次性 SSE 事件在那时直接丢）；缺字段保持现状、同 id 不覆盖更新的行。
 * 2. **提交**：组件调的 `onSubmit(text)` 必须走**既有发送入口**（运行中入 follow-up 队列，
 *    空闲走发送入口），**不得**在这个回调里直连服务端 —— 队列 / 写者所有权 / 只读判定
 *    都在那条管线里，绕过去这些语义就各说各话。
 *
 * 手法沿用 hooks/useAgentSessionExtensionSlots.test.mjs：从源码抽出**真实回调**，
 * 用注入的依赖驱动它。注意用的 env 里**故意没有** sendAgentCommand / fetch：
 * 这个回调一旦想直连服务端就会当场 ReferenceError，这本身就是「不直连」的证明。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { applyExtensionUiRequest, createEmptyExtensionUiState } = await jiti.import("../lib/extension-ui-bridge.ts");
const { asBracketedPaste } = await jiti.import("../lib/terminal-input.ts");

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

function makeHydrationEnv(initial = createEmptyExtensionUiState()) {
  const state = { current: initial };
  const committed = [];
  const applyExtensionEditorTakeover = extractCallback({
    patchExtensionUiState: (patch) => {
      state.current = { ...state.current, ...patch };
      committed.push({ patch });
    },
    commitExtensionUiState: (next) => {
      state.current = next;
      committed.push({ committed: next });
    },
    extensionUiStateRef: state,
    applyExtensionUiRequest,
  }, "applyExtensionEditorTakeover");
  return { applyExtensionEditorTakeover, state, committed };
}

const takeOver = (id, lines, extra = {}) => ({ id, lines, ...extra });

test("水合：缺字段保持现状（旧 Host 不该把刚由 SSE 拿到的接管清掉）", () => {
  const env = makeHydrationEnv(applyExtensionUiRequest(createEmptyExtensionUiState(), {
    type: "extension_ui_request", id: "live", method: "editorComponent", lines: ["live"],
  }).state);
  env.applyExtensionEditorTakeover({});
  assert.equal(env.committed.length, 0, "没有这个字段就什么也不做");
  assert.equal(env.state.current.editorTakeover?.id, "live");
});

test("水合：null = 宿主明确说「没有接管」→ 恢复我们自己的输入框", () => {
  const env = makeHydrationEnv(applyExtensionUiRequest(createEmptyExtensionUiState(), {
    type: "extension_ui_request", id: "live", method: "editorComponent", lines: ["live"],
  }).state);
  env.applyExtensionEditorTakeover({ extensionEditorComponent: null });
  assert.equal(env.state.current.editorTakeover, null);
});

test("水合：新接管（id 不同）装回来，带内容", () => {
  const env = makeHydrationEnv();
  env.applyExtensionEditorTakeover({ extensionEditorComponent: takeOver("t1", ["L1", "L2"]) });
  assert.equal(env.state.current.editorTakeover?.id, "t1");
  assert.deepEqual(env.state.current.editorTakeover?.lines, ["L1", "L2"]);
});

test("水合：同一个 id 不覆盖（快照可能比刚到的 SSE 帧旧，覆盖会让编辑器倒退几帧）", () => {
  const env = makeHydrationEnv(applyExtensionUiRequest(createEmptyExtensionUiState(), {
    type: "extension_ui_request", id: "t1", method: "editorComponent", lines: ["fresh"],
  }).state);
  env.applyExtensionEditorTakeover({ extensionEditorComponent: takeOver("t1", ["stale"]) });
  assert.equal(env.committed.length, 0, "同 id 的快照不该写状态");
  assert.deepEqual(env.state.current.editorTakeover?.lines, ["fresh"]);
});

test("水合：没有 id 的垃圾报文被忽略（不清掉当前接管）", () => {
  const env = makeHydrationEnv(applyExtensionUiRequest(createEmptyExtensionUiState(), {
    type: "extension_ui_request", id: "t1", method: "editorComponent", lines: ["fresh"],
  }).state);
  env.applyExtensionEditorTakeover({ extensionEditorComponent: { lines: ["no id"] } });
  assert.equal(env.state.current.editorTakeover?.id, "t1");
});

function makeSubmitEnv({ running = false, bashRunning = false } = {}) {
  const sends = [];
  const followUps = [];
  const submitEditorComponentText = extractCallback({
    getRuntimeAgentRunning: () => running,
    bashRunningRef: { current: bashRunning },
    // 两个「晚绑」入口：hook 里指向真实的 handleSend / handlePromptWithStreamingBehavior。
    handleSendEntryRef: { current: async (message) => { sends.push(message); return true; } },
    handlePromptWithStreamingBehaviorEntryRef: {
      current: async (message, behavior, images) => { followUps.push({ message, behavior, images }); },
    },
  }, "submitEditorComponentText");
  return { submitEditorComponentText, sends, followUps };
}

test("提交：空闲时走发送入口（不是直连服务端）", () => {
  const env = makeSubmitEnv();
  env.submitEditorComponentText("你好");
  assert.deepEqual(env.sends, ["你好"]);
  assert.deepEqual(env.followUps, [], "空闲时不该排队");
});

test("提交：运行中入 follow-up 队列（与输入框的纯文本提交同一路由）", () => {
  const running = makeSubmitEnv({ running: true });
  running.submitEditorComponentText("趁跑着插一句");
  assert.deepEqual(running.sends, [], "运行中不直接发");
  assert.deepEqual(running.followUps, [{ message: "趁跑着插一句", behavior: "followUp", images: undefined }]);

  const bash = makeSubmitEnv({ bashRunning: true });
  bash.submitEditorComponentText("bash 跑着时");
  assert.deepEqual(bash.followUps.length, 1, "手动 bash 跑着时也算忙碌");
  assert.deepEqual(bash.sends, []);
});

test("提交：空白文本不发（插件可能在失焦/清空时调）", () => {
  const env = makeSubmitEnv();
  env.submitEditorComponentText("");
  env.submitEditorComponentText("   ");
  env.submitEditorComponentText(undefined);
  assert.deepEqual(env.sends, []);
  assert.deepEqual(env.followUps, []);
});

/**
 * 抽真实的 `handleExtensionUiRequest`（事件分发那一层）：接管期间的 insertText 落点。
 *
 * env 里给出的 `editorInputRef` / `opts.chatInputRef` 是两个记录器，
 * 用来观察「文本进了哪一边」——接管时我们自己的输入框根本不存在。
 */
function makeRequestEnv({ takeover }) {
  const editorInputs = [];
  const composerInserts = [];
  const state = {
    current: takeover
      ? applyExtensionUiRequest(createEmptyExtensionUiState(), {
        type: "extension_ui_request", id: takeover.id, method: "editorComponent", lines: takeover.lines,
      }).state
      : createEmptyExtensionUiState(),
  };
  const handleExtensionUiRequest = extractCallback({
    applyExtensionUiRequest,
    extensionUiStateRef: state,
    commitExtensionUiState: (next) => { state.current = next; },
    claimNoticeHandoff: () => false,
    addNotice: () => {},
    addLiveActivity: () => {},
    setExtensionWindowTitle: () => {},
    applyExternallyRequestedTheme: () => {},
    capabilityFeatureOf: () => null,
    hasSeenCapabilityFeature: () => false,
    rememberCapabilityFeature: () => {},
    editorSubmitRef: { current: () => {} },
    editorInputRef: { current: (request, data) => editorInputs.push({ id: request.id, data }) },
    asBracketedPaste,
    opts: { chatInputRef: { current: { insertText: (text) => composerInserts.push(text) } } },
  }, "handleExtensionUiRequest");
  return { handleExtensionUiRequest, editorInputs, composerInserts };
}

test("接管期间插件的 setEditorText / pasteToEditor 文本进插件编辑器（按粘贴），不是无声丢掉", () => {
  const env = makeRequestEnv({ takeover: { id: "t1", lines: ["L"] } });
  env.handleExtensionUiRequest({ type: "extension_ui_request", id: "r1", method: "set_editor_text", text: "你好世界" });
  assert.equal(env.editorInputs.length, 1, "接管时文本必须进插件编辑器（输入框已让位）");
  assert.equal(env.editorInputs[0].id, "t1");
  assert.equal(env.editorInputs[0].data, asBracketedPaste("你好世界"), "按粘贴送（与用户在接管面板里粘贴同一条路）");
  assert.deepEqual(env.composerInserts, [], "接管时不该写我们自己的输入框");
});

test("对照组：没有接管时同一份报文照旧进输入框（确认上一条不是恒真）", () => {
  const env = makeRequestEnv({ takeover: null });
  env.handleExtensionUiRequest({ type: "extension_ui_request", id: "r1", method: "set_editor_text", text: "你好世界" });
  assert.deepEqual(env.composerInserts, ["你好世界"]);
  assert.deepEqual(env.editorInputs, []);
});

test("提交：onSubmit 效果由 handleExtensionUiRequest 分发到这条实现（接线守一句）", () => {
  const source = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(source, /effect\.type === "editorSubmit"[\s\S]{0,200}editorSubmitRef\.current\(effect\.text\)/, "editorSubmit 效果要落到 submitEditorComponentText 的 ref 上");
  assert.match(source, /editorSubmitRef\.current = submitEditorComponentText;/, "ref 要绑定到实现");
});
