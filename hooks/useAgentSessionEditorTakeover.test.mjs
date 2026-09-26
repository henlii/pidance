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

function makeSubmitEnv({ running = false, bashRunning = false, isCompacting = false, builtinHandled = false, builtinError = undefined, sendResult = true } = {}) {
  const sends = [];
  const followUps = [];
  const restores = [];
  const builtins = [];
  const submitEditorComponentText = extractCallback({
    getRuntimeAgentRunning: () => running,
    bashRunningRef: { current: bashRunning },
    // 忙碌口径要与 ChatWindow 的 sessionBusy 一致（含压缩）：hook 里读的是这个 ref。
    isCompactingRef: { current: isCompacting },
    // 三个「晚绑」入口：hook 里分别指向真实的 handleSend / handlePromptWithStreamingBehavior /
    // handleBuiltinSlashCommand。
    handleSendEntryRef: { current: async (message) => { sends.push(message); return sendResult; } },
    handlePromptWithStreamingBehaviorEntryRef: {
      current: async (message, behavior, images) => { followUps.push({ message, behavior, images }); },
    },
    handleBuiltinSlashCommandRef: {
      current: async (text) => { builtins.push(text); return builtinHandled ? { handled: true, error: builtinError } : { handled: false }; },
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

// 三轮审查 阻断 1 的前半：ChatInput 在 `result.error` 分支会 restoreSentDraft；接管时
// 输入框不在场，命令原文只能交回组件 —— 否则 /copy 无可复制内容、/name 缺参、
// /compact 抛错 这些一失败字就没了。
test("提交：内置斜杠失败（handled && error）也要把命令原文交回插件编辑器", async () => {
  const env = makeSubmitEnv({ builtinHandled: true, builtinError: "No active session to compact" });
  await env.submitEditorComponentText("/compact");
  assert.deepEqual(env.builtins, ["/compact"]);
  assert.deepEqual(env.sends, [], "失败的内置斜杠不该再当普通消息发出去");
  assert.deepEqual(env.restores, ["/compact"], "命令失败了，原文必须还给用户（对照 ChatInput 的 result.error 分支）");
});

test("提交：压缩中也算忙碌（与 ChatWindow 的 sessionBusy 同口径，三轮审查 重要 6）", async () => {
  const env = makeSubmitEnv({ isCompacting: true });
  await env.submitEditorComponentText("/copy");
  assert.deepEqual(env.followUps, [{ message: "/copy", behavior: "followUp", images: undefined }], "压缩中要走运行中那条路（输入框就是这么做的）");
  assert.deepEqual(env.builtins, [], "压缩中不该在本地跑内置斜杠");
  assert.deepEqual(env.sends, []);
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
  // 落点分两种记：replaceText 是「编辑器内容变成这段文本」（TUI 的 setText），
  // insertText 是在光标处插入。三轮审查 阻断 2 要求交还走**替换**，所以断言要能区分。
  const composerWrites = [];
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
      chatInputRef: {
        current: {
          insertText: (text) => composerWrites.push({ kind: "insert", text }),
          replaceText: (text) => composerWrites.push({ kind: "replace", text }),
        },
      },
      editorTakeoverDisplayedRef: { current: displayed },
    },
  }, "handleExtensionUiRequest");
  return { handleExtensionUiRequest, editorInputs, composerWrites, submits };
}

test("接管期间插件的 setEditorText：本页显示接管且宿主未写进组件 → 按粘贴送进组件", () => {
  const env = makeRequestEnv({ takeover: { id: "t1", lines: ["L"] }, displayed: true });
  env.handleExtensionUiRequest({
    type: "extension_ui_request", id: "r1", method: "set_editor_text", text: "你好世界", appliedToTakeover: false,
  });
  assert.equal(env.editorInputs.length, 1, "接管时文本必须进插件编辑器（输入框已让位）");
  assert.equal(env.editorInputs[0].id, "t1");
  assert.equal(env.editorInputs[0].data, asBracketedPaste("你好世界"), "按粘贴送（与用户在接管面板里粘贴同一条路）");
  assert.deepEqual(env.composerWrites, [], "接管时不该写我们自己的输入框");
});

test("接管期间插件的 setEditorText：宿主已经写进组件 → 显示接管的页面不再送一遍（否则两份）", () => {
  const env = makeRequestEnv({ takeover: { id: "t1", lines: ["L"] }, displayed: true });
  env.handleExtensionUiRequest({
    type: "extension_ui_request", id: "r1", method: "set_editor_text", text: "已经写进去了", appliedToTakeover: true,
  });
  assert.deepEqual(env.editorInputs, [], "组件已经拿到这份文本，再送一遍会让正文凭空多一份");
  assert.deepEqual(env.composerWrites, [], "显示接管时输入框也不该收到");
});

test("本页没显示接管（手机 / 设置关掉 / 收起过）：文本落进可见输入框，而不是看不见的组件", () => {
  const env = makeRequestEnv({ takeover: { id: "t1", lines: ["L"] }, displayed: false });
  env.handleExtensionUiRequest({
    type: "extension_ui_request", id: "r1", method: "set_editor_text", text: "手机用户要收到的字", appliedToTakeover: true,
  });
  assert.deepEqual(env.editorInputs, [], "本页看不到接管面板，送进组件等于字没了");
  assert.deepEqual(
    env.composerWrites,
    [{ kind: "replace", text: "手机用户要收到的字" }],
    "必须落进它看得见的输入框，而且是**替换**（组合文本 + insertText 会拼成两份，三轮审查 阻断 2）",
  );
});

test("对照组：没有接管时同一份报文照旧进输入框（确认前面不是恒真）", () => {
  const env = makeRequestEnv({ takeover: null, displayed: false });
  env.handleExtensionUiRequest({ type: "extension_ui_request", id: "r1", method: "set_editor_text", text: "你好世界" });
  assert.deepEqual(env.composerWrites, [{ kind: "replace", text: "你好世界" }]);
  assert.deepEqual(env.editorInputs, []);
});

test("定向给别的标签的文本事件不改本标签的输入框（「返回输入框」交还给发起标签）", () => {
  const env = makeRequestEnv({ takeover: { id: "t1", lines: ["L"] }, displayed: false, myClientId: "tab-mine" });
  env.handleExtensionUiRequest({
    type: "extension_ui_request", id: "r1", method: "set_editor_text", text: "别人的字", appliedToTakeover: false, clientId: "tab-other",
  });
  assert.deepEqual(env.composerWrites, [], "不是说我，别改我的输入框");
  // 说给自己的照旧落进来（确认上一条不是恒真）
  env.handleExtensionUiRequest({
    type: "extension_ui_request", id: "r2", method: "set_editor_text", text: "我的字", appliedToTakeover: false, clientId: "tab-mine",
  });
  assert.deepEqual(env.composerWrites, [{ kind: "replace", text: "我的字" }]);
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

// ---------------------------------------------------------------------------
// 三轮审查新增：回填的兜底、上报接线、运行中拒绝时的落点
// ---------------------------------------------------------------------------

/** 抽 `restoreEditorTakeoverText`：回填命令失败 / applied:false 时也必须写草稿。 */
function makeRestoreEnv({ takeoverId = "t1", sendResult = { applied: true }, failCommand = false } = {}) {
  const commands = [];
  const drafts = [];
  const restoreEditorTakeoverText = extractCallback({
    capabilities: { canSendSessionCommands: true },
    sessionIdRef: { current: "sess-1" },
    extensionUiStateRef: { current: { editorTakeover: takeoverId ? { id: takeoverId } : null } },
    getDraft: () => ({ value: "原有草稿", images: [] }),
    setDraft: (sid, draft) => { drafts.push({ sid, draft }); },
    sendAgentCommand: async (sid, command) => {
      commands.push({ sid, command });
      if (failCommand) throw new Error("network");
      return sendResult;
    },
  }, "restoreEditorTakeoverText");
  return { restoreEditorTakeoverText, commands, drafts };
}

test("回填：命令确认 applied=true → 只写组件，不再重复写草稿", async () => {
  const env = makeRestoreEnv({ sendResult: { applied: true } });
  env.restoreEditorTakeoverText("失败的正文");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(env.commands, [{ sid: "sess-1", command: { type: "editor_component_set_text", requestId: "t1", text: "失败的正文" } }]);
  assert.deepEqual(env.drafts, [], "组件已经拿到了，不该再往草稿塞一份（两处都有会分叉）");
});

test("回填：命令回 applied:false（接管换过 / 组件没有 setText）→ 同时写草稿", async () => {
  const env = makeRestoreEnv({ sendResult: { applied: false } });
  env.restoreEditorTakeoverText("失败的正文");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(env.drafts.length, 1, "旧实现把回填命令当作已送达，字就没了（三轮审查 重要 4）");
  assert.equal(env.drafts[0].sid, "sess-1");
  assert.equal(env.drafts[0].draft.value, "失败的正文\n\n原有草稿", "前插到已有草稿之前（与 restorePayloadToSession 同口径）");
});

test("回填：命令抛错（HTTP 失败）也要写草稿；没有接管时直接写草稿", async () => {
  const failed = makeRestoreEnv({ failCommand: true });
  failed.restoreEditorTakeoverText("网络挂了");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(failed.drafts.map((d) => d.draft.value), ["网络挂了\n\n原有草稿"], "命令失败不能吞掉正文");

  const noTakeover = makeRestoreEnv({ takeoverId: null });
  noTakeover.restoreEditorTakeoverText("没有接管了");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(noTakeover.commands, [], "没有接管就不发命令");
  assert.deepEqual(noTakeover.drafts.map((d) => d.draft.value), ["没有接管了\n\n原有草稿"]);
});

test("上报：reportEditorTakeoverView 带 clientId 与 shown（宿主据此挑提交归属与文本落点）", () => {
  const commands = [];
  const reportEditorTakeoverView = extractCallback({
    capabilities: { canSendSessionCommands: true },
    sessionIdRef: { current: "sess-1" },
    getClientId: () => "tab-mine",
    sendAgentCommand: async (sid, command) => { commands.push({ sid, command }); },
  }, "reportEditorTakeoverView");
  reportEditorTakeoverView("t1", true);
  reportEditorTakeoverView("t1", false);
  assert.deepEqual(commands, [
    { sid: "sess-1", command: { type: "editor_takeover_view", requestId: "t1", shown: true, clientId: "tab-mine" } },
    { sid: "sess-1", command: { type: "editor_takeover_view", requestId: "t1", shown: false, clientId: "tab-mine" } },
  ]);
  // 缺 id / 缺会话时不发无意义请求
  reportEditorTakeoverView("", true);
  assert.equal(commands.length, 2);
});

/**
 * 抽 `handlePromptWithStreamingBehavior`：运行中提交以 `/` 开头、被拒时的落点。
 *
 * 三轮审查 阻断 1 的后半：那条路径的 `restore` 只调 `chatInputRef.restoreDraft`，
 * 而接管时输入框 ref 是 null（`ChatInput` 整块没渲染）→ 可选调用空操作，正文直接消失。
 */
function makeStreamingEnv({ hasInput = true, receipt = { status: "rejected", reason: "locked" } } = {}) {
  const restores = [];
  const payloadRestores = [];
  const notices = [];
  const handlePromptWithStreamingBehavior = extractCallback({
    isReadOnly: false,
    sessionIdRef: { current: "sess-1" },
    promptImageInputs: () => undefined,
    sendAgentCommand: async () => receipt,
    acceptQueuedReceipt: () => {},
    ensureEventsConnected: () => {},
    isExtensionCommandQueueError: () => false,
    queueRejectionMessage: (reason) => String(reason),
    addNotice: (notice) => { notices.push(notice); },
    t: (key) => key,
    restorePayloadToSession: (sid, payload) => { payloadRestores.push({ sid, payload }); },
    handleFollowUpRef: { current: async () => {} },
    opts: {
      chatInputRef: {
        current: hasInput ? { restoreDraft: (...args) => restores.push(args) } : null,
      },
    },
  }, "handlePromptWithStreamingBehavior");
  return { handlePromptWithStreamingBehavior, restores, payloadRestores, notices };
}

test("运行中的斜杠被拒：没有输入框（接管中）时走 restorePayloadToSession，正文不消失", async () => {
  const env = makeStreamingEnv({ hasInput: false });
  await env.handlePromptWithStreamingBehavior("/copy", "followUp");
  assert.deepEqual(env.restores, [], "接管时输入框 ref 是 null，写它等于空操作");
  assert.deepEqual(
    env.payloadRestores,
    [{ sid: "sess-1", payload: { text: "/copy", images: undefined } }],
    "必须走会写草稿 + 交回组件的那条路（三轮审查 阻断 1）",
  );
  assert.equal(env.notices.length, 1, "用户仍要看到失败提示");
});

test("对照组：有输入框时照旧 restoreDraft（确认上一条不是恒真）", async () => {
  const env = makeStreamingEnv({ hasInput: true });
  await env.handlePromptWithStreamingBehavior("/copy", "followUp");
  assert.equal(env.restores.length, 1, "有输入框就走原来的恢复路径");
  assert.equal(env.restores[0][2], "sess-1", "归属仍是原会话");
  assert.deepEqual(env.payloadRestores, [], "两条路互斥，不该同时走");
});

test("归还原会话（接管中）：正文只前插一次 —— 回填不再自己写第二遍草稿", async () => {
  // 三轮修复里最容易写错的一处：`restorePayloadToSession` 在没有输入框时会
  // ①调 restoreEditorTakeoverText（那条现在也会写草稿）②自己再写一遍草稿（带图片）。
  // 两边都写就会把同一段正文前插两次。这里走**真实的两个回调**，断言只写一次。
  const drafts = [];
  const env = {
    sessionIdRef: { current: "sess-1" },
    getDraft: () => ({ value: "原有草稿", images: [] }),
    setDraft: (sid, draft) => { drafts.push({ sid, draft }); },
    capabilities: { canSendSessionCommands: true },
    extensionUiStateRef: { current: { editorTakeover: { id: "t1" } } },
    // 宿主说「没落进组件」（接管换过 / 组件没有 setText）→ 回填的兜底会想写草稿。
    sendAgentCommand: async () => ({ applied: false }),
    attachmentsFromQueueMedia: () => [],
    opts: { chatInputRef: { current: null } },
  };
  env.restoreEditorTakeoverText = extractCallback(env, "restoreEditorTakeoverText");
  const restorePayloadToSession = extractCallback(env, "restorePayloadToSession");

  restorePayloadToSession("sess-1", { text: "导回来的正文" });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(drafts.length, 1, "同一段正文不该被前插两次（两边都写就是 '正文\\n\\n正文\\n\\n原有草稿'）");
  assert.equal(drafts[0].sid, "sess-1");
  assert.equal(drafts[0].draft.value, "导回来的正文\n\n原有草稿");
});
