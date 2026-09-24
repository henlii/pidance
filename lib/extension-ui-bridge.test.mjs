import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  applyExtensionUiRequest,
  clearAllExtensionUiBlocking,
  resetExtensionUiForSession,
  clearExtensionUiRequest,
  createEmptyExtensionUiState,
  projectBlockingHead,
  pickBlockingExtensionRequests,
  restoreCustomUi,
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
    { key: "x", lines: ["保留"], placement: "aboveEditor" },
    { key: "w", lines: ["一"], placement: "aboveEditor" },
  ]);
  const changed = applyExtensionUiRequest(added.state, request("setWidget", { widgetKey: "w", widgetLines: ["二"], widgetPlacement: "belowEditor" }));
  assert.deepEqual(changed.state.widgets[1], { key: "w", lines: ["二"], placement: "belowEditor" });
  assert.deepEqual(applyExtensionUiRequest(changed.state, request("setWidget", { widgetKey: "w" })).state.widgets, [
    { key: "x", lines: ["保留"], placement: "aboveEditor" },
  ]);
});

test("title 和编辑器文本会产生 effect，空 title 不产生 effect", () => {
  assert.deepEqual(applyExtensionUiRequest(base, request("setTitle", { title: "标题" })).effects, [{ type: "setTitle", title: "标题" }]);
  assert.deepEqual(applyExtensionUiRequest(base, request("setTitle", { title: "" })).effects, []);
  assert.deepEqual(applyExtensionUiRequest(base, request("set_editor_text", { text: "内容" })).effects, [{ type: "insertText", text: "内容" }]);
});

test("/btw custom 缺 lines 时不得抛错，并落成空行数组", () => {
  const opened = applyExtensionUiRequest(base, request("custom"));
  assert.deepEqual(opened.state.customUi.lines, []);
  const unknown = applyExtensionUiRequest(base, { type: "extension_ui_request", id: "x", method: "custom_render" });
  assert.equal(unknown.state, base);
  assert.deepEqual(unknown.effects, []);
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
  // 两条水合路径：热状态投影 与 applyAgentStateSnapshot（切会话/磁盘载荷）。
  const calls = src.match(/applyExtensionListenerCount\(state\)/g) ?? [];
  assert.ok(calls.length >= 2, `两条水合路径都要采纳（实际 ${calls.length} 处）`);
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
