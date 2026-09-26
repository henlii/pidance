import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";
import ts from "typescript";

/**
 * 取出 hook 源码里某个 useCallback 的函数体文本（#110：断言委托，
 * 而不是数「有几条路径各抄了一遍」）。
 */
function callbackBodyOf(name) {
  const text = readFileSync(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("hook.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body = "";
  function visit(node) {
    if (ts.isVariableDeclaration(node)
      && node.name.getText(tree) === name
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && node.initializer.arguments.length > 0) {
      body = node.initializer.arguments[0].getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(body.length > 0, "Missing " + name + " in useAgentSession.ts");
  return body;
}


const jiti = createJiti(import.meta.url);
const {
  applyExtensionUiRequest,
  clearAllExtensionUiBlocking,
  resetExtensionUiForSession,
  clearExtensionUiRequest,
  createEmptyExtensionUiState,
  projectBlockingHead,
  pickBlockingExtensionRequests,
  pickCapabilityNotices,
  restoreCustomUi,
  parseExtensionUiSettledId,
  rememberSettledRequestId,
  filterSettledBlockingRequests,
  MAX_SETTLED_REQUEST_IDS,
  sameEditorComponent,
} = await jiti.import("./extension-ui-bridge.ts");

const base = createEmptyExtensionUiState();
const request = (method, fields = {}) => ({ type: "extension_ui_request", id: method, method, ...fields });

test("confirm/input/select 全部进入 dialog（对齐 TUI 弹窗承载）", () => {
  for (const method of ["confirm", "input"]) {
    const current = request(method, { title: "请求", id: method });
    const result = applyExtensionUiRequest(base, current);
    assert.equal(result.state.dialog, current);
    assert.equal(result.state.blockingQueue.length, 1);
    assert.deepEqual(result.effects, []);
  }
  const current = request("select", { title: "请求", options: ["一", "二"], id: "short-select" });
  const result = applyExtensionUiRequest(base, current);
  assert.equal(result.state.dialog, current);
});

test("长 select 同样走 dialog（不再按长短分流）", () => {
  const long = request("select", { options: ["x".repeat(81)], id: "long-select" });
  const result = applyExtensionUiRequest(base, long);
  assert.equal(result.state.dialog, long);
});

test("editor 进入 dialog 投影", () => {
  const current = request("editor", { title: "编辑", id: "editor-1" });
  const result = applyExtensionUiRequest(base, current);
  assert.equal(result.state.dialog, current);
  assert.equal(result.state.blockingQueue[0], current);
});

test("notify 只产生 notice effect，并保持状态引用", () => {
  const result = applyExtensionUiRequest(base, request("notify", { message: "提示", notifyType: "warning" }));
  assert.equal(result.state, base);
  assert.deepEqual(result.effects, [{ type: "notice", id: "notify", message: "提示", noticeType: "warning", activityRecord: false }]);
  assert.deepEqual(
    applyExtensionUiRequest(base, request("notify", { message: "默认提示" })).effects,
    [{ type: "notice", id: "notify", message: "默认提示", noticeType: "info", activityRecord: false }],
  );
});

test("status 支持替换、删除以及无变化时保持引用", () => {
  const state = { ...base, statuses: [{ key: "a", text: "旧" }, { key: "b", text: "保留" }] };
  const updated = applyExtensionUiRequest(state, request("setStatus", { statusKey: "a", statusText: "新" }));
  assert.deepEqual(updated.state.statuses, [{ key: "b", text: "保留" }, { key: "a", text: "新" }]);
  assert.equal(applyExtensionUiRequest(state, request("setStatus", { statusKey: "missing" })).state, state);
  assert.deepEqual(
    applyExtensionUiRequest(updated.state, request("setStatus", { statusKey: "a" })).state.statuses,
    [{ key: "b", text: "保留" }],
  );
});

test("widget 支持默认位置、替换和删除", () => {
  const state = { ...base, widgets: [{ key: "x", lines: ["保留"], placement: "aboveEditor" }] };
  const added = applyExtensionUiRequest(state, request("setWidget", { widgetKey: "w", widgetLines: ["一"] }));
  assert.deepEqual(added.state.widgets, [
    // interactive 显式落成 false：状态里不带这个字段时前端分不清「不可交互」与「老版本没上报」
    { key: "x", lines: ["保留"], placement: "aboveEditor" },
    { key: "w", lines: ["一"], placement: "aboveEditor", interactive: false },
  ]);
  const changed = applyExtensionUiRequest(added.state, request("setWidget", { widgetKey: "w", widgetLines: ["二"], widgetPlacement: "belowEditor" }));
  assert.deepEqual(changed.state.widgets[1], { key: "w", lines: ["二"], placement: "belowEditor", interactive: false });
  assert.deepEqual(applyExtensionUiRequest(changed.state, request("setWidget", { widgetKey: "w" })).state.widgets, [
    { key: "x", lines: ["保留"], placement: "aboveEditor" },
  ]);
});

test("widget 的 interactive 随事件进状态，行内容不变也要更新（issue #103）", () => {
  // 同一个数组实例是**故意**的：线上每帧的事件都带一个新数组，去重里的
  // `current.lines === item.lines` 因此从不命中；这里要单独考察 interactive 的比较，
  // 所以把行数组固定住 —— 否则这条测试在删掉 interactive 比较后仍然是绿的（假测试）。
  const lines = ["同"];
  const off = applyExtensionUiRequest(base, request("setWidget", { widgetKey: "w", widgetLines: lines }));
  assert.equal(off.state.widgets[0].interactive, false);

  // 同一份行内容（同一数组实例）、只是组件补上了 handleMouse：必须换新状态对象，
  // 否则前端一直读到旧的 false，点击永远不会路由过来
  const on = applyExtensionUiRequest(off.state, request("setWidget", { widgetKey: "w", widgetLines: lines, widgetInteractive: true }));
  assert.equal(on.state.widgets[0].interactive, true);
  assert.notEqual(on.state, off.state, "交互性变化必须产生新状态");

  // 反过来（组件不再交互）同样要更新
  const back = applyExtensionUiRequest(on.state, request("setWidget", { widgetKey: "w", widgetLines: lines, widgetInteractive: false }));
  assert.equal(back.state.widgets[0].interactive, false);

  // 删除仍然只按 key 判断，不受 interactive 影响
  const removed = applyExtensionUiRequest(back.state, request("setWidget", { widgetKey: "w" }));
  assert.deepEqual(removed.state.widgets, []);
  // 注：既有去重比的是 lines 的**数组身份**（每次事件都是新数组，所以基本不触发），
  // 这里不断言「相同帧不重写状态」—— 那是另一件事，不属于本次改动范围。
});

test("title 和编辑器文本会产生 effect，空 title 不产生 effect", () => {
  assert.deepEqual(applyExtensionUiRequest(base, request("setTitle", { title: "标题" })).effects, [{ type: "setTitle", title: "标题" }]);
  assert.deepEqual(applyExtensionUiRequest(base, request("setTitle", { title: "" })).effects, []);
  assert.deepEqual(applyExtensionUiRequest(base, request("set_editor_text", { text: "内容" })).effects, [
    { type: "setEditorText", text: "内容", appliedToTakeover: false },
  ]);
  // 宿主已经写进组件（appliedToTakeover=true）与「只发给某个标签」（clientId）：
  // 两个字段都要原样带给客户端 —— 它靠前者决定显不显示接管的标签该不该再送一遍，
  // 靠后者决定这条文本是不是说给自己的（issue #107 审查 重要 4 / 重要 5）。
  assert.deepEqual(
    applyExtensionUiRequest(base, request("set_editor_text", { text: "内容", appliedToTakeover: true, clientId: "tab-A" })).effects,
    [{ type: "setEditorText", text: "内容", appliedToTakeover: true, clientId: "tab-A" }],
  );
});

test("/btw custom 缺 lines 时不得抛错，并落成空行数组", () => {
  const opened = applyExtensionUiRequest(base, request("custom"));
  assert.deepEqual(opened.state.customUi.lines, []);
  const unknown = applyExtensionUiRequest(base, { type: "extension_ui_request", id: "x", method: "custom_render" });
  assert.equal(unknown.state, base);
  assert.deepEqual(unknown.effects, []);
});

// issue #99：overlay 句柄的 unfocus 要把焦点交回输入框。副作用只在**状态变化**时下发：
// 插件每重渲一帧就发一次 custom，每帧都发效果会把用户刚点走的焦点抢回来。
test("custom 帧的焦点态：只在变成 editor 时发一次 focusEditor 副作用", () => {
  const custom = (fields) => request("custom", { lines: ["panel"], ...fields });

  const opened = applyExtensionUiRequest(base, custom({ focus: "panel" }));
  assert.deepEqual(opened.effects, [], "默认聚焦面板不需要副作用（面板自己 focus）");
  assert.equal(opened.state.customUi?.focus, "panel");

  const released = applyExtensionUiRequest(opened.state, custom({ focus: "editor" }));
  assert.deepEqual(released.effects, [{ type: "focusEditor" }], "交回编辑器要发副作用");

  const stillReleased = applyExtensionUiRequest(released.state, custom({ focus: "editor" }));
  assert.deepEqual(stillReleased.effects, [], "状态没变就不重复发（否则每帧都抢焦点）");

  const refocused = applyExtensionUiRequest(stillReleased.state, custom({ focus: "panel" }));
  assert.deepEqual(refocused.effects, [], "回面板也不需要副作用");

  const releasedAgain = applyExtensionUiRequest(refocused.state, custom({ focus: "editor" }));
  assert.deepEqual(releasedAgain.effects, [{ type: "focusEditor" }], "再次交回要再发一次");

  // 无 focus 字段 = 旧的「默认面板持有」语义，不得凭空发副作用
  const legacy = applyExtensionUiRequest(base, request("custom", { lines: ["panel"] }));
  assert.deepEqual(legacy.effects, []);
  const legacyEditor = applyExtensionUiRequest(
    { ...base, customUi: { ...legacy.state.customUi, focus: undefined } },
    request("custom", { lines: ["panel"], focus: "none" }),
  );
  assert.deepEqual(legacyEditor.effects, [], "none 也不发（面板自己 blur 即可）");
  assert.equal(legacyEditor.state.customUi?.focus, "none");
});

test("custom 关闭时只清除匹配的当前请求", () => {
  const opened = applyExtensionUiRequest(base, request("custom", { lines: ["内容"] }));
  assert.equal(opened.state.customUi.lines[0], "内容");
  assert.equal(applyExtensionUiRequest(opened.state, request("custom", { id: "other", closed: true })).state, opened.state);
  assert.equal(applyExtensionUiRequest(opened.state, request("custom", { closed: true })).state.customUi, null);
});

// ── FIFO 阻塞队列 ──────────────────────────────────────────────────────────

test("FIFO：confirm → input 只投影队首，后续不覆盖", () => {
  const a = request("confirm", { title: "A", id: "a" });
  const b = request("input", { title: "B", id: "b" });
  let state = applyExtensionUiRequest(base, a).state;
  state = applyExtensionUiRequest(state, b).state;
  assert.equal(state.dialog?.id, "a");
  assert.deepEqual(state.blockingQueue.map((item) => item.id), ["a", "b"]);
});

test("FIFO：confirm → editor 后续入队，队首仍为 confirm", () => {
  const inline = request("confirm", { title: "确认", id: "inline" });
  const dialog = request("editor", { title: "编辑", id: "dialog" });
  let state = applyExtensionUiRequest(base, inline).state;
  state = applyExtensionUiRequest(state, dialog).state;
  assert.equal(state.dialog?.id, "inline");
  assert.deepEqual(state.blockingQueue.map((item) => item.id), ["inline", "dialog"]);
});

test("FIFO：editor → input 后续入队，队首仍为 editor", () => {
  const first = request("editor", { title: "编辑", id: "first" });
  const second = request("input", { title: "输入", id: "second" });
  let state = applyExtensionUiRequest(base, first).state;
  state = applyExtensionUiRequest(state, second).state;
  assert.equal(state.dialog?.id, "first");
  assert.deepEqual(state.blockingQueue.map((item) => item.id), ["first", "second"]);
});

test("清队首推进：移除后自动投影下一项（confirm→editor）", () => {
  const a = request("confirm", { title: "A", id: "a" });
  const b = request("editor", { title: "B", id: "b" });
  let state = applyExtensionUiRequest(base, a).state;
  state = applyExtensionUiRequest(state, b).state;
  state = clearExtensionUiRequest(state, "a");
  assert.equal(state.dialog?.id, "b");
  assert.deepEqual(state.blockingQueue.map((item) => item.id), ["b"]);
});

test("清非队首：不影响队首投影，但从队列移除", () => {
  const a = request("confirm", { title: "A", id: "a" });
  const b = request("input", { title: "B", id: "b" });
  const c = request("editor", { title: "C", id: "c" });
  let state = applyExtensionUiRequest(base, a).state;
  state = applyExtensionUiRequest(state, b).state;
  state = applyExtensionUiRequest(state, c).state;
  state = clearExtensionUiRequest(state, "b");
  assert.equal(state.dialog?.id, "a");
  assert.deepEqual(state.blockingQueue.map((item) => item.id), ["a", "c"]);
  // 再清队首后应跳过已删的 b，投影 c
  state = clearExtensionUiRequest(state, "a");
  assert.equal(state.dialog?.id, "c");
});

test("重复 id 不重复入队", () => {
  const a = request("confirm", { title: "A", id: "same" });
  const again = request("confirm", { title: "A2", id: "same" });
  let state = applyExtensionUiRequest(base, a).state;
  const after = applyExtensionUiRequest(state, again);
  assert.equal(after.state, state);
  assert.equal(after.state.blockingQueue.length, 1);
  assert.equal(after.state.dialog?.title, "A");
});

test("非 blocking effect 不扰乱队列", () => {
  const a = request("confirm", { title: "A", id: "a" });
  const b = request("editor", { title: "B", id: "b" });
  let state = applyExtensionUiRequest(base, a).state;
  state = applyExtensionUiRequest(state, b).state;
  const queueBefore = state.blockingQueue;
  const afterNotify = applyExtensionUiRequest(state, request("notify", { message: "提示", id: "n1" }));
  assert.equal(afterNotify.state.blockingQueue, queueBefore);
  assert.equal(afterNotify.state.dialog?.id, "a");
  const afterStatus = applyExtensionUiRequest(state, request("setStatus", { statusKey: "k", statusText: "t" }));
  assert.deepEqual(afterStatus.state.blockingQueue.map((item) => item.id), ["a", "b"]);
  assert.equal(afterStatus.state.dialog?.id, "a");
  const afterCustom = applyExtensionUiRequest(state, request("custom", { lines: ["x"], id: "custom-1" }));
  assert.deepEqual(afterCustom.state.blockingQueue.map((item) => item.id), ["a", "b"]);
  assert.equal(afterCustom.state.customUi?.id, "custom-1");
  assert.equal(afterCustom.state.dialog?.id, "a");
});

test("切会话：内容类投影全清（面板 / 状态 / widget / 运行提示 / 监听器计数）", () => {
  let state = createEmptyExtensionUiState();
  state = applyExtensionUiRequest(state, request("custom", { id: "c1", lines: ["面板"] })).state;
  state = applyExtensionUiRequest(state, request("setStatus", { id: "s1", statusKey: "k", statusText: "状态" })).state;
  state = applyExtensionUiRequest(state, request("setWidget", { id: "w1", widgetKey: "w", widgetLines: ["行"] })).state;
  state = applyExtensionUiRequest(state, request("setWorkingMessage", { id: "m1", message: "排队中" })).state;
  state = applyExtensionUiRequest(state, request("setWorkingIndicator", { id: "i1", frames: ["●"], intervalMs: 50 })).state;
  state = applyExtensionUiRequest(state, request("terminalInputListeners", { id: "t1", count: 2 })).state;
  state = applyExtensionUiRequest(state, request("editorComponent", { id: "e1", lines: ["插件编辑器"] })).state;
  state = applyExtensionUiRequest(state, request("confirm", { id: "d1", title: "T" })).state;

  const next = resetExtensionUiForSession(state);
  assert.equal(next.customUi, null, "面板不得跟到新会话");
  assert.deepEqual(next.statuses, []);
  assert.deepEqual(next.widgets, []);
  assert.equal(next.workingMessage, null, "运行提示同理（那是上一个会话的文案）");
  assert.equal(next.workingIndicator, null);
  assert.equal(next.workingVisible, true, "恢复默认可见");
  assert.equal(next.terminalInputListenerCount, 0, "计数不归零的话新会话仍会去问插件");
  assert.equal(next.dialog, null);
  assert.equal(next.editorTakeover, null, "接管不得跟到新会话（那是上一个会话的宿主装的）");
  assert.deepEqual(next.blockingQueue, []);
});

test("切会话的清理由会话切换 effect 调用（源码契约）", () => {
  const src = readFileSync(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /commitExtensionUiState\(resetExtensionUiForSession\(/,
    "切会话必须走 resetExtensionUiForSession，而不是只清 blocking",
  );
});

// 按键窄口子的门槛值要从状态快照水合：插件注册监听器之后再打开/刷新页面时，
// 瞬时事件已经过去了，只有快照能给出真值（否则门槛恒为 0，按键永不路由）。
test("状态快照里的监听器数量会被采纳（源码契约）", () => {
  const src = readFileSync(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /const applyExtensionListenerCount = useCallback\(\(state\?: AgentStateResponse \| null\) => \{\s*if \(state\?\.extensionTerminalInputListenerCount === undefined\) return;/,
    "缺字段必须保持现状（旧 Host 不清零）",
  );
  assert.match(
    src,
    /patchExtensionUiState\(\{ terminalInputListenerCount: state\.extensionTerminalInputListenerCount \}\)/,
    "必须把快照里的数量写进扩展 UI 投影",
  );
  // 两条水合路径**共用同一份投影**（issue #110）：以前是每条路径逐字段抄一遍，
  // run 结束/reconcile 那条抄漏了 applyExtensionShortcuts，于是插件快捷键要等刷新。
  // 所以这里断言的是「委托」而不是「数调用点」——并禁止单条路径再抄一遍。
  assert.match(src, /applyExtensionListenerCount\(state\);/, "统一投影里必须采纳监听器数量");
  const snapshotBody = callbackBodyOf("applyAgentStateSnapshot");
  assert.match(
    snapshotBody,
    /applyExtensionUiProjection\(state\);/,
    "run 结束/reconcile 路径必须委托给统一投影（否则又要靠手抄，漏一个字段就是 #110）",
  );
  assert.doesNotMatch(
    snapshotBody,
    /applyExtensionListenerCount\(state\)/,
    "不要在单条路径里再逐字段抄一遍扩展 UI 投影",
  );
});

// 插件自定义的折叠思考标签（issue #96）：与 status/widget 同一套「SSE 事件 + 快照水合」双路。
test("setHiddenThinkingLabel：写进扩展 UI 投影，同值不重写", () => {
  const first = applyExtensionUiRequest(
    base,
    request("setHiddenThinkingLabel", { id: "h1", label: "检索中" }),
  );
  assert.equal(first.state.hiddenThinkingLabel, "检索中");
  assert.equal(createEmptyExtensionUiState().hiddenThinkingLabel, null, "默认是「没有标签」");

  const again = applyExtensionUiRequest(
    first.state,
    request("setHiddenThinkingLabel", { id: "h2", label: "检索中" }),
  );
  assert.equal(again.state, first.state, "同值不重写状态（避免无谓重渲染）");

  const cleared = applyExtensionUiRequest(
    first.state,
    request("setHiddenThinkingLabel", { id: "h3", label: null }),
  );
  assert.equal(cleared.state.hiddenThinkingLabel, null, "null = 恢复我们的默认文案");
});

test("setHiddenThinkingLabel：切会话清掉，由新会话自己的水合填回", () => {
  const withLabel = applyExtensionUiRequest(
    base,
    request("setHiddenThinkingLabel", { id: "h1", label: "检索中" }),
  ).state;
  assert.equal(
    resetExtensionUiForSession(withLabel).hiddenThinkingLabel,
    null,
    "不清会把上一个会话的标签带进新会话",
  );
});

test("折叠思考标签要能从状态快照水合（源码契约）", () => {
  const src = readFileSync(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /if \(state\?\.hiddenThinkingLabel === undefined\) return;/,
    "缺字段保持现状（旧 Host 不清空已到的标签）",
  );
  assert.match(
    src,
    /patchExtensionUiState\(\{ hiddenThinkingLabel: state\.hiddenThinkingLabel \}\)/,
    "必须把快照里的标签写进扩展 UI 投影",
  );
  // 同 #110：水合路径共用统一投影，断言委托 + 投影里确实采纳了这个字段。
  assert.match(src, /applyExtensionHiddenThinkingLabel\(state\);/, "统一投影里必须采纳折叠思考标签");
  assert.match(
    callbackBodyOf("applyAgentStateSnapshot"),
    /applyExtensionUiProjection\(state\);/,
    "run 结束/reconcile 路径必须委托给统一投影",
  );

  // 宿主投影必须有这个字段，否则水合永远拿不到值（插件加载时页面多半还没订阅）。
  const host = readFileSync(new URL("../lib/sdk-session-host.ts", import.meta.url), "utf8");
  assert.match(host, /hiddenThinkingLabel: this\.extensionUi\?\.hiddenThinkingLabel \?\? null/);
});

test("全量 reset 后阻塞队列与投影为空", () => {
  let state = applyExtensionUiRequest(base, request("confirm", { id: "a" })).state;
  state = applyExtensionUiRequest(state, request("editor", { id: "b" })).state;
  state = applyExtensionUiRequest(state, request("custom", { lines: ["x"], id: "c" })).state;
  state = applyExtensionUiRequest(state, request("setStatus", { statusKey: "s", statusText: "ok" })).state;
  const cleared = clearAllExtensionUiBlocking(state);
  assert.equal(cleared.dialog, null);
  
  assert.deepEqual(cleared.blockingQueue, []);
  // custom / status 保留（reset 仅清阻塞）
  assert.equal(cleared.customUi?.id, "c");
  assert.deepEqual(cleared.statuses, [{ key: "s", text: "ok" }]);
  // 二次 reset 保持引用
  assert.equal(clearAllExtensionUiBlocking(cleared), cleared);
});

test("未知 id 清理返回原引用；projectBlockingHead 空队列为空投影", () => {
  const state = applyExtensionUiRequest(base, request("confirm", { id: "a" })).state;
  assert.equal(clearExtensionUiRequest(state, "missing"), state);
  assert.deepEqual(projectBlockingHead([]), { dialog: null });
});


// ---------------------------------------------------------------------------
// Issue #104：终端图片随渲染结果下发（widget / custom 面板两条路）
// ---------------------------------------------------------------------------

const IMAGE = { id: "7", mime: "image/png", base64: "iVBORw0KGgo=", cols: 4, rows: 3, lineIndex: 1 };
const FALLBACK = { lineIndex: 2, reason: "too-large" };

test("#104 widget 帧带图片：状态里存下来，且参与去重比较", () => {
  const withImage = applyExtensionUiRequest(base, request("setWidget", {
    widgetKey: "w",
    widgetLines: ["", "", "", ""],
    widgetImages: [IMAGE],
    widgetImageFallbacks: [FALLBACK],
  }));
  assert.deepEqual(withImage.state.widgets[0].images, [IMAGE]);
  assert.deepEqual(withImage.state.widgets[0].imageFallbacks, [FALLBACK]);

  // 行内容完全相同但图片变了：必须更新（与 interactive 同一类，不然前端永远看不到新图）
  const changedImage = applyExtensionUiRequest(withImage.state, request("setWidget", {
    widgetKey: "w",
    widgetLines: ["", "", "", ""],
    widgetImages: [IMAGE, { ...IMAGE, id: "8", lineIndex: 3 }],
    // 显式空数组 = 降级没了（缺省才是「与上一帧相同」）
    widgetImageFallbacks: [],
  }));
  assert.notEqual(changedImage.state, withImage.state);
  assert.equal(changedImage.state.widgets[0].images.length, 2);

  // 降级信息没了：服务端会**显式**发空数组（缺省表示「与上一帧相同」），状态里要清掉，
  // 否则界面上会留着一句不存在的「图片无法显示」。
  assert.equal(changedImage.state.widgets[0].imageFallbacks, undefined, "显式空数组 = 清空");

  // 缺字段（服务端省略）= 与上一帧相同：旧图与旧降级都要保留
  const kept = applyExtensionUiRequest(changedImage.state, request("setWidget", {
    widgetKey: "w",
    widgetLines: ["新一行"],
  }));
  assert.equal(kept.state.widgets[0].images?.length, 2, "缺字段时保留上一帧的图片");

  // 显式空数组 = 图没了
  const cleared = applyExtensionUiRequest(kept.state, request("setWidget", {
    widgetKey: "w",
    widgetLines: ["新一行"],
    widgetImages: [],
    widgetImageFallbacks: [],
  }));
  assert.equal(cleared.state.widgets[0].images, undefined);
});

test("#104 custom 面板帧带图片：收口成数组并随状态下发", () => {
  const opened = applyExtensionUiRequest(base, request("custom", { id: "p1", lines: ["", ""], images: [IMAGE], imageFallbacks: [FALLBACK] }));
  assert.deepEqual(opened.state.customUi?.images, [IMAGE]);
  assert.deepEqual(opened.state.customUi?.imageFallbacks, [FALLBACK]);

  // 三种情形要分清：**缺省**（服务端图片没变时刻意省略）与**坏形状**都保留上一帧
  // —— 清掉会让图静默消失，正是 issue #104 要修的坑；只有**显式空数组**才是「图没了」。
  const absent = applyExtensionUiRequest(opened.state, request("custom", { id: "p1", lines: ["x"] }));
  assert.deepEqual(absent.state.customUi?.images, [IMAGE], "缺省 = 保留上一帧");
  const garbage = applyExtensionUiRequest(opened.state, request("custom", { id: "p1", lines: ["x"], images: "不是数组" }));
  assert.deepEqual(garbage.state.customUi?.images, [IMAGE], "坏形状按缺省处理（不清空）");
  const cleared = applyExtensionUiRequest(opened.state, request("custom", { id: "p1", lines: ["x"], images: [] }));
  assert.equal(cleared.state.customUi?.images, undefined, "显式空数组才是「图没了」");
});

test("#104 水合：快照里的图片随面板一起恢复", () => {
  const restored = restoreCustomUi(base, { id: "panel-9", lines: ["a"], images: [IMAGE], imageFallbacks: [FALLBACK] });
  assert.deepEqual(restored.customUi?.images, [IMAGE]);
  assert.deepEqual(restored.customUi?.imageFallbacks, [FALLBACK]);
});

// ---------------------------------------------------------------------------
// Issue #34：从状态恢复活动 custom 面板
// ---------------------------------------------------------------------------

test("#34 状态里有活动面板且本地为空：恢复内容与输入入口", () => {
  const restored = restoreCustomUi(base, { id: "panel-1", lines: ["a", "b"] });
  assert.equal(restored.customUi?.id, "panel-1");
  assert.equal(restored.customUi?.method, "custom");
  assert.deepEqual(restored.customUi?.lines, ["a", "b"]);
});

test("#34 已是同一个面板：不覆盖（保护刚由事件刷新的行）", () => {
  const opened = applyExtensionUiRequest(base, request("custom", { id: "p1", lines: ["事件行"] }));
  const same = restoreCustomUi(opened.state, { id: "p1", lines: ["过期快照行"] });
  assert.equal(same, opened.state, "同一 id 必须原样返回，不覆盖更新的事件行");
  assert.deepEqual(same.customUi?.lines, ["事件行"]);
});

test("#34 状态里没有活动面板：不清理本地（关闭由 closed 事件负责）", () => {
  const opened = applyExtensionUiRequest(base, request("custom", { id: "p2", lines: ["x"] }));
  const kept = restoreCustomUi(opened.state, null);
  assert.equal(kept, opened.state, "缺少快照不得关掉刚打开的面板（避免与事件竞争）");
  assert.equal(restoreCustomUi(opened.state, { lines: ["无 id"] }), opened.state);
});

test("#34 不同 id：切换到快照描述的面板", () => {
  const opened = applyExtensionUiRequest(base, request("custom", { id: "old", lines: ["旧"] }));
  const next = restoreCustomUi(opened.state, { id: "new", lines: ["新"] });
  assert.equal(next.customUi?.id, "new");
  assert.deepEqual(next.customUi?.lines, ["新"]);
});

test("#34 非法 lines：过滤为非字符串，不抛错", () => {
  const restored = restoreCustomUi(base, { id: "p3", lines: ["ok", 1, null, "fine"] });
  assert.deepEqual(restored.customUi?.lines, ["ok", "fine"]);
  assert.deepEqual(restoreCustomUi(base, { id: "p4", lines: "not-array" }).customUi?.lines, []);
});

test("#34 恢复时保留 overlay 布局（否则刷新后浮层变回全屏模态、盖住输入区）", () => {
  const layout = { anchor: "center", width: "95%", maxHeight: "85%" };
  const restored = restoreCustomUi(base, { id: "p5", lines: ["x"], layout });
  assert.deepEqual(restored.customUi?.layout, layout);
  // 缺 layout：不给字段，前端回落到全屏模态
  assert.equal(restoreCustomUi(base, { id: "p6", lines: ["x"] }).customUi?.layout, undefined);
  // 脏快照（layout 不是对象）：不抛错，也不给字段
  assert.equal(restoreCustomUi(base, { id: "p7", lines: ["x"], layout: "center" }).customUi?.layout, undefined);
});

test("#34 同一个 id：早返回保护事件行，也不从快照补 layout", () => {
  // 事件与快照由同一次 custom() 产出，layout 一并下发；同 id 时事件行更新，
  // 本地 layout 保持不动。这里钉住「不补、不抹」这个行为。
  const opened = applyExtensionUiRequest(base, request("custom", { id: "p8", lines: ["事件行"] }));
  const same = restoreCustomUi(opened.state, {
    id: "p8",
    lines: ["旧行"],
    layout: { anchor: "center", width: "95%" },
  });
  assert.equal(same, opened.state, "同一 id 必须原样返回");
  assert.equal(same.customUi?.layout, undefined, "不得从快照补 layout（避免与事件竞争）");
  assert.deepEqual(same.customUi?.lines, ["事件行"]);
});

// ---------------------------------------------------------------------------
// 后台漏掉的提问：状态快照里的 pendingExtensionRequests → 阻塞队列
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 订阅前发出的能力提示：状态快照里的 extensionCapabilityNotices → 通知队列
// ---------------------------------------------------------------------------

test("pickCapabilityNotices：只取 {非空 id, 非空 message, warning} 三项齐全的条目", () => {
  const notice = (id) => ({ id, message: `Extension UI "${id}" is limited`, notifyType: "warning" });
  assert.deepEqual(pickCapabilityNotices(undefined), []);
  assert.deepEqual(pickCapabilityNotices("not-an-array"), []);
  assert.deepEqual(pickCapabilityNotices([null, 42, "x"]), []);
  assert.deepEqual(
    pickCapabilityNotices([
      notice("keep"),
      { id: "", message: "没有 id", notifyType: "warning" },
      { id: "blank", message: "   ", notifyType: "warning" },
      { id: "info", message: "别的级别", notifyType: "info" },
      { id: "numeric", message: 123, notifyType: "warning" },
      { id: "missingMsg", notifyType: "warning" },
    ]),
    [notice("keep")],
    "形状不全的一律丢掉：不能让插件 payload 借宿主提示的名义进通知",
  );
});

// 能力提示只由宿主自己发，这件事**不能**靠形状判断：宿主能力提示与插件的
// `notify(message, "warning")` 在形状上完全一样（method/id/message/notifyType 都相同）。
// 真正的保证是"快照数组只由适配器的 recordCapabilityNotice 写入"
// （lib/web-extension-ui.ts），插件自己的 notify 只 emit 事件、不进数组 ——
// 见 lib/web-extension-ui.test.mjs 的「能力提示留成只读快照」那条（含插件 warning）。
test("pickCapabilityNotices 只按形状过滤：一个 warning 形状的插件通知也会通过", () => {
  const pluginWarning = { type: "extension_ui_request", id: "n1", method: "notify", message: "插件通知", notifyType: "warning" };
  assert.deepEqual(
    pickCapabilityNotices([pluginWarning]),
    [{ id: "n1", message: "插件通知", notifyType: "warning" }],
    "形状相同就会通过 —— 所以这条函数不是插件通知的防线（防线在发出方）",
  );
  assert.deepEqual(
    pickCapabilityNotices([{ ...pluginWarning, notifyType: "info" }]),
    [],
    "非 warning 级别一律丢掉（适配器目前只发 warning）",
  );
});

test("pickBlockingExtensionRequests：只取阻塞方法，保持顺序", () => {
  const queue = pickBlockingExtensionRequests([
    request("confirm", { id: "c1", title: "确认" }),
    request("setStatus", { id: "s1" }),
    request("select", { id: "s2", options: ["a", "b"] }),
    request("notify", { id: "n1" }),
    request("editor", { id: "e1" }),
  ]);
  assert.deepEqual(queue.map((item) => item.id), ["c1", "s2", "e1"]);
  assert.deepEqual(projectBlockingHead(queue).dialog?.id, "c1");
});

test("pickBlockingExtensionRequests：非数组/非法项/缺 id 一律丢弃", () => {
  assert.deepEqual(pickBlockingExtensionRequests(undefined), []);
  assert.deepEqual(pickBlockingExtensionRequests("nope"), []);
  assert.deepEqual(pickBlockingExtensionRequests([null, 1, { method: "confirm" }]), []);
  // 缺 type 的旧形态不算（不得凭空弹出面板）
  assert.deepEqual(pickBlockingExtensionRequests([{ id: "x", method: "confirm" }]), []);
  assert.equal(pickBlockingExtensionRequests([request("confirm", { id: "ok" })])[0].id, "ok");
});

// ---------------------------------------------------------------------------
// 运行提示定制（setWorkingMessage / setWorkingVisible / setWorkingIndicator）
// ---------------------------------------------------------------------------

test("运行提示投影：文案 / 显隐 / 自定义帧（含「空帧 = 隐藏指示器」）", () => {
  let state = createEmptyExtensionUiState();
  assert.equal(state.workingMessage, null, "默认无自定义文案");
  assert.equal(state.workingVisible, true, "默认可见");
  assert.equal(state.workingIndicator, null, "默认用内置圆点");

  state = applyExtensionUiRequest(state, request("setWorkingMessage", { id: "w1", message: "排队中" })).state;
  assert.equal(state.workingMessage, "排队中");
  state = applyExtensionUiRequest(state, request("setWorkingMessage", { id: "w2", message: null })).state;
  assert.equal(state.workingMessage, null, "无参 = 恢复默认文案");

  state = applyExtensionUiRequest(state, request("setWorkingVisible", { id: "v1", visible: false })).state;
  assert.equal(state.workingVisible, false);

  state = applyExtensionUiRequest(
    state,
    request("setWorkingIndicator", { id: "i1", frames: ["●", "○"], intervalMs: 80 }),
  ).state;
  assert.deepEqual(state.workingIndicator, { frames: ["●", "○"], intervalMs: 80 });

  // frames: [] 是「隐藏指示器」的有效声明，不能被当成「未提供」而回退默认
  state = applyExtensionUiRequest(
    state,
    request("setWorkingIndicator", { id: "i2", frames: [], intervalMs: null }),
  ).state;
  assert.deepEqual(state.workingIndicator, { frames: [], intervalMs: 120 });

  state = applyExtensionUiRequest(
    state,
    request("setWorkingIndicator", { id: "i3", frames: null, intervalMs: null }),
  ).state;
  assert.equal(state.workingIndicator, null, "frames: null = 恢复默认");
});

test("setToolsExpanded 进状态：值相同也递增序号（issue #75）", () => {
  const base = createEmptyExtensionUiState();
  assert.equal(base.toolsExpanded, null, "从未请求过时是 null（客户端保持每块的用户选择）");

  const first = applyExtensionUiRequest(base, { type: "extension_ui_request", id: "r1", method: "setToolsExpanded", toolsExpanded: false });
  assert.equal(first.state.toolsExpanded, false);
  assert.equal(first.state.toolsExpandedRevision, 1);
  assert.deepEqual(first.effects, [], "展开态是状态不是副作用（客户端从 state 读）");

  const second = applyExtensionUiRequest(first.state, { type: "extension_ui_request", id: "r2", method: "setToolsExpanded", toolsExpanded: false });
  assert.equal(second.state.toolsExpandedRevision, 2, "同一个值再请求一次也必须让客户端再执行一次");

  const third = applyExtensionUiRequest(second.state, { type: "extension_ui_request", id: "r3", method: "setToolsExpanded", toolsExpanded: true });
  assert.equal(third.state.toolsExpanded, true);
  assert.equal(third.state.toolsExpandedRevision, 3);

  const reset = resetExtensionUiForSession(third.state);
  assert.equal(reset.toolsExpanded, null, "切会话要把请求态清掉（新会话不该继承）");
  assert.equal(reset.toolsExpandedRevision, 0);
});

// ---------------------------------------------------------------------------
// Issue #100 审查修复：已结算的 id 不再被迟到的快照装回来
// ---------------------------------------------------------------------------

test("parseExtensionUiSettledId：只认形状正确的结束事件", () => {
  assert.equal(parseExtensionUiSettledId({ type: "extension_ui_settled", id: "a", reason: "timeout" }), "a");
  assert.equal(parseExtensionUiSettledId({ type: "extension_ui_settled", id: "a" }), "a", "reason 缺失不影响取 id");
  assert.equal(parseExtensionUiSettledId({ type: "extension_ui_request", id: "a" }), null);
  assert.equal(parseExtensionUiSettledId({ type: "extension_ui_settled" }), null);
  assert.equal(parseExtensionUiSettledId({ type: "extension_ui_settled", id: "" }), null);
  assert.equal(parseExtensionUiSettledId({ type: "extension_ui_settled", id: 7 }), null);
  assert.equal(parseExtensionUiSettledId(null), null);
  assert.equal(parseExtensionUiSettledId("extension_ui_settled"), null);
});

test("rememberSettledRequestId：去重、移到末尾、有界丢弃最旧", () => {
  assert.deepEqual(rememberSettledRequestId([], "a"), ["a"]);
  assert.deepEqual(rememberSettledRequestId(["a"], "a"), ["a"], "重复记住不增长");
  assert.deepEqual(rememberSettledRequestId(["a", "b"], "a"), ["b", "a"], "再次记住要移到末尾（最后被淘汰）");

  let ids = [];
  for (let i = 0; i < MAX_SETTLED_REQUEST_IDS + 5; i += 1) ids = rememberSettledRequestId(ids, "id-" + i);
  assert.equal(ids.length, MAX_SETTLED_REQUEST_IDS, "必须有界");
  assert.equal(ids.includes("id-0"), false, "最旧的被丢掉");
  assert.equal(ids[ids.length - 1], "id-" + (MAX_SETTLED_REQUEST_IDS + 4), "最新的在末尾");
});

test("filterSettledBlockingRequests：滤掉已结算的 id，无变化时返回原引用", () => {
  const queue = [
    { id: "a", method: "select" },
    { id: "b", method: "confirm" },
    { id: "c", method: "input" },
  ];
  assert.equal(filterSettledBlockingRequests(queue, []), queue, "没有已结算 id 时不复制");
  assert.equal(filterSettledBlockingRequests(queue, ["zzz"]), queue, "没有命中时不复制");
  const filtered = filterSettledBlockingRequests(queue, ["a", "c"]);
  assert.deepEqual(filtered.map((item) => item.id), ["b"]);
});

test("setTheme 进副作用：内置主题映射成壳的明暗（issue #97）", () => {
  const base = createEmptyExtensionUiState();

  const light = applyExtensionUiRequest(base, { type: "extension_ui_request", id: "t1", method: "setTheme", mode: "light" });
  assert.deepEqual(light.effects, [{ type: "setThemeMode", mode: "light" }], "壳要跟着切明暗（皮肤不变）");

  const dark = applyExtensionUiRequest(light.state, { type: "extension_ui_request", id: "t2", method: "setTheme", mode: "dark" });
  assert.deepEqual(dark.effects, [{ type: "setThemeMode", mode: "dark" }]);

  // 非法载荷不许把壳改成未定义状态：非 light 一律当 dark（服务端只发这两个值，这里是兜底）。
  const bogus = applyExtensionUiRequest(dark.state, { type: "extension_ui_request", id: "t3", method: "setTheme", mode: "chartreuse" });
  assert.deepEqual(bogus.effects, [{ type: "setThemeMode", mode: "dark" }]);
});

// ---------------------------------------------------------------------------
// 插件页头 / 页脚槽位（setHeader / setFooter，issue #98）
// ---------------------------------------------------------------------------

test("setHeader / setFooter：槽位行写入，空数组与 null 都按「没有内容」处理", () => {
  const header = applyExtensionUiRequest(base, request("setHeader", { lines: ["A"] }));
  assert.deepEqual(header.state.header, ["A"]);
  assert.equal(header.state.footer, null, "写页头不该动页脚");

  const footer = applyExtensionUiRequest(header.state, request("setFooter", { lines: ["B"] }));
  assert.deepEqual(footer.state.footer, ["B"]);
  assert.deepEqual(footer.state.header, ["A"]);

  // TUI 的 setFooter(undefined) 是「把内置页脚换回来」：空数组同样是没有内容。
  assert.equal(applyExtensionUiRequest(footer.state, request("setFooter", { lines: null })).state.footer, null);
  assert.equal(applyExtensionUiRequest(footer.state, request("setHeader", { lines: [] })).state.header, null);
});

test("setHeader / setFooter：内容相同不重写 state（按内容比，不按引用）", () => {
  const first = applyExtensionUiRequest(base, request("setFooter", { lines: ["a", "b"] }));
  // 适配器每次 publish 都新建数组：引用比较永远不命中，会让每次重渲都写一次 state。
  const same = applyExtensionUiRequest(first.state, request("setFooter", { lines: ["a", "b"] }));
  assert.equal(same.state, first.state, "同样的行不该产生新 state");

  const changed = applyExtensionUiRequest(first.state, request("setFooter", { lines: ["a", "c"] }));
  assert.notEqual(changed.state, first.state);
  assert.deepEqual(changed.state.footer, ["a", "c"]);
});

test("切会话清掉页头页脚：新会话不继承上一个会话的插件槽位", () => {
  const withSlots = applyExtensionUiRequest(
    applyExtensionUiRequest(base, request("setHeader", { lines: ["head"] })).state,
    request("setFooter", { lines: ["foot"] }),
  ).state;
  assert.deepEqual(withSlots.header, ["head"]);

  const reset = resetExtensionUiForSession(withSlots);
  assert.equal(reset.header, null);
  assert.equal(reset.footer, null);
});

test("#104 custom 图片缺省 = 保留上一帧；显式空数组才清空", () => {
  const image = { id: "1", mime: "image/png", base64: "AAAA", cols: 2, rows: 2, lineIndex: 0 };
  const withImage = applyExtensionUiRequest(createEmptyExtensionUiState(), {
    type: "extension_ui_request",
    id: "c1",
    method: "custom",
    lines: ["标题", ""],
    images: [image],
  });
  assert.deepEqual(withImage.state.customUi?.images, [image], "首帧带上图");
  // 服务端图片没变时会省略字段（每帧重发几百 KB 的 base64太贵）
  const withoutField = applyExtensionUiRequest(withImage.state, {
    type: "extension_ui_request",
    id: "c1",
    method: "custom",
    lines: ["标题", ""],
    focus: "panel",
  });
  assert.deepEqual(withoutField.state.customUi?.images, [image], "缺省必须保留上一帧的图");
  // 显式空数组 = 图没了
  const cleared = applyExtensionUiRequest(withoutField.state, {
    type: "extension_ui_request",
    id: "c1",
    method: "custom",
    lines: ["标题"],
    images: [],
  });
  assert.equal(cleared.state.customUi?.images, undefined, "显式空数组要清掉");
});

const IMG = [{ id: "i1", mime: "image/png", base64: "AAA", cols: 2, rows: 1, lineIndex: 0 }];

test("编辑器接管帧：内容与图片写入状态，缺省图片 = 沿用上一帧（issue #107）", () => {
  const opened = applyExtensionUiRequest(base, {
    type: "extension_ui_request", id: "e1", method: "editorComponent", lines: ["a"], images: IMG,
  }).state;
  assert.equal(opened.editorTakeover?.id, "e1");
  assert.deepEqual(opened.editorTakeover?.lines, ["a"]);
  assert.equal(opened.editorTakeover?.images?.length, 1);

  // 没带 images 的帧 = 服务端省略了 base64（图片没变）：客户端必须保留上一帧的图。
  const next = applyExtensionUiRequest(opened, {
    type: "extension_ui_request", id: "e1", method: "editorComponent", lines: ["a", "b"],
  }).state;
  assert.deepEqual(next.editorTakeover?.lines, ["a", "b"]);
  assert.equal(next.editorTakeover?.images?.length, 1, "缺省图片要沿用，不能清掉");

  // 显式空数组 = 图没了（显式清空必须生效）。
  const cleared = applyExtensionUiRequest(next, {
    type: "extension_ui_request", id: "e1", method: "editorComponent", lines: ["c"], images: [],
  }).state;
  assert.equal(cleared.editorTakeover?.images, undefined, "显式空数组要清掉图");
});

test("编辑器接管帧：内容完全相同就不换对象（每帧都换会让界面整体重渲）", () => {
  const first = applyExtensionUiRequest(base, {
    type: "extension_ui_request", id: "e1", method: "editorComponent", lines: ["a"], images: IMG,
  }).state;
  const second = applyExtensionUiRequest(first, {
    type: "extension_ui_request", id: "e1", method: "editorComponent", lines: ["a"], images: IMG,
  }).state;
  assert.equal(first.editorTakeover, second.editorTakeover, "同内容应复用同一个对象");
  assert.equal(sameEditorComponent(first.editorTakeover, second.editorTakeover), true);
  const changed = { ...first.editorTakeover, lines: ["a", "b"] };
  assert.equal(sameEditorComponent(first.editorTakeover, changed), false, "内容变了要判不等");
  assert.equal(sameEditorComponent(first.editorTakeover, null), false);
});

test("编辑器接管帧：closed 恢复我们自己的输入框（降级与插件卸下都走它）", () => {
  const opened = applyExtensionUiRequest(base, {
    type: "extension_ui_request", id: "e1", method: "editorComponent", lines: ["a"],
  }).state;
  const closed = applyExtensionUiRequest(opened, {
    type: "extension_ui_request", id: "e1", method: "editorComponent", closed: true,
  });
  assert.equal(closed.state.editorTakeover, null);
  assert.deepEqual(closed.effects, [], "结束接管没有副作用");
  // 本来就没有接管时 closed 不该产生新状态（避免无谓重渲）
  const noop = applyExtensionUiRequest(base, {
    type: "extension_ui_request", id: "e1", method: "editorComponent", closed: true,
  });
  assert.equal(noop.state, base);
});

test("编辑器提交产出 editorSubmit 效果：只带文本，状态不动（issue #107）", () => {
  const opened = applyExtensionUiRequest(base, {
    type: "extension_ui_request", id: "e1", method: "editorComponent", lines: ["a"],
  }).state;
  const submitted = applyExtensionUiRequest(opened, {
    type: "extension_ui_request", id: "e1", method: "editorComponentSubmit", text: "你好",
  });
  assert.deepEqual(submitted.effects, [{ type: "editorSubmit", text: "你好" }]);
  assert.equal(submitted.state.editorTakeover?.id, "e1", "提交不改接管状态");
  // 带来源标签（哪个标签敲的字）时要原样传下去：客户端靠它判断
  // 「这次提交是不是我敲的」，否则每个订阅该会话的标签都会提交一次。
  const tagged = applyExtensionUiRequest(opened, {
    type: "extension_ui_request", id: "e1", method: "editorComponentSubmit", text: "你好", clientId: "tab-B",
  });
  assert.deepEqual(tagged.effects, [{ type: "editorSubmit", text: "你好", clientId: "tab-B" }]);
});

test("切会话清掉接管：新会话由它自己的水合填回（不继承上个会话的编辑器）", () => {
  const opened = applyExtensionUiRequest(base, {
    type: "extension_ui_request", id: "e1", method: "editorComponent", lines: ["a"],
  }).state;
  assert.equal(resetExtensionUiForSession(opened).editorTakeover, null);
});
