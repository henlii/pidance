/**
 * 插件编辑器接管（issue #107）在 hook 里的三半：
 *
 * 1. **水合**：`/state` 的 `extensionEditorComponent` 快照补回接管内容（插件在页面订阅前
 *    就设好了工厂，一次性 SSE 事件在那时直接丢）；缺字段保持现状、同 id 不覆盖更新的行。
 * 2. **提交**：组件调的 `onSubmit(text)` 必须走**既有发送入口**（空闲先过内置斜杠、再走发送；
 *    运行中入 follow-up 队列），**不得**在这个回调里直连服务端 —— 队列 / 写者所有权 /
 *    只读判定都在那条管线里。失败/早退时还要把正文**交回组件**（真编辑器在调 onSubmit
 *    之前已经清空自己，回填只写输入框等于字没了）。
 * 3. **归属**：提交事件是广播的，只有**敲字的那个标签**该执行；文本落点则按「本页是否
 *    显示接管 + 宿主是否已经写进组件」决定。
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

function makeSubmitEnv({ running = false, bashRunning = false, builtinHandled = false, sendResult = true } = {}) {
  const sends = [];
  const followUps = [];
  const restores = [];
  const builtins = [];
  const submitEditorComponentText = extractCallback({
    getRuntimeAgentRunning: () => running,
    bashRunningRef: { current: bashRunning },
    // 三个「晚绑」入口：hook 里分别指向真实的 handleSend / handlePromptWithStreamingBehavior /
    // handleBuiltinSlashCommand。
    handleSendEntryRef: { current: async (message) => { sends.push(message); return sendResult; } },
    handlePromptWithStreamingBehaviorEntryRef: {
      current: async (message, behavior, images) => { followUps.push({ message, behavior, images }); },
    },
    handleBuiltinSlashCommandRef: {
      current: async (text) => { builtins.push(text); return { handled: builtinHandled }; },
    },
    restoreEditorTakeoverText: (text) => { restores.push(text); },
  }, "submitEditorComponentText");
  return { submitEditorComponentText, sends, followUps, restores, builtins };
}

test("提交：空闲时走发送入口（不是直连服务端）", async () => {
  const env = makeSubmitEnv();
  await env.submitEditorComponentText("你好");
  assert.deepEqual(env.sends, ["你好"]);
  assert.deepEqual(env.followUps, [], "空闲时不该排队");
  assert.deepEqual(env.builtins, ["你好"], "空闲提交要先过内置斜杠那一关（/copy、/session…）");
  assert.deepEqual(env.restores, [], "发成功不该回填");
});

test("提交：空闲时内置斜杠优先，handled 之后不再当普通消息发出去", async () => {
  const env = makeSubmitEnv({ builtinHandled: true });
  await env.submitEditorComponentText("/copy");
  assert.deepEqual(env.builtins, ["/copy"]);
  assert.deepEqual(env.sends, [], "内置斜杠已被处置，不该再发给模型（issue #107 审查 重要 3）");
});

test("提交：发送入口回绝（只读 / 被锁 / 分支切换 / 竞态）时把正文交回插件编辑器", async () => {
  const env = makeSubmitEnv({ sendResult: false });
  await env.submitEditorComponentText("发不出去的正文");
  assert.deepEqual(env.sends, ["发不出去的正文"]);
  assert.deepEqual(
    env.restores,
    ["发不出去的正文"],
    "真编辑器在调 onSubmit 前已清空自己，回填只写输入框等于字没了（审查 阻断 1）",
  );
});

test("提交：运行中入 follow-up 队列（与输入框的纯文本提交同一路由）", async () => {
  const running = makeSubmitEnv({ running: true });
  await running.submitEditorComponentText("趁跑着插一句");
  assert.deepEqual(running.sends, [], "运行中不直接发");
  assert.deepEqual(running.followUps, [{ message: "趁跑着插一句", behavior: "followUp", images: undefined }]);
  assert.deepEqual(running.builtins, [], "托管给队列时不判内置斜杠（运行中的斜杠走立即 prompt）");

  const bash = makeSubmitEnv({ bashRunning: true });
  await bash.submitEditorComponentText("bash 跑着时");
  assert.deepEqual(bash.followUps.length, 1, "手动 bash 跑着时也算忙碌");
  assert.deepEqual(bash.sends, []);
});

test("提交：空白文本不发（插件可能在失焦/清空时调）", async () => {
  const env = makeSubmitEnv();
  await env.submitEditorComponentText("");
  await env.submitEditorComponentText("   ");
  await env.submitEditorComponentText(undefined);
  assert.deepEqual(env.sends, []);
  assert.deepEqual(env.followUps, []);
  assert.deepEqual(env.restores, []);
});

/**
 * 抽真实的 `handleExtensionUiRequest`（事件分发那一层）：文本落点与提交归属。
 *
 * `editorTakeoverDisplayedRef` 是「**本页**是否显示接管面板」——它与「状态里有接管」不同：
 * 手机、设置关掉、点过「返回输入框」时状态里仍有接管。getClientId 也注入成固定值，
 * 好构造「这条事件是说给别的标签的」。
 */
function makeRequestEnv({ takeover, displayed = false, myClientId = "tab-mine" } = {}) {
  const editorInputs = [];
  const composerInserts = [];
  const submits = [];
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
    getClientId: () => myClientId,
    editorSubmitRef: { current: (text) => submits.push(text) },
    editorInputRef: { current: (request, data) => editorInputs.push({ id: request.id, data }) },
    asBracketedPaste,
    opts: {
      chatInputRef: { current: { insertText: (text) => composerInserts.push(text) } },
      editorTakeoverDisplayedRef: { current: displayed },
    },
  }, "handleExtensionUiRequest");
  return { handleExtensionUiRequest, editorInputs, composerInserts, submits };
}

test("接管期间插件的 setEditorText：本页显示接管且宿主未写进组件 → 按粘贴送进组件", () => {
  const env = makeRequestEnv({ takeover: { id: "t1", lines: ["L"] }, displayed: true });
  env.handleExtensionUiRequest({
    type: "extension_ui_request", id: "r1", method: "set_editor_text", text: "你好世界", appliedToTakeover: false,
  });
  assert.equal(env.editorInputs.length, 1, "接管时文本必须进插件编辑器（输入框已让位）");
  assert.equal(env.editorInputs[0].id, "t1");
  assert.equal(env.editorInputs[0].data, asBracketedPaste("你好世界"), "按粘贴送（与用户在接管面板里粘贴同一条路）");
  assert.deepEqual(env.composerInserts, [], "接管时不该写我们自己的输入框");
});

test("接管期间插件的 setEditorText：宿主已经写进组件 → 显示接管的页面不再送一遍（否则两份）", () => {
  const env = makeRequestEnv({ takeover: { id: "t1", lines: ["L"] }, displayed: true });
  env.handleExtensionUiRequest({
    type: "extension_ui_request", id: "r1", method: "set_editor_text", text: "已经写进去了", appliedToTakeover: true,
  });
  assert.deepEqual(env.editorInputs, [], "组件已经拿到这份文本，再送一遍会让正文凭空多一份");
  assert.deepEqual(env.composerInserts, [], "显示接管时输入框也不该收到");
});

test("本页没显示接管（手机 / 设置关掉 / 收起过）：文本落进可见输入框，而不是看不见的组件", () => {
  const env = makeRequestEnv({ takeover: { id: "t1", lines: ["L"] }, displayed: false });
  env.handleExtensionUiRequest({
    type: "extension_ui_request", id: "r1", method: "set_editor_text", text: "手机用户要收到的字", appliedToTakeover: true,
  });
  assert.deepEqual(env.editorInputs, [], "本页看不到接管面板，送进组件等于字没了");
  assert.deepEqual(env.composerInserts, ["手机用户要收到的字"], "必须落进它看得见的输入框");
});

test("对照组：没有接管时同一份报文照旧进输入框（确认前面不是恒真）", () => {
  const env = makeRequestEnv({ takeover: null, displayed: false });
  env.handleExtensionUiRequest({ type: "extension_ui_request", id: "r1", method: "set_editor_text", text: "你好世界" });
  assert.deepEqual(env.composerInserts, ["你好世界"]);
  assert.deepEqual(env.editorInputs, []);
});

test("定向给别的标签的文本事件不改本标签的输入框（「返回输入框」交还给发起标签）", () => {
  const env = makeRequestEnv({ takeover: { id: "t1", lines: ["L"] }, displayed: false, myClientId: "tab-mine" });
  env.handleExtensionUiRequest({
    type: "extension_ui_request", id: "r1", method: "set_editor_text", text: "别人的字", appliedToTakeover: false, clientId: "tab-other",
  });
  assert.deepEqual(env.composerInserts, [], "不是说我，别改我的输入框");
  // 说给自己的照旧落进来（确认上一条不是恒真）
  env.handleExtensionUiRequest({
    type: "extension_ui_request", id: "r2", method: "set_editor_text", text: "我的字", appliedToTakeover: false, clientId: "tab-mine",
  });
  assert.deepEqual(env.composerInserts, ["我的字"]);
});

test("提交归属：来源是本标签才执行；来源是别的标签不执行；没有来源时由显示接管的标签兜底", () => {
  const env = makeRequestEnv({ takeover: { id: "t1", lines: ["L"] }, displayed: true, myClientId: "tab-mine" });

  env.handleExtensionUiRequest({ type: "extension_ui_request", id: "s1", method: "editorComponentSubmit", text: "我敲的", clientId: "tab-mine" });
  assert.deepEqual(env.submits, ["我敲的"], "本标签敲的字要执行");

  env.handleExtensionUiRequest({ type: "extension_ui_request", id: "s2", method: "editorComponentSubmit", text: "别的标签敲的", clientId: "tab-other" });
  assert.deepEqual(env.submits, ["我敲的"], "别的标签的提交不该由我再执行一次（否则重复发送）");

  env.handleExtensionUiRequest({ type: "extension_ui_request", id: "s3", method: "editorComponentSubmit", text: "插件自己提交的" });
  assert.deepEqual(env.submits, ["我敲的", "插件自己提交的"], "没有来源时由正在显示接管的标签兜底");

  // 没显示接管的标签不兜底（否则多标签又会重复）
  const idle = makeRequestEnv({ takeover: { id: "t1", lines: ["L"] }, displayed: false });
  idle.handleExtensionUiRequest({ type: "extension_ui_request", id: "s4", method: "editorComponentSubmit", text: "没来源" });
  assert.deepEqual(idle.submits, [], "没显示接管的标签不该抢着提交");
});

test("接线：onSubmit 的提交事件确实分发到这条实现（防删护栏）", () => {
  const source = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(
    source,
    /effect\.type === "editorSubmit"[\s\S]{0,700}if \(forThisTab\) editorSubmitRef\.current\(effect\.text\);/,
    "editorSubmit 效果要按归属地落到 submitEditorComponentText 的 ref 上",
  );
  assert.match(source, /editorSubmitRef\.current = submitEditorComponentText;/, "ref 要绑定到实现");
});
