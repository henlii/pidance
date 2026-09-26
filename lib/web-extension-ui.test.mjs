/**
 * WebExtensionUIAdapter 回归：SDK 扩展常用 API 签名契约。
 * 曾踩坑：theme.fg(name, text) 两参数签名不匹配导致 mcp status 变 "accent"。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
// 渲染桥的主题实例是 SDK 的 `Theme` 类，由宿主注入（issue #97）：测试走同一条注入。
const { setPiThemeConstructor, renderComponentLines: renderComponentLinesForTest } = await jiti.import("./tui-render-bridge.ts");
const { Theme: SdkTheme } = await import("@earendil-works/pi-coding-agent");
setPiThemeConstructor(SdkTheme);
const { createWebExtensionUIAdapter, createFallbackThemeStub, appendCapabilityNotice, MAX_CAPABILITY_NOTICES, normalizeDialogTimeout, MAX_DIALOG_TIMEOUT_MS, normalizeCustomBounds } = await jiti.import("./web-extension-ui.ts");
const { Text } = await import("@earendil-works/pi-tui");
const { stripAnsi } = await jiti.import("./ansi.ts");
const { getPidancePrefsBus } = await jiti.import("./pidance-prefs-bus.ts");

function makeAdapter(options = {}) {
  const emitted = [];
  const adapter = createWebExtensionUIAdapter((event) => emitted.push(event), options);
  return { adapter, emitted };
}

test("theme.fg(name, text) 两参数给真主题上色，文本内容不变", () => {
  const { adapter } = makeAdapter();
  const theme = adapter.uiContext.theme;
  // 真 Theme.fg 会带 ANSI；Web 侧状态条与 widget 行都解析 ANSI，所以内容必须原样保留。
  assert.equal(stripAnsi(theme.fg("accent", "MCP: 2/2 servers")), "MCP: 2/2 servers");
  assert.ok(theme.fg("accent", "MCP: 2/2 servers").includes("\u001b["), "真主题应产出 ANSI");
  // 真 Theme 的成员（注意：dim 不是 Theme 的方法，旧存根自己加过它）
  for (const style of ["bold", "italic", "underline", "inverse", "strikethrough"]) {
    assert.equal(stripAnsi(theme[style]("T")), "T", style);
  }
  assert.equal(theme.dim, undefined, "dim 不是真 Theme 成员，对齐后应为 undefined");
});

test("theme 是真 Theme：类型正确，数据字段不是函数，未知成员为 undefined（issue #72）", () => {
  const { adapter } = makeAdapter();
  const theme = adapter.uiContext.theme;
  assert.equal(typeof theme.name, "string", "theme.name 必须是字符串");
  assert.equal(theme.getColorMode(), "truecolor");
  assert.equal(typeof theme.getFgAnsi("accent"), "string");
  assert.ok(theme.getFgAnsi("accent").length > 0, "真主题的 ANSI 不应为空");
  assert.equal(typeof theme.getBgAnsi("selectedBg"), "string");
  assert.equal(typeof theme.getThinkingBorderColor("high"), "function");
  assert.equal(stripAnsi(theme.getThinkingBorderColor("high")("z")), "z");
  assert.equal(typeof theme.getBashModeBorderColor(), "function");
  // 数据字段就是数据：以前被 Proxy 变成可调用透传，于是 `if (theme.sourcePath)` 恒真。
  assert.notEqual(typeof theme.sourcePath, "function", "sourcePath 不能是函数");
  assert.equal(theme.sourcePath, undefined);
  assert.notEqual(typeof theme.sourceInfo, "function", "sourceInfo 不能是函数");
  assert.equal(theme.notARealMember, undefined, "未知成员按终端语义是 undefined");
  assert.equal(theme.then, undefined, "不能被当成 thenable");
});

test("主题副本加载失败时的存根：方法可调用、数据字段仍不是函数", () => {
  const stub = createFallbackThemeStub();
  assert.equal(stub.fg("accent", "x"), "x");
  assert.equal(stub.bg("selectedBg", "y"), "y");
  assert.equal(stub.bold("T"), "T");
  assert.equal(stub.getColorMode(), "truecolor");
  assert.equal(typeof stub.getThinkingBorderColor("high"), "function");
  assert.equal(stub.sourcePath, undefined, "存根也不能把数据字段变成函数");
  assert.equal(stub.notARealMember, undefined, "存根不再是 Proxy：未知成员为 undefined");
});

test("setStatus 事件投影完整文本", () => {
  const { adapter, emitted } = makeAdapter();
  adapter.uiContext.setStatus("mcp", "MCP: 0/1 servers");
  assert.equal(adapter.statuses.get("mcp"), "MCP: 0/1 servers");
  const event = emitted.find((e) => e.method === "setStatus");
  assert.equal(event?.statusText, "MCP: 0/1 servers");
});

test("#104 字符串数组 widget 也摘图：base64 不再当正文显示", () => {
  const { adapter, emitted } = makeAdapter();
  const kitty = `${ESC}_Gf=100,a=T,i=9,c=4,r=1;${KITTY_PNG}${ESC}\\`;
  adapter.uiContext.setWidget("s", ["标题", kitty]);
  const event = setWidgetFrames(emitted).at(-1);
  assert.ok(!String(event.widgetLines).includes(KITTY_PNG), "base64 不能留在正文里");
  assert.deepEqual(event.widgetLines, ["标题", ""], "序列行变成空行占位");
  assert.equal(event.widgetImages?.length, 1, "图要摘成结构化图片下发");
  assert.equal(adapter.widgets.get("s").images?.length, 1, "表里也要带图（水合/对账要用）");
});
test("setWidget 支持 string[] 与 placement", () => {
  const { adapter, emitted } = makeAdapter();
  adapter.uiContext.setWidget("w", ["line1", "line2"], { placement: "belowEditor" });
  const entry = adapter.widgets.get("w");
  assert.deepEqual(entry?.lines, ["line1", "line2"]);
  assert.equal(entry?.placement, "belowEditor");
  const event = emitted.find((e) => e.method === "setWidget");
  assert.deepEqual(event?.widgetLines, ["line1", "line2"]);
  assert.equal(event?.widgetPlacement, "belowEditor");
  // 清空
  adapter.uiContext.setWidget("w", undefined);
  assert.equal(adapter.widgets.has("w"), false);
});

test("custom() 投影 Component.render 行，Ctrl-C 关闭面板", async () => {
  const { adapter, emitted } = makeAdapter();
  const opened = adapter.uiContext.custom(() => ({
    render() {
      return ["/btw overlay"];
    },
    handleInput() {},
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const customEvent = emitted.find((event) => event.method === "custom" && !event.closed);
  assert.deepEqual(customEvent?.lines, ["/btw overlay"]);
  assert.equal(adapter.inputCustom(customEvent.id, "\x03"), true);
  await opened;
  assert.ok(emitted.some((event) => event.method === "custom" && event.closed === true));
});

test("阻塞请求按 id 单次 settle；过期响应忽略", async () => {
  const { adapter } = makeAdapter();
  const p = adapter.uiContext.confirm("title", "msg");
  assert.equal(adapter.pending.size, 1);
  const id = adapter.pendingSnapshot.keys().next().value;
  adapter.respond(id, { confirmed: true });
  const result = await p;
  assert.equal(result, true);
  // 已 settle：再次 respond 返回 false（不重复 resolve）
  assert.equal(adapter.respond(id, { confirmed: false }), false);
});

// ---------------------------------------------------------------------------
// Issue #34：活动 custom 面板的可恢复快照
//
// custom 只有 SSE 事件、没有重放。刷新/切回后服务端仍在等输入，但浏览器端
// 既无内容也无输入入口。get_state 必须能带回最后可重放的投影。
// ---------------------------------------------------------------------------

test("#34 custom 面板保存可恢复快照；关闭后清空", async () => {
  const { createWebExtensionUIAdapter } = await jiti.import("./web-extension-ui.ts");
  const events = [];
  const adapter = createWebExtensionUIAdapter((event) => events.push(event));

  assert.equal(adapter.customSnapshot, null, "初始无活动面板");

  const factory = async (tui) => ({
    render: () => ["status: ready", "press q to quit"],
    handleInput: () => {},
  });
  const pending = adapter.uiContext.custom(factory);
  await new Promise((r) => setTimeout(r, 10));

  const snapshot = adapter.customSnapshot;
  assert.ok(snapshot, "活动面板必须有快照");
  assert.ok(typeof snapshot.id === "string" && snapshot.id, "快照必须带 request id");
  assert.deepEqual(snapshot.lines, ["status: ready", "press q to quit"], "快照保存最后渲染行");

  // 渲染行变化后快照跟随（面板内容会随输入更新）
  const emitted = events.filter((e) => e.method === "custom" && !e.closed);
  assert.ok(emitted.length >= 1);

  // Ctrl-C 关闭：快照必须清空，否则刷新后会恢复一个已关闭的面板
  adapter.inputCustom(snapshot.id, "\x03");
  await pending;
  assert.equal(adapter.customSnapshot, null, "面板关闭后不得再恢复");
});

test("#34 host 状态投影包含活动 custom 快照", async () => {
  const hostSrc = readFileSync(new URL("./sdk-session-host.ts", import.meta.url), "utf8");
  assert.match(hostSrc, /activeCustomUi:\s*this\.extensionUi\?\.customSnapshot/, "get_state 必须下发活动 custom 快照");
});

// 按键窄口子的门槛值必须能从状态快照水合：它此前只靠瞬时 terminalInputListeners
// 事件下发，页面在插件注册监听器之后才加载/reload 就永远拿不到真值 → ChatWindow 的
// extensionWidgetKeysEnabled 恒为 false → 按键永不路由（实测：子代理在跑、widget 已在
// 页面上，空输入框按 ↓ 不激活）。
// issue #93：宿主自己发的能力提示走一次性 SSE 事件，而 host 启动、扩展加载、
// 注册监听器都发生在浏览器订阅之前 —— 那一刻没有订阅者就永久丢掉（实测：服务端
// 日志 5 次、页面 DOM 0 次）。适配器必须把发过的提示留成只读快照，宿主状态投影
// 才不会把这条"可见降级"提示吃掉。
test("能力提示留成只读快照：只记宿主自己发的，不记插件的 notify", () => {
  const { adapter, emitted } = makeAdapter();
  // 只能按文案区分：宿主能力提示与插件的 warning notify 在**形状上完全一样**
  // （method/id/message/notifyType）。所以"要不要重放"这件事只能由**发出方**
  // 决定（recordCapabilityNotice），不能靠 payload 猜——下面第 3 条断言就守这条。
  const noticeIds = () =>
    emitted
      .filter((e) => e.method === "notify" && /is (not supported|limited) by the Pidance web client/.test(String(e.message)))
      .map((e) => e.id);
  assert.deepEqual(adapter.capabilityNoticeSnapshot, [], "没提示过就是空");

  // 插件自己调的 notify：一次性通知，不在重放集合里（否则每次开页面都重弹）。
  // warning 也要试：插件用 warning 是常态（pi-subagents 就用），但它仍然是**一次性
  // 通知**，不能因为它长得像宿主的能力提示就被重放。
  adapter.uiContext.notify("subagent done", "info");
  adapter.uiContext.notify("subagent failed", "warning");
  assert.deepEqual(adapter.capabilityNoticeSnapshot, [], "插件的 notify 不得进重放快照（含 warning）");

  // 宿主的能力提示：不支持 + 只部分支持，两者都要留。
  // setFooter / setHeader（#98）、addAutocompleteProvider（#101）、setEditorComponent（#107）
  // 都已实现，所以改用**仍然没有等价语义**的能力：插件把终端 stdio 让出去
  // （tui.stop()/start()，B7 判定不做），它走同一条提示通道。
  adapter.uiContext.setEditorComponent((tui) => {
    tui.stop();
    return new Text("x", 0, 0);
  });
  const notices = adapter.capabilityNoticeSnapshot;
  assert.equal(notices.length, 1, "让出终端这个能力应留下一条提示");
  assert.equal(notices[0].notifyType, "warning");
  assert.match(notices[0].message, /is not supported/);
  assert.match(notices[0].message, /tui\.stop\(\)/);
  assert.ok(notices[0].id.length > 0, "每条要带 id：客户端按 id 去重（同一条到两次只显示一条）");

  adapter.uiContext.onTerminalInput(() => undefined);
  const both = adapter.capabilityNoticeSnapshot;
  assert.equal(both.length, 2, "onTerminalInput 的 limited 提示也要留");
  assert.match(both[1].message, /"onTerminalInput" is limited/);

  // 同一条提示在订阅前后可能各到一次：id 必须与下发事件里的 id 一致，去重才成立。
  assert.deepEqual(
    both.map((n) => n.id),
    noticeIds(),
    "快照 id 必须与事件 id 一致，客户端才能按 id 去重",
  );

  // 只读：调用方改拷贝不得污染内部快照。
  both[0].message = "tampered";
  assert.match(
    adapter.capabilityNoticeSnapshot[0].message,
    /tui\.stop\(\)/,
    "快照必须是拷贝，外部改动不能回写内部数组",
  );
});

test("能力提示快照有上限：超出保留最新，状态不会被撑到无界（issue #93 P2）", () => {
  // 取舍写在 MAX_CAPABILITY_NOTICES 的注释里：宿主能力提示的种类是枚举（当前 2 种），
  // 远小于上限，正常截不到；截断保留最新 —— 被丢的是"最旧的、可能还没被用户看见的"
  // 那条，这是有界换来的代价（改成无上限会让状态被反复调用的插件撑着）。
  const list = [];
  for (let i = 0; i < MAX_CAPABILITY_NOTICES + 3; i += 1) appendCapabilityNotice(list, { id: "n" + i });
  assert.equal(list.length, MAX_CAPABILITY_NOTICES, "上限必须挡住无界增长");
  assert.equal(list[0].id, "n3", "保留最新：最旧的先丢");
  assert.equal(list[list.length - 1].id, "n" + (MAX_CAPABILITY_NOTICES + 2), "最新的一定在");
  const small = [];
  appendCapabilityNotice(small, { id: "a" });
  appendCapabilityNotice(small, { id: "b" });
  assert.deepEqual(small.map((x) => x.id), ["a", "b"], "上限之内保持顺序、不截断");
});

test("host 状态投影包含能力提示快照（后加载的页面也能看到降级提示）", () => {
  const hostSrc = readFileSync(new URL("./sdk-session-host.ts", import.meta.url), "utf8");
  assert.match(
    hostSrc,
    /extensionCapabilityNotices:\s*this\.extensionUi\?\.capabilityNoticeSnapshot/,
    "get_state 必须下发能力提示快照，否则订阅前发出的那条提示后加载的页面永远看不到",
  );
});

test("host 状态投影包含插件按键监听器数量（后加载的页面也能拿到门槛真值）", async () => {
  const hostSrc = readFileSync(new URL("./sdk-session-host.ts", import.meta.url), "utf8");
  assert.match(
    hostSrc,
    /extensionTerminalInputListenerCount:\s*this\.extensionUi\?\.terminalInputListenerCount/,
    "get_state 必须下发监听器数量，否则按键窄口子对新加载的页面永远是关的",
  );
});

test("#34 dispose 后不得残留可恢复快照", async () => {
  const { createWebExtensionUIAdapter } = await jiti.import("./web-extension-ui.ts");
  const adapter = createWebExtensionUIAdapter(() => {});
  const pending = adapter.uiContext.custom(async () => ({ render: () => ["x"] }));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(adapter.customSnapshot);
  adapter.dispose();
  await pending.catch(() => {});
  assert.equal(adapter.customSnapshot, null, "dispose 后不得残留（否则会话销毁后仍会恢复旧面板）");
});

// ---------------------------------------------------------------------------
// 工厂形式 setWidget：实例常驻 + requestRender 热更新
//
// 曾踩坑：工厂渲染只取一次快照，且工厂收到的 tui 是 undefined。pi-subagents 的
// buildWidgetComponent 在 invalidate()/update() 里直接调 tui.requestRender()
// （无 ?. 保护），切到 TUI 路径后 job 一更新就 TypeError。
// ---------------------------------------------------------------------------

const tick = () => new Promise((resolve) => queueMicrotask(resolve));

function mountCounterWidget(adapter) {
  let frame = 0;
  let tui = null;
  adapter.uiContext.setWidget("w", (pluginTui) => {
    tui = pluginTui;
    return { render: () => [`frame ${++frame}`] };
  });
  return {
    get tui() {
      return tui;
    },
    get frame() {
      return frame;
    },
  };
}

function setWidgetFrames(emitted) {
  return emitted.filter((event) => event.method === "setWidget");
}

// ---------------------------------------------------------------------------
// Issue #104：终端图片（Kitty 协议）随渲染结果下发
// ---------------------------------------------------------------------------

const ESC = "\u001b";
const kittySequence = (params, payload) => `${ESC}_G${params};${payload}${ESC}\\`;
const KITTY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGZ0Z2QAAAAAElFTkSuQmCC";

test("#104 custom 帧：图片没变就不带 base64，移除时显式发空数组", async () => {
  const { adapter, emitted } = makeAdapter();
  let frame = 0;
  const kitty = `${ESC}_Gf=100,a=T,i=7;${KITTY_PNG}${ESC}\\`;
  const customFrames = () => emitted.filter((event) => event.method === "custom" && !event.closed);
  void adapter.uiContext.custom(() => ({
    render: (width) => {
      frame += 1;
      // 1 帧画图；2 帧不变（应省略 base64）；3 帧起去掉图（应显式发空数组）
      return frame <= 2 ? [`w${width}`, kitty] : [`w${width}`];
    },
    handleInput: () => {},
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(customFrames().length, 1, "首帧应该有");
  assert.equal(customFrames()[0].images?.length, 1, "首帧要带图（变了就发）");

  // 第二次重渲：图没变 → 必须省略 base64（focus / requestRender / 尺寸变化都会走 emitCustom）
  adapter.setRenderSize({ width: 60, rows: 30 });
  const afterSame = customFrames().at(-1);
  assert.notEqual(afterSame, customFrames()[0], "重渲仍要再推一帧");
  assert.equal(afterSame.images, undefined, "图片没变就不重发 base64（几百 KB × 每帧太贵）");
  assert.equal(adapter.customSnapshot?.images?.length, 1, "快照始终保留当前图片（刷新后要能水合）");

  // 第三次重渲：插件不再画图 → 必须**显式发空数组**（省略会让客户端留着旧图）
  adapter.setRenderSize({ width: 62, rows: 30 });
  const afterGone = customFrames().at(-1);
  assert.ok(Array.isArray(afterGone.images) && afterGone.images.length === 0, "图没了要显式发空数组，不能省略");
  assert.equal(adapter.customSnapshot?.images?.length ?? 0, 0, "快照也要跟着清掉");
});
test("#104 widget 组件里的图片：摘成结构化图片随帧下发（不留 ANSI 序列在文本里）", () => {
  const { adapter, emitted } = makeAdapter();
  adapter.uiContext.setWidget("img", () => ({
    render: () => [kittySequence("a=T,f=100,q=2,i=42,c=12,r=4", KITTY_PNG), "", "", ""],
  }));
  const frames = setWidgetFrames(emitted);
  const frame = frames[frames.length - 1];
  assert.equal(frame.widgetLines.length, 4, "行数不变（图片那行留空行，后面 3 行是组件给的占位）");
  assert.equal(frame.widgetLines[0], "", "文本侧不能再带序列");
  assert.deepEqual(frame.widgetImages, [
    { id: "42", mime: "image/png", base64: KITTY_PNG, cols: 12, rows: 4, lineIndex: 0 },
  ]);
  // 「缺省 = 与上一帧相同」：首帧一定会带上（这里没有降级，所以是显式空数组）。
  assert.deepEqual(frame.widgetImageFallbacks, [], "没有降级就显式发空数组（缺省表示没变）");
  const snapshot = adapter.widgets.get("img");
  assert.deepEqual(snapshot.images, frame.widgetImages, "快照要能刷新后水合");
});

test("#104 custom 面板里的图片：同样摘出来（含降级原因）", async () => {
  const { adapter, emitted } = makeAdapter();
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  void adapter.uiContext.custom(() => ({
    render: () => [kittySequence("a=T,f=100,i=5,c=3,r=1", KITTY_PNG), kittySequence("a=T,f=24,i=6", "AAAA")],
  }), { overlay: true }).then(() => done());
  await new Promise((resolve) => setImmediate(resolve));
  const frames = emitted.filter((event) => event.method === "custom" && !event.closed);
  const frame = frames[frames.length - 1];
  assert.ok(frame, "面板首帧必须已下发");
  assert.equal(frame.lines[0], "");
  assert.equal(frame.images.length, 1);
  assert.equal(frame.images[0].id, "5");
  assert.deepEqual(frame.imageFallbacks, [{ lineIndex: 1, reason: "unsupported-format" }]);
  assert.equal(adapter.customSnapshot?.images?.length, 1, "快照也要带上（刷新/切回后恢复）");
  adapter.uiContext.respond?.(frame.id, {});
  void finished;
});

test("#104 图片没变时不再重发 base64（缺省 = 与上一帧相同）", () => {
  const { adapter, emitted } = makeAdapter();
  let tui = null;
  adapter.uiContext.setWidget("img", (pluginTui) => {
    tui = pluginTui;
    return {
      render: () => [kittySequence("a=T,f=100,i=77,c=5,r=2", KITTY_PNG), ""],
    };
  });
  const first = setWidgetFrames(emitted).at(-1);
  assert.equal(first.widgetImages?.length, 1, "首帧必须带图");

  tui.requestRender();
  return new Promise((resolve) => {
    setTimeout(() => {
      const frames = setWidgetFrames(emitted);
      const second = frames.at(-1);
      assert.notEqual(second, first, "重渲仍要推一帧（内容是新的）");
      assert.equal(second.widgetImages, undefined, "图片没变就不重发 base64（几百 KB × 每帧太贵）");
      assert.equal(adapter.widgets.get("img").images?.length, 1, "快照始终保留当前图片（刷新后要能水合）");
      resolve();
    }, 20);
  });
});

test("#104 不支持图片的界面拿到的仍是文本：图片位置是可见说明，不是空白", () => {
  const component = { render: () => [kittySequence("a=T,f=100,i=7,c=2,r=1", KITTY_PNG)] };
  const lines = renderComponentLinesForTest(component);
  assert.deepEqual(lines, ["[image: image/png]"]);
});

test("setWidget 工厂：实例常驻，requestRender 触发重渲染并推新帧", async () => {
  const { adapter, emitted } = makeAdapter();
  const widget = mountCounterWidget(adapter);

  assert.deepEqual(setWidgetFrames(emitted)[0].widgetLines, ["frame 1"]);
  assert.deepEqual(adapter.widgets.get("w")?.lines, ["frame 1"]);
  assert.equal(typeof widget.tui.requestRender, "function");

  widget.tui.requestRender();
  await tick();
  assert.equal(setWidgetFrames(emitted).length, 2);
  assert.deepEqual(setWidgetFrames(emitted)[1].widgetLines, ["frame 2"]);
  assert.deepEqual(adapter.widgets.get("w")?.lines, ["frame 2"], "快照必须跟随热更新");
});

test("setWidget 工厂：同一 tick 内多次 requestRender 只推一帧", async () => {
  const { adapter, emitted } = makeAdapter();
  const widget = mountCounterWidget(adapter);
  const before = setWidgetFrames(emitted).length;

  widget.tui.requestRender();
  widget.tui.requestRender();
  widget.tui.requestRender();
  await tick();

  assert.equal(setWidgetFrames(emitted).length - before, 1, "三次请求只能产出一帧");
  assert.equal(widget.frame, 2, "初始 1 帧 + 合并后 1 帧");
});

test("setWidget 工厂：渲染抛错时保留上一次的行，不推空帧", async () => {
  const { adapter, emitted } = makeAdapter();
  let broken = false;
  let tui = null;
  adapter.uiContext.setWidget("w", (pluginTui) => {
    tui = pluginTui;
    return {
      render: () => {
        if (broken) throw new Error("boom");
        return ["ok"];
      },
    };
  });

  broken = true;
  tui.requestRender();
  await tick();

  assert.equal(setWidgetFrames(emitted).length, 1, "失败帧不得 emit");
  assert.deepEqual(adapter.widgets.get("w")?.lines, ["ok"]);
});

test("setWidget 工厂：清除时调组件 dispose，且丢弃在途帧", async () => {
  const { adapter, emitted } = makeAdapter();
  let disposed = 0;
  let tui = null;
  adapter.uiContext.setWidget("w", (pluginTui) => {
    tui = pluginTui;
    return {
      render: () => ["live"],
      dispose: () => {
        disposed += 1;
      },
    };
  });

  tui.requestRender();
  adapter.uiContext.setWidget("w", undefined);
  await tick();

  assert.equal(disposed, 1, "清除必须调 dispose");
  assert.equal(adapter.widgets.has("w"), false);
  const frames = setWidgetFrames(emitted);
  assert.equal(frames.at(-1).widgetLines, undefined, "最后一帧必须是清除，在途帧不得写回");
});

test("setWidget 工厂：换成字符串数组时卸载旧实例", () => {
  const { adapter } = makeAdapter();
  let disposed = 0;
  adapter.uiContext.setWidget("w", () => ({
    render: () => ["a"],
    dispose: () => {
      disposed += 1;
    },
  }));
  adapter.uiContext.setWidget("w", ["plain"]);

  assert.equal(disposed, 1);
  assert.deepEqual(adapter.widgets.get("w")?.lines, ["plain"]);
});

// ---------------------------------------------------------------------------
// widget 组件的鼠标事件（issue #103）
//
// pi-tui 的 widget 组件用 handleMouse 收局部字符坐标（pi-subagents 的 fleet widget
// 就是靠「第 0 行左键」把整块在摘要/全列表之间切）。Web 侧必须：只有组件真的实现了
// handleMouse 才把点击标成可交互，其余（字符串数组 widget、未实现的组件、已卸载）
// 一律不路由，前端才不会为每次点击付一次无谓往返。
// ---------------------------------------------------------------------------

/** 挂一个实现了 handleMouse 的 widget 工厂，返回收到的鼠标事件数组。 */
function mountMouseWidget(adapter, key = "w", options = {}) {
  const received = [];
  let tui = null;
  adapter.uiContext.setWidget(key, (pluginTui) => {
    tui = pluginTui;
    return {
      render: () => ["mouse widget"],
      ...(options.noHandleMouse
        ? {}
        : {
          handleMouse(event) {
            if (options.throwOnMouse) throw new Error("mouse boom");
            received.push(event);
          },
        }),
    };
  });
  return { received, get tui() { return tui; } };
}

test("widget 鼠标：实现了 handleMouse 的组件被标成 interactive，事件按 key 送达", () => {
  const { adapter, emitted } = makeAdapter();
  const widget = mountMouseWidget(adapter);

  assert.equal(adapter.widgets.get("w")?.interactive, true, "快照要带 interactive（水合路径要靠它）");
  assert.equal(setWidgetFrames(emitted).at(-1)?.widgetInteractive, true, "实时帧同样要带");

  const handled = adapter.inputWidgetMouse("w", { type: "click", button: "left", x: 0, y: 0 });
  assert.equal(handled, true, "命中组件要返回 true");
  assert.deepEqual(widget.received, [{ type: "click", button: "left", x: 0, y: 0 }]);
});

test("widget 鼠标：组件没实现 handleMouse 时不标 interactive，也不路由", () => {
  const { adapter, emitted } = makeAdapter();
  mountMouseWidget(adapter, "w", { noHandleMouse: true });

  assert.equal(adapter.widgets.get("w")?.interactive, false);
  assert.equal(setWidgetFrames(emitted).at(-1)?.widgetInteractive, false);
  assert.equal(adapter.inputWidgetMouse("w", { type: "click", x: 0, y: 0 }), false, "没有 handleMouse 就不该命中");
});

test("widget 鼠标：字符串数组 widget 永远不可交互（没有组件实例）", () => {
  const { adapter, emitted } = makeAdapter();
  adapter.uiContext.setWidget("w", ["plain", "lines"]);

  assert.equal(adapter.widgets.get("w")?.interactive, false);
  assert.equal(setWidgetFrames(emitted).at(-1)?.widgetInteractive, false);
  assert.equal(adapter.inputWidgetMouse("w", { type: "click", x: 1, y: 1 }), false);
});

test("widget 鼠标：未知 key 与已卸载的 widget 都返回 false（前端不发无谓请求）", () => {
  const { adapter } = makeAdapter();
  mountMouseWidget(adapter, "w");

  assert.equal(adapter.inputWidgetMouse("never-mounted", { type: "click", x: 0, y: 0 }), false);

  adapter.uiContext.setWidget("w", undefined);
  assert.equal(adapter.inputWidgetMouse("w", { type: "click", x: 0, y: 0 }), false, "卸载后不得再路由");
  assert.equal(adapter.widgets.has("w"), false);
});

test("widget 鼠标：换成字符串数组后不再路由（旧组件的 handleMouse 不得再被调用）", () => {
  const { adapter } = makeAdapter();
  const widget = mountMouseWidget(adapter, "w");

  adapter.uiContext.setWidget("w", ["plain"]);
  assert.equal(adapter.inputWidgetMouse("w", { type: "click", x: 0, y: 0 }), false);
  assert.deepEqual(widget.received, [], "旧实例不该再收到鼠标事件");
});

test("widget 鼠标：组件 handleMouse 抛错不外泄（一次点击不能带崩重渲管线）", () => {
  const { adapter } = makeAdapter();
  mountMouseWidget(adapter, "w", { throwOnMouse: true });

  assert.doesNotThrow(() => adapter.inputWidgetMouse("w", { type: "click", x: 0, y: 0 }));
  assert.equal(adapter.inputWidgetMouse("w", { type: "click", x: 0, y: 0 }), true, "抛错也算命中（组件存在）");
});

test("widget 鼠标：重新挂载同一个 key 后路由到新实例", () => {
  const { adapter } = makeAdapter();
  const first = mountMouseWidget(adapter, "w");
  const second = mountMouseWidget(adapter, "w");

  adapter.inputWidgetMouse("w", { type: "click", x: 2, y: 0 });
  assert.deepEqual(first.received, [], "旧实例已被替换");
  assert.deepEqual(second.received, [{ type: "click", x: 2, y: 0 }]);
});

test("widget 鼠标：dispose 适配器后不再路由", () => {
  const { adapter } = makeAdapter();
  mountMouseWidget(adapter, "w");

  adapter.dispose();
  assert.equal(adapter.inputWidgetMouse("w", { type: "click", x: 0, y: 0 }), false);
});

test("dispose 适配器时卸载 widget 工厂实例", () => {
  const { adapter } = makeAdapter();
  let disposed = 0;
  adapter.uiContext.setWidget("w", () => ({
    render: () => ["a"],
    dispose: () => {
      disposed += 1;
    },
  }));
  adapter.dispose();

  assert.equal(disposed, 1);
});

test("setWidget 工厂：同一 key 连续挂载会 dispose 旧实例，旧在途帧不得覆盖新帧", async () => {
  const { adapter, emitted } = makeAdapter();
  let disposed = 0;
  let firstTui = null;
  adapter.uiContext.setWidget("w", (pluginTui) => {
    firstTui = pluginTui;
    return {
      render: () => ["old"],
      dispose: () => {
        disposed += 1;
      },
    };
  });
  // 旧实例已排一帧，紧接着用同一个 key 换成新工厂
  firstTui.requestRender();
  adapter.uiContext.setWidget("w", () => ({ render: () => ["new"] }));
  await tick();

  assert.equal(disposed, 1, "旧实例必须被 dispose");
  assert.deepEqual(setWidgetFrames(emitted).at(-1).widgetLines, ["new"], "最后一帧必须是新实例内容");
  assert.deepEqual(adapter.widgets.get("w")?.lines, ["new"]);
});

test("setWidget 工厂：换成会抛错的工厂时清掉旧行，不留永不更新的投影", async () => {
  const { adapter, emitted } = makeAdapter();
  adapter.uiContext.setWidget("w", () => ({ render: () => ["live"] }));
  adapter.uiContext.setWidget("w", () => {
    throw new Error("boom");
  });
  await tick();

  assert.equal(adapter.widgets.has("w"), false, "旧投影必须清掉（否则界面留着死 widget）");
  assert.equal(setWidgetFrames(emitted).at(-1).widgetLines, undefined);
});

// ---------------------------------------------------------------------------
// 工具展开态、没有等价语义的 UI 能力、overlay 句柄
// ---------------------------------------------------------------------------

test("setToolsExpanded / getToolsExpanded 自洽并下发事件", () => {
  const { adapter, emitted } = makeAdapter();
  assert.equal(adapter.uiContext.getToolsExpanded(), false, "默认收起（与界面上的工具块默认收起一致）");

  adapter.uiContext.setToolsExpanded(true);
  assert.equal(adapter.uiContext.getToolsExpanded(), true);
  assert.equal(emitted.find((e) => e.method === "setToolsExpanded")?.toolsExpanded, true);

  adapter.uiContext.setToolsExpanded(false);
  assert.equal(adapter.uiContext.getToolsExpanded(), false);
});

test("没有等价语义的 UI 能力：不静默 no-op，但同一能力只提示一次", () => {
  const { adapter, emitted } = makeAdapter();
  // 唯一还没实现的是「让出终端 stdio」（B7 判定不做），拿它守「同一能力只提示一次」：
  // 插件换个编辑器就会再调一次同名能力，不该每次都弹。
  const handoverFactory = (tui, label) => {
    tui.stop();
    return new Text(label, 0, 0);
  };
  adapter.uiContext.setEditorComponent((tui) => handoverFactory(tui, "z"));
  adapter.uiContext.setEditorComponent((tui) => handoverFactory(tui, "w"));

  const notices = emitted.filter((e) => e.method === "notify" && e.notifyType === "warning");
  assert.equal(notices.length, 1, "同一能力多次调用只提示一次");
  assert.match(notices[0].message, /tui\.stop\(\)/);
});

test("没有等价语义的 UI 能力：恢复默认与「本来就支持」的调用不提示", () => {
  const { adapter, emitted } = makeAdapter();
  adapter.uiContext.setFooter(undefined);
  adapter.uiContext.setHeader(undefined);
  adapter.uiContext.setEditorComponent(undefined);
  adapter.uiContext.setWorkingMessage();
  adapter.uiContext.setWorkingIndicator();
  adapter.uiContext.setHiddenThinkingLabel();
  adapter.uiContext.setWorkingVisible(true);

  assert.equal(
    emitted.filter((e) => e.method === "notify").length,
    0,
    "恢复默认不该被当成降级；setWorkingVisible(true) 与 Web 现状一致",
  );
});

// ---------------------------------------------------------------------------
// ctx.ui.addAutocompleteProvider：插件补全链（issue #101）
//
// 这一组的重点是「链的语义」与「三态的区别」——客户端据此决定要不要回退到我们自己的
// @ 文件补全（回退决策本身的单测在 lib/completion-request.test.mjs）。
// ---------------------------------------------------------------------------

const completionSignal = () => new AbortController().signal;

test("补全：没有注册 provider 时 no-provider（客户端零往返），应用候选返回 null", async () => {
  const { adapter, emitted } = makeAdapter();
  assert.equal(adapter.autocompleteProviderCount, 0, "没注册时门槛是 0");
  assert.deepEqual(
    await adapter.suggestCompletions({ lines: ["@a"], cursorLine: 0, cursorCol: 2, signal: completionSignal() }),
    { kind: "no-provider" },
  );
  // 没注册时一次事件都不发（客户端无需知道任何东西）
  assert.deepEqual(emitted.filter((e) => e.method === "autocompleteProviders"), []);
  assert.equal(
    adapter.applyCompletion({
      lines: ["@a"],
      cursorLine: 0,
      cursorCol: 2,
      item: { value: "x", label: "x" },
      prefix: "@a",
    }),
    null,
    "链没注册时不猜插入位置",
  );
});

test("补全：注册时下发能力（数量 + 触发字符并集），且不再提示「不支持」", () => {
  const { adapter, emitted } = makeAdapter();
  adapter.uiContext.addAutocompleteProvider((current) => ({ ...current, triggerCharacters: ["@", "#"] }));
  adapter.uiContext.addAutocompleteProvider((current) => ({ ...current, triggerCharacters: ["@"] }));

  const events = emitted.filter((e) => e.method === "autocompleteProviders");
  assert.equal(events.length, 2, "每次注册都下发一次（增量）");
  assert.equal(events[1].count, 2);
  assert.deepEqual(events[1].triggerCharacters, ["@", "#"], "并集去重");
  assert.equal(adapter.autocompleteProviderCount, 2);
  assert.deepEqual(adapter.autocompleteTriggerCharacters, ["@", "#"]);
  assert.equal(
    emitted.filter((e) => e.method === "notify").length,
    0,
    "它已经实现了，不该再发「不支持」提示",
  );
});

test("补全：后注册的包住先注册的；插件的 applyCompletion 转发到链底也能应用", async () => {
  const { adapter } = makeAdapter();
  const order = [];
  adapter.uiContext.addAutocompleteProvider(() => ({
    getSuggestions: async () => {
      order.push("inner");
      return { items: [{ value: "@inner", label: "inner" }], prefix: "@i" };
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
      const line = lines[cursorLine];
      const from = Math.max(0, cursorCol - prefix.length);
      const next = line.slice(0, from) + item.value + line.slice(cursorCol);
      return { lines: [next], cursorLine, cursorCol: from + item.value.length };
    },
  }));
  adapter.uiContext.addAutocompleteProvider((current) => ({
    getSuggestions: async (lines, cursorLine, cursorCol, options) => {
      order.push("outer");
      // 外层自己没结果 → 落到内层（pi-fff 的写法）
      return current.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
      current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
  }));

  const outcome = await adapter.suggestCompletions({
    lines: ["@i"],
    cursorLine: 0,
    cursorCol: 2,
    signal: completionSignal(),
  });
  assert.deepEqual(order, ["outer", "inner"]);
  assert.equal(outcome.kind, "items");
  assert.deepEqual(outcome.items, [{ value: "@inner", label: "inner" }]);

  const applied = adapter.applyCompletion({
    lines: ["@i"],
    cursorLine: 0,
    cursorCol: 2,
    item: { value: "@inner", label: "inner" },
    prefix: "@i",
  });
  assert.deepEqual(applied, { lines: ["@inner"], cursorLine: 0, cursorCol: 6 });
});

test("补全：插件返回 [] 是「明确没有候选」，返回 null 是「交给下层」（三态不能混）", async () => {
  const empty = makeAdapter();
  empty.adapter.uiContext.addAutocompleteProvider(() => ({
    getSuggestions: async () => ({ items: [], prefix: "@x" }),
    applyCompletion: (lines) => ({ lines, cursorLine: 0, cursorCol: 0 }),
  }));
  assert.deepEqual(
    await empty.adapter.suggestCompletions({ lines: ["@x"], cursorLine: 0, cursorCol: 2, signal: completionSignal() }),
    { kind: "empty" },
  );

  const none = makeAdapter();
  none.adapter.uiContext.addAutocompleteProvider((current) => ({
    getSuggestions: async (lines, cursorLine, cursorCol, options) =>
      current.getSuggestions(lines, cursorLine, cursorCol, options),
    applyCompletion: (lines) => ({ lines, cursorLine: 0, cursorCol: 0 }),
  }));
  assert.deepEqual(
    await none.adapter.suggestCompletions({ lines: ["@x"], cursorLine: 0, cursorCol: 2, signal: completionSignal() }),
    { kind: "none" },
    "链底没有候选 → 客户端回退到自己的文件补全",
  );
});

test("补全：插件抛错 → error、坏形状 → invalid（都让调用方回退本地补全）", async () => {
  const thrown = makeAdapter();
  thrown.adapter.uiContext.addAutocompleteProvider(() => ({
    getSuggestions: async () => {
      throw new Error("boom");
    },
    applyCompletion: (lines) => ({ lines, cursorLine: 0, cursorCol: 0 }),
  }));
  assert.deepEqual(
    await thrown.adapter.suggestCompletions({ lines: ["@x"], cursorLine: 0, cursorCol: 2, signal: completionSignal() }),
    { kind: "error" },
  );

  const malformed = makeAdapter();
  malformed.adapter.uiContext.addAutocompleteProvider(() => ({
    getSuggestions: async () => ({ items: "nope" }),
    applyCompletion: (lines) => ({ lines, cursorLine: 0, cursorCol: 0 }),
  }));
  assert.deepEqual(
    await malformed.adapter.suggestCompletions({ lines: ["@x"], cursorLine: 0, cursorCol: 2, signal: completionSignal() }),
    { kind: "invalid" },
  );
});

test("补全：坏工厂被跳过，不影响整链（一个坏插件不该让补全整体失效）", async () => {
  const { adapter, emitted } = makeAdapter();
  adapter.uiContext.addAutocompleteProvider(() => {
    throw new Error("bad factory");
  });
  adapter.uiContext.addAutocompleteProvider(() => ({
    getSuggestions: async () => ({ items: [{ value: "ok", label: "ok" }], prefix: "@" }),
    applyCompletion: (lines) => ({ lines, cursorLine: 0, cursorCol: 0 }),
  }));
  const outcome = await adapter.suggestCompletions({
    lines: ["@"],
    cursorLine: 0,
    cursorCol: 1,
    signal: completionSignal(),
  });
  assert.equal(outcome.kind, "items");
  assert.deepEqual(outcome.items, [{ value: "ok", label: "ok" }]);
  // 门槛报的是**有效**工厂数：坏掉的那个不算，否则（唯一工厂坏掉时）客户端每次都白付一次
  // 往返，结果永远是链底的 none 再回退本地 —— 不如一开始就说「没有 provider」。
  assert.equal(
    emitted.filter((e) => e.method === "autocompleteProviders").at(-1).count,
    1,
    "坏工厂不计入门槛",
  );
  assert.equal(adapter.autocompleteProviderCount, 1);
});

// ---------------------------------------------------------------------------
// ctx.ui.setHiddenThinkingLabel：折叠态思考块那一行（issue #96）
// ---------------------------------------------------------------------------

test("setHiddenThinkingLabel：真实现，不再报「不支持」，事件带标签", () => {
  const { adapter, emitted } = makeAdapter();
  adapter.uiContext.setHiddenThinkingLabel("检索记忆…");

  const events = emitted.filter((e) => e.method === "setHiddenThinkingLabel");
  assert.equal(events.length, 1);
  assert.equal(events[0].label, "检索记忆…");
  assert.equal(adapter.hiddenThinkingLabel, "检索记忆…", "只读快照要能被宿主投影读到");
  assert.equal(emitted.filter((e) => e.method === "notify").length, 0, "这是真实现，不再是降级");
});

test("setHiddenThinkingLabel：无参与空串都恢复默认（下发 null）", () => {
  const { adapter, emitted } = makeAdapter();
  const last = () => emitted.filter((e) => e.method === "setHiddenThinkingLabel").at(-1);

  adapter.uiContext.setHiddenThinkingLabel("检索记忆…");
  adapter.uiContext.setHiddenThinkingLabel();
  assert.equal(adapter.hiddenThinkingLabel, null);
  assert.equal(last().label, null, "无参 = 恢复默认");

  adapter.uiContext.setHiddenThinkingLabel("再看一次");
  adapter.uiContext.setHiddenThinkingLabel("");
  assert.equal(adapter.hiddenThinkingLabel, null, "空串当恢复默认：空标签只会让折叠行空着");
  assert.equal(last().label, null);
});

test("setHiddenThinkingLabel：同值不重复下发，本来就是默认时不发", () => {
  const { adapter, emitted } = makeAdapter();
  adapter.uiContext.setHiddenThinkingLabel();
  adapter.uiContext.setHiddenThinkingLabel("A");
  adapter.uiContext.setHiddenThinkingLabel("A");

  const events = emitted.filter((e) => e.method === "setHiddenThinkingLabel");
  assert.equal(events.length, 1, "只有一次真实变化");
  assert.equal(events[0].label, "A");
});

// ---------------------------------------------------------------------------
// ctx.ui.onTerminalInput：全局按键监听
// ---------------------------------------------------------------------------

test("onTerminalInput 注册/退订并下发监听器数量", () => {
  const { adapter, emitted } = makeAdapter();
  const counts = () =>
    emitted.filter((e) => e.method === "terminalInputListeners").map((e) => e.count);

  const offFirst = adapter.uiContext.onTerminalInput(() => undefined);
  assert.deepEqual(counts(), [1], "第一次注册要下发（前端据此决定要不要介入键盘）");

  const offSecond = adapter.uiContext.onTerminalInput(() => undefined);
  assert.equal(counts().at(-1), 2);

  offFirst();
  assert.equal(counts().at(-1), 1);
  offFirst();
  assert.equal(counts().at(-1), 1, "重复退订不再下发");

  offSecond();
  assert.equal(counts().at(-1), 0);

  // 只读 getter：宿主的状态投影靠它把门槛值水合给后加载的页面。
  // 没有它，页面在插件注册监听器之后才加载/reload 时门槛恒为 0，按键永不路由。
  assert.equal(adapter.terminalInputListenerCount, 0);
  const offThird = adapter.uiContext.onTerminalInput(() => undefined);
  assert.equal(adapter.terminalInputListenerCount, 1, "getter 必须跟着注册变");
  offThird();
  assert.equal(adapter.terminalInputListenerCount, 0, "getter 必须跟着退订变");
});

test("dispatchTerminalInput 对齐 pi-tui：先 consume 再 data 改写，改写成空则丢弃", () => {
  const { adapter } = makeAdapter();
  const seen = [];
  adapter.uiContext.onTerminalInput((data) => {
    seen.push(data);
    return undefined;
  });
  adapter.uiContext.onTerminalInput((data) =>
    data === "\x1b" ? { consume: true, data: "\x1bX" } : { data: `${data}!` },
  );
  let thirdSaw = null;
  adapter.uiContext.onTerminalInput((data) => {
    thirdSaw = data;
    return { consume: true, data: "never" };
  });

  assert.deepEqual(adapter.dispatchTerminalInput("\x1b"), { consumed: true, data: "\x1b" });
  assert.deepEqual(seen, ["\x1b"], "第一个监听器只见到原始数据（第二个就消费了）");
  assert.equal(thirdSaw, null, "被消费后不再传下去");

  seen.length = 0;
  assert.deepEqual(adapter.dispatchTerminalInput("a"), { consumed: true, data: "a!" });
  assert.deepEqual(seen, ["a"], "改写后的序列由后续监听器看到（thirdSaw）");
  assert.equal(thirdSaw, "a!", "data 改写要传给下一个监听器");

  const { adapter: empty } = makeAdapter();
  empty.uiContext.onTerminalInput(() => ({ data: "" }));
  assert.deepEqual(empty.dispatchTerminalInput("b"), { consumed: true, data: "" }, "改写成空串等价于丢弃");
});

test("dispatchTerminalInput：不消费时返回改写后的序列；监听器抛错不影响其它监听器", () => {
  const { adapter } = makeAdapter();
  adapter.uiContext.onTerminalInput((data) => ({ data: `${data}?` }));
  assert.deepEqual(adapter.dispatchTerminalInput("x"), { consumed: false, data: "x?" });

  const { adapter: throwing } = makeAdapter();
  throwing.uiContext.onTerminalInput(() => {
    throw new Error("boom");
  });
  throwing.uiContext.onTerminalInput(() => ({ consume: true }));
  assert.equal(throwing.dispatchTerminalInput("y").consumed, true);
});

test("dispose 清空按键监听器", () => {
  const { adapter } = makeAdapter();
  adapter.uiContext.onTerminalInput(() => ({ consume: true }));
  adapter.dispose();
  assert.equal(adapter.dispatchTerminalInput("x").consumed, false);
});

// ---------------------------------------------------------------------------
// 渲染尺寸：前端上报可用列数与行数，已挂载的插件界面按新尺寸重排
// ---------------------------------------------------------------------------

test("setRenderSize：同尺寸不重排，非法尺寸忽略", () => {
  const { adapter } = makeAdapter();
  assert.equal(adapter.setRenderSize({ width: 80, rows: 45 }), true, "第一次设置算变化");
  assert.equal(adapter.setRenderSize({ width: 80, rows: 45 }), false);
  assert.equal(adapter.setRenderSize({ width: 80, rows: 46 }), true, "只变行数也算变化");
  assert.equal(adapter.setRenderSize({ width: 81, rows: 46 }), true, "只变列数也算变化");
  assert.equal(adapter.setRenderSize({ width: Number.NaN, rows: 45 }), false);
  assert.equal(adapter.setRenderSize({ width: 0, rows: 45 }), false);
  assert.equal(adapter.setRenderSize({ width: -3, rows: 45 }), false);
  assert.equal(adapter.setRenderSize({ width: 80, rows: Number.NaN }), false);
  assert.equal(adapter.setRenderSize({ width: 80, rows: 0 }), false);
  assert.equal(adapter.setRenderSize({ width: 80, rows: -1 }), false);
});

test("setRenderSize：尺寸变化让 custom 面板与 widget 用新尺寸重渲", async () => {
  const { adapter, emitted } = makeAdapter();
  adapter.setRenderSize({ width: 80, rows: 45 });

  const customFrames = () => emitted.filter((e) => e.method === "custom" && !e.closed);
  let pluginTui = null;
  const pending = adapter.uiContext.custom((tui) => {
    pluginTui = tui;
    return {
      render: (width) => [`panel@${width}`],
      handleInput() {},
    };
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(customFrames().at(-1).lines, ["panel@80"]);
  assert.equal(pluginTui.terminal.columns, 80, "插件读到的尺寸要与 render(width) 的参数一致");
  assert.equal(pluginTui.terminal.rows, 45, "行数也要是前端报的真值，不能是构造时的常量");

  adapter.setRenderSize({ width: 60, rows: 31 });
  assert.deepEqual(customFrames().at(-1).lines, ["panel@60"], "custom 面板要按新宽度重渲");
  assert.equal(pluginTui.terminal.columns, 60, "terminal.columns 是 getter，宽度变化后必须跟上");
  assert.equal(pluginTui.terminal.rows, 31, "terminal.rows 也是 getter，高度变化后必须跟上");

  adapter.uiContext.setWidget("w", () => ({ render: (width) => [`widget@${width}`] }));
  assert.deepEqual(setWidgetFrames(emitted).at(-1).widgetLines, ["widget@60"]);

  adapter.setRenderSize({ width: 50, rows: 31 });
  await tick();
  assert.deepEqual(setWidgetFrames(emitted).at(-1).widgetLines, ["widget@50"], "widget 工厂也要重推一帧");

  adapter.inputCustom(adapter.customSnapshot.id, "\x03");
  await pending;
});

// ---------------------------------------------------------------------------
// 运行提示定制（setWorkingMessage / setWorkingVisible / setWorkingIndicator）
// ---------------------------------------------------------------------------

test("setWorkingMessage / setWorkingVisible / setWorkingIndicator 下发事件", () => {
  const { adapter, emitted } = makeAdapter();
  const last = (method) => emitted.filter((e) => e.method === method).at(-1);

  adapter.uiContext.setWorkingMessage("排队中");
  adapter.uiContext.setWorkingVisible(false);
  adapter.uiContext.setWorkingIndicator({ frames: ["a", "b"], intervalMs: 80 });

  assert.equal(last("setWorkingMessage").message, "排队中");
  assert.equal(last("setWorkingVisible").visible, false);
  assert.deepEqual(last("setWorkingIndicator").frames, ["a", "b"]);
  assert.equal(last("setWorkingIndicator").intervalMs, 80);

  // 无参 = 恢复默认（不能当成降级去发 warning）
  adapter.uiContext.setWorkingMessage();
  adapter.uiContext.setWorkingIndicator();
  assert.equal(last("setWorkingMessage").message, null);
  assert.equal(last("setWorkingIndicator").frames, null);

  // frames: [] 是「隐藏指示器」的有效声明，不是「未提供」
  adapter.uiContext.setWorkingIndicator({ frames: [] });
  assert.deepEqual(last("setWorkingIndicator").frames, []);
  assert.equal(emitted.filter((e) => e.method === "notify").length, 0, "这些能力不再是降级");
});

// ---------------------------------------------------------------------------
// 面板内的鼠标事件（pi-subagents 的 widget 点标题行折叠）
// ---------------------------------------------------------------------------

test("inputCustomMouse 把鼠标事件交给组件；未知 id 返回 false", async () => {
  const { adapter } = makeAdapter();
  const seen = [];
  const pending = adapter.uiContext.custom(() => ({
    render: () => ["row0", "row1"],
    handleInput() {},
    handleMouse(event) {
      seen.push(event);
      return { handled: true };
    },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const id = adapter.customSnapshot.id;

  assert.equal(adapter.inputCustomMouse(id, { type: "click", button: "left", y: 0 }), true);
  assert.deepEqual(seen, [{ type: "click", button: "left", y: 0 }]);
  assert.equal(adapter.inputCustomMouse("not-this-panel", { type: "click" }), false);

  adapter.inputCustom(id, "\x03");
  await pending;
});

test("inputCustomMouse：组件没实现 handleMouse 时不抛", async () => {
  const { adapter } = makeAdapter();
  const pending = adapter.uiContext.custom(() => ({ render: () => ["x"], handleInput() {} }));
  await new Promise((resolve) => setImmediate(resolve));
  const id = adapter.customSnapshot.id;

  assert.doesNotThrow(() => adapter.inputCustomMouse(id, { type: "click" }));

  adapter.inputCustom(id, "\x03");
  await pending;
});

test("custom() 的 onHandle 收到句柄；setHidden 下发、幂等、并跟快照一致", async () => {
  const { adapter, emitted } = makeAdapter();
  let handle = null;
  const pending = adapter.uiContext.custom(
    () => ({ render: () => ["panel"], handleInput() {} }),
    {
      overlay: true,
      overlayOptions: { anchor: "bottom-center" },
      onHandle: (h) => {
        handle = h;
      },
    },
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(handle, "onHandle 必须被调用（rpiv-ask-user 的折叠键靠它）");
  assert.equal(handle.isHidden(), false);
  assert.equal(handle.isFocused(), true);

  const openEvents = () => emitted.filter((e) => e.method === "custom" && !e.closed);
  const before = openEvents().length;
  handle.setHidden(true);

  const latest = openEvents().at(-1);
  assert.equal(latest.hidden, true, "setHidden(true) 必须下发");
  assert.deepEqual(latest.lines, ["panel"], "隐藏事件仍要带完整状态（前端按事件整体替换）");
  assert.equal(adapter.customSnapshot?.hidden, true, "快照要带 hidden，刷新后不得重新弹出");
  assert.equal(handle.isHidden(), true);

  // 幂等：重复设置同一个值不再发事件
  handle.setHidden(true);
  assert.equal(openEvents().length, before + 1);

  handle.setHidden(false);
  assert.equal(handle.isHidden(), false);
  assert.equal(openEvents().at(-1).hidden, undefined);

  adapter.inputCustom(latest.id, "\x03");
  await pending;
});

// ---------------------------------------------------------------------------
// Issue #99：overlay 句柄的 focus / unfocus / getBounds
// ---------------------------------------------------------------------------

/** 开一个 custom overlay 面板，返回句柄、事件与「当前活动的 custom 帧」。 */
async function openOverlay(overlayOptions = undefined) {
  const { adapter, emitted } = makeAdapter();
  let handle = null;
  const pending = adapter.uiContext.custom(
    () => ({ render: () => ["panel"], handleInput() {} }),
    {
      overlay: true,
      ...(overlayOptions === undefined ? {} : { overlayOptions }),
      onHandle: (h) => {
        handle = h;
      },
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const frames = () => emitted.filter((event) => event.method === "custom" && !event.closed);
  return { adapter, emitted, handle, frames, pending };
}

/** 收尾：让 custom 的 promise 结掉，避免测试进程悬挂。 */
async function closeOverlay(adapter, frames, pending) {
  adapter.inputCustom(frames().at(-1).id, "\x03");
  await pending;
}

test("normalizeCustomBounds：只收有限整数、宽高 ≥ 1，其余 null", () => {
  assert.deepEqual(normalizeCustomBounds({ row: 1, col: 2, width: 3, height: 4 }), { row: 1, col: 2, width: 3, height: 4 });
  assert.deepEqual(
    normalizeCustomBounds({ row: 1.4, col: -2.6, width: 3.5, height: 4.5 }),
    { row: 1, col: -3, width: 4, height: 5 },
    "取整（坐标允许为负：面板可以部分在容器外）",
  );
  const bad = [
    null,
    undefined,
    "bounds",
    {},
    { row: 0, col: 0, width: 0, height: 4 },
    { row: 0, col: 0, width: 3, height: 0 },
    { row: 0, col: 0, width: -3, height: 4 },
    { row: Number.NaN, col: 0, width: 3, height: 4 },
    { row: 0, col: Number.POSITIVE_INFINITY, width: 3, height: 4 },
    { row: 0, col: 0, width: "3", height: 4 },
    { row: 0, col: 0, width: 20_000, height: 4 },
    { row: 0, col: 0, width: 3, height: 20_000 },
  ];
  for (const value of bad) {
    assert.equal(normalizeCustomBounds(value), null, `${JSON.stringify(value)} 必须是 null`);
  }
});

// pi-tui 的 OverlayHandle：focus 不可见时 no-op；unfocus 未聚焦时 no-op、
// 缺省落点是「打开 overlay 前的焦点」（Web 上就是输入框）；getBounds 只在可见时给。
test("overlay 焦点：默认面板持有；unfocus 交回编辑器 / {target:null} 谁也不聚焦；未聚焦时 no-op", async () => {
  const { adapter, frames, handle, pending } = await openOverlay();
  assert.equal(handle.isFocused(), true, "可见且非 nonCapturing → 默认聚焦面板（对齐 showOverlay）");
  assert.equal(frames().at(-1).focus, "panel", "帧里要带焦点态");
  assert.equal(adapter.customSnapshot?.focus, "panel", "快照也要带（刷新后状态一致）");

  const before = frames().length;
  handle.unfocus();
  assert.equal(handle.isFocused(), false);
  assert.equal(frames().length, before + 1, "unfocus 要下发一帧");
  assert.equal(frames().at(-1).focus, "editor", "缺省落点是主编辑器");

  handle.unfocus();
  assert.equal(frames().length, before + 1, "已经没聚焦时再 unfocus 是 no-op（不扰动用户的焦点）");

  handle.focus();
  assert.equal(handle.isFocused(), true);
  assert.equal(frames().at(-1).focus, "panel", "focus() 把焦点收回面板");
  const afterFocus = frames().length;
  handle.focus();
  assert.equal(frames().length, afterFocus, "重复 focus 幂等（不刷帧）");

  handle.unfocus({ target: null });
  assert.equal(frames().at(-1).focus, "none", "{ target: null } → 谁也不聚焦");

  handle.focus();
  handle.unfocus({ target: { render: () => [] } });
  assert.equal(
    frames().at(-1).focus,
    "editor",
    "给了具体组件 → Web 无法聚焦任意组件，按「交回编辑器」处理",
  );

  await closeOverlay(adapter, frames, pending);
});

test("overlay 焦点：不可见时 focus() 是 no-op；setHidden 后 isFocused 为 false", async () => {
  const { adapter, frames, handle, pending } = await openOverlay();
  handle.unfocus();
  assert.equal(handle.isFocused(), false);

  handle.setHidden(true);
  assert.equal(handle.isFocused(), false, "隐藏时没有焦点（pi-tui 的 hide 会把焦点移走）");
  const before = frames().length;
  handle.focus();
  assert.equal(frames().length, before, "隐藏时 focus() 什么都不做（不会把面板叫醒）");
  assert.equal(handle.isFocused(), false);

  handle.setHidden(false);
  assert.equal(frames().at(-1).focus, "editor", "重新显示后焦点仍在编辑器（hide 时被移走）");
  handle.focus();
  assert.equal(handle.isFocused(), true, "重新显示后可以再拿回焦点");

  await closeOverlay(adapter, frames, pending);
});

test("overlay getBounds：上报后同步可读且是副本；隐藏 / 未上报 → undefined", async () => {
  const { adapter, frames, handle, pending } = await openOverlay();
  const id = frames().at(-1).id;

  assert.equal(handle.getBounds(), undefined, "还没上报过 → undefined（不编造 0）");

  assert.equal(adapter.setCustomBounds(id, { row: 2, col: 3, width: 40, height: 5 }), true);
  const bounds = handle.getBounds();
  assert.deepEqual(bounds, { row: 2, col: 3, width: 40, height: 5 });
  bounds.row = 999;
  assert.deepEqual(
    handle.getBounds(),
    { row: 2, col: 3, width: 40, height: 5 },
    "返回副本：插件改写它不能污染内部状态",
  );

  assert.equal(
    adapter.setCustomBounds(id, { row: 2, col: 3, width: 40, height: 5 }),
    false,
    "同值重报返回 false（不必要地刷状态）",
  );

  handle.setHidden(true);
  assert.equal(handle.getBounds(), undefined, "隐藏时没有 bounds（pi-tui：只给可见 overlay）");
  handle.setHidden(false);
  assert.deepEqual(handle.getBounds(), { row: 2, col: 3, width: 40, height: 5 }, "重新显示后恢复");

  handle.hide();
  assert.equal(handle.getBounds(), undefined, "永久移除后不再有 bounds");
  assert.equal(adapter.setCustomBounds(id, { row: 1, col: 1, width: 1, height: 1 }), false, "移除后不再收");
  // 不 await pending：hide() 按 pi-tui 契约只摘掉 overlay，**不** settle 插件的 await
  // （这里 await 会永远挂着）。返回的 promise 无人等待不影响测试进程退出。
  void pending;
});

test("setCustomBounds：非法报文不改已有值；未知 id 返回 false", async () => {
  const { adapter, frames, handle, pending } = await openOverlay();
  const id = frames().at(-1).id;
  assert.equal(adapter.setCustomBounds(id, { row: 1, col: 1, width: 10, height: 2 }), true);

  assert.equal(adapter.setCustomBounds(id, { row: 9, col: 9 }), false, "缺字段 → 不接受");
  assert.equal(adapter.setCustomBounds(id, "junk"), false);
  assert.deepEqual(handle.getBounds(), { row: 1, col: 1, width: 10, height: 2 }, "坏报文不得清掉已有值");

  assert.equal(adapter.setCustomBounds("no-such-id", { row: 0, col: 0, width: 1, height: 1 }), false);
  await closeOverlay(adapter, frames, pending);
});

// pi-tui 的 showOverlay：nonCapturing 的 overlay 不抢焦点（焦点留在输入框）。
test("nonCapturing overlay：初始不抢焦点，显式 focus() 才归面板", async () => {
  const { adapter, frames, handle, pending } = await openOverlay({ nonCapturing: true });
  assert.equal(frames().at(-1).focus, "editor", "不抢焦点：初始态是编辑器");
  assert.equal(handle.isFocused(), false);

  handle.focus();
  assert.equal(handle.isFocused(), true);
  assert.equal(frames().at(-1).focus, "panel");
  await closeOverlay(adapter, frames, pending);
});

// issue #76：pi-tui 的 OverlayHandle.hide() 是**永久移除**（splice 出 overlay 栈），
// 不是「临时隐藏」；之前把它等同于 setHidden(true)，插件再 setHidden(false) 就能把
// TUI 里永不复活的面板叫回来。
test("overlay hide() 是永久移除：closed 下发、快照清空、setHidden(false) 不复活", async () => {
  const { adapter, emitted } = makeAdapter();
  let handle = null;
  const pending = adapter.uiContext.custom(
    () => ({ render: () => ["panel"], handleInput() {} }),
    {
      overlay: true,
      onHandle: (h) => {
        handle = h;
      },
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(handle);
  const id = emitted.find((e) => e.method === "custom" && !e.closed).id;
  assert.equal(adapter.customSnapshot?.id, id, "打开时有快照（刷新可恢复）");

  handle.hide();

  const closed = emitted.filter((e) => e.method === "custom" && e.closed === true).at(-1);
  assert.ok(closed, "hide() 必须让前端拆除面板（closed 事件）");
  assert.equal(closed.id, id);
  assert.equal(adapter.customSnapshot, null, "移除后不得再被快照恢复出来");
  assert.equal(handle.isFocused(), false, "移除后没有焦点");
  assert.equal(adapter.inputCustom(id, "x"), false, "移除后不再接收输入");

  // 再 setHidden(false)：TUI 里 overlay 已 splice 掉，永远回不来
  const before = emitted.filter((e) => e.method === "custom" && !e.closed).length;
  handle.setHidden(false);
  assert.equal(emitted.filter((e) => e.method === "custom" && !e.closed).length, before, "不得复活");
  assert.equal(adapter.customSnapshot, null);

  // 幂等：重复 hide() 不再发事件
  const closedCount = emitted.filter((e) => e.method === "custom" && e.closed).length;
  handle.hide();
  assert.equal(emitted.filter((e) => e.method === "custom" && e.closed).length, closedCount);
  void pending;
});

test("overlay hide() 之后插件的重渲染不会再画回面板", async () => {
  const { adapter, emitted } = makeAdapter();
  let handle = null;
  let renders = 0;
  void adapter.uiContext.custom(
    () => ({ render: () => { renders += 1; return [`frame ${renders}`]; }, handleInput() {}, invalidate() {} }),
    { overlay: true, onHandle: (h) => { handle = h; } },
  );
  await new Promise((resolve) => setImmediate(resolve));
  handle.hide();
  const after = emitted.filter((e) => e.method === "custom" && !e.closed).length;
  // 真实插件在 invalidate 里就是让宿主重渲（这里用视口变化触发同一路径）
  adapter.setRenderSize({ width: 100, rows: 30 });
  assert.equal(emitted.filter((e) => e.method === "custom" && !e.closed).length, after, "移除后不得再下发面板事件");
});

test("tui.stop() 报一次可见失败（Web 没有可让出的终端，issue #76）", async () => {
  const { adapter, emitted } = makeAdapter();
  let tui = null;
  void adapter.uiContext.custom(
    (t) => {
      tui = t;
      return { render: () => ["panel"], handleInput() {} };
    },
    { overlay: true },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(tui, "工厂拿到的 tui 要能拿到");
  tui.stop();
  tui.stop();
  const warning = emitted.filter((e) => e.method === "notify").at(-1);
  assert.ok(warning, "stop() 必须发可见提示");
  assert.match(String(warning.message), /external editor handover/);
  assert.match(String(warning.message), /not supported by the Pidance web client/);
});

// ---------------------------------------------------------------------------
// custom() 注入的 keybindings 与 tui 占位成员
//
// 曾踩坑：第 3 参传空对象，插件第一次调 keybindings.matches() 就 TypeError，
// 被 custom() 的 catch 吞掉 —— 面板对键盘毫无响应且无任何错误提示。
// ---------------------------------------------------------------------------

test("custom() 回调注入可用 keybindings 与 stop/start 占位", async () => {
  const { adapter, emitted } = makeAdapter();
  let captured = null;
  const opened = adapter.uiContext.custom((tui, theme, keybindings) => {
    captured = { tui, theme, keybindings };
    return { render: () => ["x"], handleInput() {} };
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(typeof captured.keybindings.matches, "function", "不得再传空对象");
  assert.equal(captured.keybindings.matches("\x1b[A", "tui.select.up"), true);
  assert.equal(captured.keybindings.matches("\x1b[B", "tui.select.down"), true);
  assert.equal(captured.keybindings.matches("\r", "tui.select.confirm"), true);
  // pi 的应用级键位不在 TUI_KEYBINDINGS；未知键名必须安全返回 false（不抛）
  assert.equal(captured.keybindings.matches("\x07", "app.editor.external"), false);

  // 插件的外部编辑器路径会调 stop/start，缺失即 TypeError
  assert.doesNotThrow(() => {
    captured.tui.stop();
    captured.tui.start();
  });

  const id = emitted.find((event) => event.method === "custom" && !event.closed).id;
  adapter.inputCustom(id, "\x03");
  await opened;
});

// ---------------------------------------------------------------------------
// custom() 的 overlay 选项：面板按插件给的尺寸/锚点渲染
//
// 真实插件都通过第二参声明 overlay（pi-subagents fleet 95%x85% 居中、stop 选择器 88 列、
// rpiv-ask-user 全宽贴底）。旧实现只收 factory，第二参直接丢掉 → 一律全屏模态遮罩。
// ---------------------------------------------------------------------------

function mountLayoutProbe(adapter, emitted, options) {
  const pending = adapter.uiContext.custom(
    () => ({ render: () => ["panel"], handleInput() {} }),
    options,
  );
  return { pending, event: () => emitted.find((e) => e.method === "custom" && !e.closed) };
}

async function closePanel(adapter, probe) {
  await new Promise((resolve) => setImmediate(resolve));
  adapter.inputCustom(probe.event().id, "\x03");
  await probe.pending;
}

test("custom() overlayOptions → 事件与快照都带 layout", async () => {
  const { adapter, emitted } = makeAdapter();
  const probe = mountLayoutProbe(adapter, emitted, {
    overlay: true,
    overlayOptions: { anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%", margin: 1 },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(probe.event().layout, {
    anchor: "center",
    width: "95%",
    minWidth: 60,
    maxHeight: "85%",
    margin: 1,
  });
  assert.deepEqual(
    adapter.customSnapshot?.layout,
    probe.event().layout,
    "快照必须带同一份 layout（刷新后才能恢复浮层）",
  );

  adapter.inputCustom(probe.event().id, "\x03");
  await probe.pending;
});

test("custom() 非 overlay 不下发 layout（保持全屏模态）", async () => {
  const { adapter, emitted } = makeAdapter();
  const probe = mountLayoutProbe(adapter, emitted, { overlay: false });
  await closePanel(adapter, probe);
  assert.equal(probe.event().layout, undefined);
});

test("custom() overlayOptions 为函数形式：不静默求值，只给默认锚点", async () => {
  const { adapter, emitted } = makeAdapter();
  let evaluated = 0;
  const probe = mountLayoutProbe(adapter, emitted, {
    overlay: true,
    overlayOptions: () => {
      evaluated += 1;
      return { width: 10 };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(evaluated, 0, "不得调用函数形式（求值时机与 pi-tui 每帧重算不同）");
  assert.deepEqual(probe.event().layout, { anchor: "center" });

  adapter.inputCustom(probe.event().id, "\x03");
  await probe.pending;
});

test("custom() margin 对象只保留出现的边", async () => {
  const { adapter, emitted } = makeAdapter();
  const probe = mountLayoutProbe(adapter, emitted, {
    overlay: true,
    overlayOptions: { anchor: "bottom-center", width: "100%", margin: { left: 0, right: 0, bottom: 0 } },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(probe.event().layout, {
    anchor: "bottom-center",
    width: "100%",
    margin: { left: 0, right: 0, bottom: 0 },
  });

  adapter.inputCustom(probe.event().id, "\x03");
  await probe.pending;
});

// ---------------------------------------------------------------------------
// 主编辑器焦点 → tui.focusedComponent（插件据此判断「编辑器有没有焦点」）
// ---------------------------------------------------------------------------
test("setWidget 工厂：focusedComponent 只在客户端上报聚焦时给鸭子类型探针", () => {
  const { adapter } = makeAdapter();
  const widget = mountCounterWidget(adapter);
  // 鸭子类型：插件按这五个成员判断，缺一个就当「没有编辑器」
  const looksLikeEditor = (value) =>
    Boolean(value)
    && typeof value === "object"
    && ["render", "invalidate", "handleInput", "getText", "setText"].every((m) => typeof value[m] === "function");

  assert.equal(widget.tui.focusedComponent, undefined, "未上报聚焦时必须保持注入前的行为");
  assert.equal(looksLikeEditor(widget.tui.focusedComponent), false);

  assert.equal(adapter.setEditorFocus(true), true, "状态变化要返回 true");
  assert.equal(looksLikeEditor(widget.tui.focusedComponent), true, "聚焦后必须是完整鸭子类型");

  assert.equal(adapter.setEditorFocus(true), false, "重复上报同一状态不算变化");
  assert.equal(adapter.setEditorFocus(false), true);
  assert.equal(widget.tui.focusedComponent, undefined, "失焦后必须回到 undefined");
});

test("setEditorFocus：焦点变化会让常驻 widget 工厂重渲一帧", async () => {
  const { adapter, emitted } = makeAdapter();
  const widget = mountCounterWidget(adapter);
  const before = widget.frame;

  adapter.setEditorFocus(true);
  await tick();
  assert.ok(widget.frame > before, "焦点变化要刷新一帧（插件可能按焦点换形态）");
});

test("多标签焦点聚合：后台标签失焦/C清不掉前台标签的焦点", () => {
  const { adapter } = makeAdapter();
  const widget = mountCounterWidget(adapter);
  const looksLikeEditor = (value) => Boolean(value) && typeof value === "object";

  assert.equal(adapter.setEditorFocus(true, "tabA"), true, "A 聚焦要有变化");
  assert.equal(looksLikeEditor(widget.tui.focusedComponent), true);
  assert.equal(adapter.setEditorFocus(true, "tabB"), false, "B 也聚焦不改变聚合结果");
  // 后台标签 B 失焦（blur/隐藏）不能把前台 A 的焦点一起清掉：旧实现是单槽 last-write。
  assert.equal(adapter.setEditorFocus(false, "tabB"), false, "B 失焦不该算变化");
  assert.equal(looksLikeEditor(widget.tui.focusedComponent), true, "A 仍在前台聚焦，探针必须还在");
  assert.equal(adapter.setEditorFocus(false, "tabA"), true, "两个标签都失焦才算变化");
  assert.equal(widget.tui.focusedComponent, undefined);
});

test("焦点 TTL：没有心跳时焦点自己过期（标签被直接关掉）", () => {
  const { adapter } = makeAdapter();
  const widget = mountCounterWidget(adapter);
  const realNow = Date.now;
  let now = realNow();
  try {
    Date.now = () => now;
    adapter.setEditorFocus(true, "tabA");
    assert.equal(typeof widget.tui.focusedComponent, "object", "刚上报时必须聚焦");
    now += 61_000;
    assert.equal(widget.tui.focusedComponent, undefined, "TTL 过期后必须回到 undefined，否则插件永远以为有焦点");
  } finally {
    Date.now = realNow;
  }
});

test("dispose：焦点状态清空，常驻 widget 读到的又是 undefined", () => {
  const { adapter } = makeAdapter();
  const widget = mountCounterWidget(adapter);
  adapter.setEditorFocus(true);
  assert.equal(typeof widget.tui.focusedComponent, "object");

  adapter.dispose();
  assert.equal(widget.tui.focusedComponent, undefined, "dispose 后不得保留旧的聚焦态");
});

// ---------------------------------------------------------------------------
// 端到端（服务端侧）：按插件真实形状走一遍「焦点 → 激活键 → 选择态」
//
// 模拟 pi-subagents 的 fleet widget：用鸭子类型判断编辑器焦点、用
// onTerminalInput 监听按键、按键被消费后渲染成 roster。这条链的每一环都是
// 通用机制（不针对某个插件），因此可以自动验证。
// ---------------------------------------------------------------------------
test("插件形状端到端：焦点 + 消费激活键 → 进入选择态；失焦后按键不生效", async () => {
  const { adapter, emitted } = makeAdapter();
  const looksLikeEditor = (value) =>
    Boolean(value)
    && typeof value === "object"
    && ["render", "invalidate", "handleInput", "getText", "setText"].every((m) => typeof value[m] === "function");
  const editorText = "";
  let active = false;
  let tui = null;

  adapter.uiContext.onTerminalInput((data) => {
    if (!looksLikeEditor(tui?.focusedComponent)) {
      const wasActive = active;
      active = false;
      if (wasActive) tui?.requestRender();
      return undefined;
    }
    if (!active) {
      // 插件只在「编辑器为空」时允许激活；激活键是 ↓ / ←
      if (editorText !== "") return undefined;
      if (data !== "\x1b[B" && data !== "\x1b[D") return undefined;
      active = true;
      tui.requestRender();
      return { consume: true };
    }
    if (data === "\x1b[B" || data === "\x1b[D" || data === "j" || data === "k") return { consume: true };
    if (data === "\x1b") {
      active = false;
      tui.requestRender();
      return { consume: true };
    }
    active = false;
    tui.requestRender();
    return undefined;
  });

  adapter.uiContext.setWidget("fleet", (pluginTui) => {
    tui = pluginTui;
    return { render: () => [active ? "roster" : "summary"] };
  });

  const lines = () => adapter.widgets.get("fleet")?.lines;
  assert.deepEqual(lines(), ["summary"], "初始是摘要形态");
  assert.equal(adapter.setEditorFocus(true), true);

  // 未激活：激活键被消费 → 进选择态
  assert.deepEqual(adapter.dispatchTerminalInput("\x1b[B"), { consumed: true, data: "\x1b[B" });
  await tick();
  assert.deepEqual(lines(), ["roster"], "消费激活键后应进入选择态");

  // 选择态内：导航键继续被消费
  assert.equal(adapter.dispatchTerminalInput("j").consumed, true);
  assert.equal(adapter.dispatchTerminalInput("\x1b").consumed, true);
  await tick();
  assert.deepEqual(lines(), ["summary"], "Esc 退出选择态");

  // 失焦后插件自己 deactivate，激活键不再被消费（与 pi-tui 一致）
  adapter.setEditorFocus(false);
  assert.equal(adapter.dispatchTerminalInput("\x1b[B").consumed, false, "无焦点时不得激活");
  await tick();
  assert.deepEqual(lines(), ["summary"]);
});

// ---------------------------------------------------------------------------
// 输入框文本回传 / 自定义编辑器工厂 / onTerminalInput 覆盖范围（issue #74）
// ---------------------------------------------------------------------------

test("getEditorText 回传注入的输入框文本；未注入或读取失败是空串", () => {
  assert.equal(makeAdapter().adapter.uiContext.getEditorText(), "", "未注入：与注入前一致");

  const { adapter } = makeAdapter({ readComposerText: () => "帮我改这个函数" });
  assert.equal(adapter.uiContext.getEditorText(), "帮我改这个函数");

  let calls = 0;
  const { adapter: live } = makeAdapter({
    readComposerText: () => {
      calls += 1;
      return calls === 1 ? "第一次" : "第二次";
    },
  });
  assert.equal(live.uiContext.getEditorText(), "第一次");
  assert.equal(live.uiContext.getEditorText(), "第二次", "每次调用都取当前值（不缓存，避免回传过期文本）");

  const { adapter: throwing } = makeAdapter({
    readComposerText: () => {
      throw new Error("boom");
    },
  });
  assert.equal(throwing.uiContext.getEditorText(), "", "读取失败不能让插件调用抛错");
});

test("getEditorComponent 回传最近一次 set 的工厂，undefined 恢复默认", () => {
  const { adapter, emitted } = makeAdapter();
  assert.equal(adapter.uiContext.getEditorComponent(), undefined, "默认编辑器就是 undefined（SDK 契约）");

  const factory = () => ({ render: () => ["x"] });
  adapter.uiContext.setEditorComponent(factory);
  assert.equal(adapter.uiContext.getEditorComponent(), factory, "包裹上一个编辑器前必须先拿得到它");
  // issue #107 起不再是「只存不用」：设了工厂就真的接管输入区，并且**不再**有能力提示。
  assert.equal(emitted.filter((e) => e.method === "notify").length, 0, "已实现的能力不该再提示");
  assert.equal(emitted.filter((e) => e.method === "editorComponent").length, 1, "设工厂即接管");

  // 插件常见的包裹写法：拿旧的包一层再设回去
  const wrapped = () => factory();
  adapter.uiContext.setEditorComponent(wrapped);
  assert.equal(adapter.uiContext.getEditorComponent(), wrapped, "后设的胜出");

  adapter.uiContext.setEditorComponent(undefined);
  assert.equal(adapter.uiContext.getEditorComponent(), undefined, "undefined = 恢复默认");
  assert.equal(emitted.filter((e) => e.method === "notify").length, 0, "恢复默认不提示降级");
  assert.equal(
    emitted.filter((e) => e.method === "editorComponent").at(-1)?.closed,
    true,
    "卸下工厂要通知客户端恢复自己的输入框",
  );
});

test("onTerminalInput 注册时告知覆盖范围，且只提示一次", () => {
  const { adapter, emitted } = makeAdapter();
  const offFirst = adapter.uiContext.onTerminalInput(() => undefined);
  const offSecond = adapter.uiContext.onTerminalInput(() => undefined);

  const notices = emitted.filter((e) => e.method === "notify" && e.notifyType === "warning");
  assert.equal(notices.length, 1, "插件会反复注册，不能每次刷屏");
  assert.match(notices[0].message, /onTerminalInput/);
  assert.match(notices[0].message, /limited/, "不能写成「不支持」——按键确实会送达，只是覆盖面窄");
  assert.match(notices[0].message, /composer/, "必须说清生效条件");
  // 文案必须与 lib/extension-panel-keys.ts 的实际窗口一致（审查 P1：旧文案写成了
  // 「选择态之前送全部导航键」「Ctrl+Alt+key」，两条都不是代码的行为）。
  assert.match(notices[0].message, /Down\/Left/, "选择态之前只有 ↓/← 能开局");
  assert.doesNotMatch(
    notices[0].message,
    /Ctrl\+Alt/,
    "Alt 与 Ctrl 是两个独立窗口，不是必须组合",
  );
  assert.match(notices[0].message, /F1-F12/, "收起面板那条窗口必须写明");
  assert.match(notices[0].message, /Alt\+<char>/, "Alt+单字符");
  assert.match(notices[0].message, /Ctrl\+<char>/, "Ctrl+非保留单字符");
  // 窗口 ③（issue #102）：插件界面显示中时的覆盖范围也要写明，否则插件无从判断
  // 「用户没按」和「Web 端收不到」。
  assert.match(notices[0].message, /panel, overlay or dialog is visible/, "插件界面显示中那条窗口必须写明");
  assert.match(notices[0].message, /Tab stay with the browser/, "Tab 留给浏览器（无障碍）也要写明");
  assert.match(notices[0].message, /Ordinary typing in the composer never/, "普通打字到不了，必须说清");

  offFirst();
  offSecond();
});

test("宿主把会话草稿读取器接进适配器：少了这行 getEditorText 恒空", () => {
  const src = readFileSync(new URL("./sdk-session-host.ts", import.meta.url), "utf8");
  assert.match(src, /import \{ readComposerDraftText \} from "\.\/composer-draft-text"/);
  assert.match(
    src,
    /readComposerText:\s*\(\)\s*=>\s*readComposerDraftText\(this\.realSessionId, this\.agentDir\)/,
    "必须读**当前**会话（rebind 换 id 后不能还用旧的），且与同文件其它读 prefs 的地方一样带上 agentDir",
  );
});

// ---------------------------------------------------------------------------
// Issue #100：阻塞请求的绝对过期时刻（timeout = 取消）
//
// 宿主早就按 SDK 语义结算超时（select/input → undefined，confirm → false），
// 但线上只发了**相对毫秒**而客户端从不读那个字段，于是组件里的「已过期」分支
// 是死代码：到点后按钮最长会继续可点一个轮询周期（宿主其实已经按取消结算了）。
// 现在随请求下发**绝对时刻** expiresAt，且与结算定时器同一个来源。
// ---------------------------------------------------------------------------

/** 超时要短到测试不用等，长到不会被别的调度挤掉。 */
const DIALOG_TIMEOUT_MS = 40;

function requestEvent(emitted, method) {
  return [...emitted].reverse().find((event) => event.method === method);
}

function pendingId(adapter) {
  return adapter.pendingSnapshot.keys().next().value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("#100 select 超时按取消结算，事件带与定时器同源的绝对过期时刻", async () => {
  const { adapter, emitted } = makeAdapter();
  const promise = adapter.uiContext.select("选一个", ["一", "二"], { timeout: DIALOG_TIMEOUT_MS });
  // 事件是同步发出的：此刻就能核对绝对时刻的形状
  const event = requestEvent(emitted, "select");
  assert.equal(typeof event.expiresAt, "number", "必须下发绝对过期时刻");
  assert.ok(
    Math.abs(event.expiresAt - (Date.now() + DIALOG_TIMEOUT_MS)) <= 20,
    "expiresAt 必须等于创建时刻 + timeout",
  );
  assert.equal("timeout" in event, false, "只发绝对时刻，不再发客户端从不读的相对毫秒");
  assert.equal(await promise, undefined, "select 超时 = 取消（undefined）");
  assert.equal(adapter.pending.size, 0, "结算后不能留下悬挂的 pending 项");
  assert.equal(adapter.pendingSnapshot.size, 0, "快照也要清掉，否则客户端会一直显示对话框");
});

test("#100 confirm 超时按取消结算（false）", async () => {
  const { adapter, emitted } = makeAdapter();
  const promise = adapter.uiContext.confirm("标题", "确认？", { timeout: DIALOG_TIMEOUT_MS });
  const event = requestEvent(emitted, "confirm");
  assert.equal(typeof event.expiresAt, "number");
  assert.equal("timeout" in event, false);
  assert.equal(await promise, false, "confirm 超时 = 取消（false）");
  assert.equal(adapter.pending.size, 0);
});

test("#100 input 超时按取消结算（undefined）", async () => {
  const { adapter, emitted } = makeAdapter();
  const promise = adapter.uiContext.input("标题", "占位", { timeout: DIALOG_TIMEOUT_MS });
  const event = requestEvent(emitted, "input");
  assert.equal(typeof event.expiresAt, "number");
  assert.equal("timeout" in event, false);
  assert.equal(await promise, undefined, "input 超时 = 取消（undefined）");
  assert.equal(adapter.pending.size, 0);
});

test("#100 editor 没有 timeout：不发 expiresAt，也不会自己结算", async () => {
  const { adapter, emitted } = makeAdapter();
  const promise = adapter.uiContext.editor("标题", "预填");
  const event = requestEvent(emitted, "editor");
  assert.equal("expiresAt" in event, false, "editor 的 opts 里没有 timeout（SDK 契约）");
  let settled = false;
  void promise.then(() => { settled = true; });
  await sleep(DIALOG_TIMEOUT_MS * 2);
  assert.equal(settled, false, "没有 timeout 就不该自己结算");
  assert.equal(adapter.respond(pendingId(adapter), { value: "手写内容" }), true);
  assert.equal(await promise, "手写内容");
});

test("#100 没给 timeout：不发 expiresAt，也不会自己结算", async () => {
  const { adapter, emitted } = makeAdapter();
  const promise = adapter.uiContext.select("标题", ["一"]);
  const event = requestEvent(emitted, "select");
  assert.equal("expiresAt" in event, false, "未传 timeout 就不该下发过期时刻");
  let settled = false;
  void promise.then(() => { settled = true; });
  await sleep(DIALOG_TIMEOUT_MS * 2);
  assert.equal(settled, false, "没有 timeout 就不该自己结算");
  assert.equal(adapter.pending.size, 1, "应仍在等用户回答");
  assert.equal(adapter.respond(pendingId(adapter), { value: "一" }), true);
  assert.equal(await promise, "一");
});

test("#100 只结算一次：先给出的答案不被超时覆盖", async () => {
  const { adapter } = makeAdapter();
  const promise = adapter.uiContext.confirm("标题", "确认？", { timeout: DIALOG_TIMEOUT_MS });
  const id = pendingId(adapter);
  assert.equal(adapter.respond(id, { confirmed: true }), true);
  await sleep(DIALOG_TIMEOUT_MS * 2);
  assert.equal(await promise, true, "已 settle 后超时定时器不能再改结果");
  assert.equal(adapter.respond(id, { confirmed: false }), false, "过期/已结算 id 的响应被忽略");
  assert.equal(adapter.pending.size, 0);
});

test("#100 超时之后再点：迟到响应被忽略（respond 返回 false）", async () => {
  const { adapter } = makeAdapter();
  const promise = adapter.uiContext.input("标题", "占位", { timeout: DIALOG_TIMEOUT_MS });
  const id = pendingId(adapter);
  assert.equal(await promise, undefined);
  assert.equal(adapter.respond(id, { value: "迟到" }), false, "已过期 id 不能再结算");
});

// ---------------------------------------------------------------------------
// Issue #100 审查修复：结算必须**立刻推给浏览器**，超时值必须收口
//
// 面板的消失只能由服务端驱动。原来超时只 setTimeout 本地结算、不发事件，
// pendingSnapshot 的消失要等下一次状态投影（运行中 15s、空闲最长 120s）——
// 倒计时走到 0 面板还挂着，而插件早已按取消继续了。
// ---------------------------------------------------------------------------

function settledEvents(emitted) {
  return emitted.filter((event) => event.type === "extension_ui_settled");
}

test("#100 超时结算立刻推 extension_ui_settled，浏览器据此收起面板", async () => {
  const { adapter, emitted } = makeAdapter();
  const promise = adapter.uiContext.select("选一个", ["一", "二"], { timeout: DIALOG_TIMEOUT_MS });
  const id = pendingId(adapter);
  assert.equal(settledEvents(emitted).length, 0, "结算前不该有结束事件");
  assert.equal(await promise, undefined);
  const settled = settledEvents(emitted);
  assert.equal(settled.length, 1, "结算必须发一条结束事件（否则面板要等下一次投影）");
  assert.equal(settled[0].id, id, "事件必须带的就是这个请求 id");
  assert.equal(settled[0].reason, "timeout");
});

test("#100 浏览器回的响应也推结束事件（多标签：别的标签的面板也要立刻收起）", async () => {
  const { adapter, emitted } = makeAdapter();
  const promise = adapter.uiContext.confirm("标题", "确认？", { timeout: DIALOG_TIMEOUT_MS });
  const id = pendingId(adapter);
  assert.equal(adapter.respond(id, { confirmed: true }), true);
  const settled = settledEvents(emitted);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].id, id);
  assert.equal(settled[0].reason, "responded");
  assert.equal(await promise, true);
});

test("#100 abort 结算推结束事件（reason=abort）", async () => {
  const { adapter, emitted } = makeAdapter();
  const controller = new AbortController();
  const promise = adapter.uiContext.select("标题", ["一"], { signal: controller.signal });
  const id = pendingId(adapter);
  controller.abort();
  assert.equal(await promise, undefined);
  const settled = settledEvents(emitted);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].id, id);
  assert.equal(settled[0].reason, "abort");
});

test("#100 dispose 结算推结束事件（reason=disposed）", async () => {
  const { adapter, emitted } = makeAdapter();
  const promise = adapter.uiContext.input("标题", "占位");
  const id = pendingId(adapter);
  adapter.dispose();
  await assert.rejects(promise);
  const settled = settledEvents(emitted);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].id, id);
  assert.equal(settled[0].reason, "disposed");
});

test("#100 normalizeDialogTimeout：非有限/非正数不设超时，超长截到 32 位上界", () => {
  assert.equal(normalizeDialogTimeout(undefined), null);
  assert.equal(normalizeDialogTimeout(0), null, "0 不设超时（TUI 同样是 timeout > 0 才计时）");
  assert.equal(normalizeDialogTimeout(-1), null, "负数是 truthy，透传会 arm 一个立刻触发的定时器");
  assert.equal(normalizeDialogTimeout(Number.NaN), null);
  assert.equal(normalizeDialogTimeout(Number.POSITIVE_INFINITY), null);
  assert.equal(normalizeDialogTimeout("500"), null, "字符串不是 timeout");
  assert.equal(normalizeDialogTimeout(1_500), 1_500);
  assert.equal(normalizeDialogTimeout(2_147_483_647), 2_147_483_647);
  assert.equal(
    normalizeDialogTimeout(Number.MAX_SAFE_INTEGER),
    MAX_DIALOG_TIMEOUT_MS,
    "更大的延迟 Node 会收成 1ms 立刻触发，而 expiresAt 仍很远 —— 必须收口到上界",
  );
});

test("#100 超长 timeout：expiresAt 与定时器用同一个收口后的值", async () => {
  const { adapter, emitted } = makeAdapter();
  const before = Date.now();
  const promise = adapter.uiContext.select("标题", ["一"], { timeout: Number.MAX_SAFE_INTEGER });
  const event = requestEvent(emitted, "select");
  const drift = event.expiresAt - before;
  assert.ok(
    Math.abs(drift - MAX_DIALOG_TIMEOUT_MS) <= 50,
    "expiresAt 必须按收口后的上界算，不能透传原始的巨大值（实测 " + drift + "）",
  );
  assert.equal(settledEvents(emitted).length, 0, "不能因为延迟过大而立刻结算");
  assert.equal(adapter.respond(pendingId(adapter), { value: "一" }), true);
  assert.equal(await promise, "一");
});

test("#100 负数 timeout：不设超时、不发 expiresAt、不结算", async () => {
  const { adapter, emitted } = makeAdapter();
  const promise = adapter.uiContext.confirm("标题", "确认？", { timeout: -5 });
  const event = requestEvent(emitted, "confirm");
  assert.equal("expiresAt" in event, false, "负数 timeout 等于没给");
  await sleep(DIALOG_TIMEOUT_MS);
  assert.equal(adapter.pending.size, 1, "不能因为负数而立刻结算");
  assert.equal(adapter.respond(pendingId(adapter), { confirmed: true }), true);
  assert.equal(await promise, true);
});

test("主题：getAllThemes 列内置清单、getTheme 只加载不切换（不再报「不支持」）", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pidance-theme-ui-"));
  try {
    const { adapter, emitted } = makeAdapter({ agentDir });
    const ui = adapter.uiContext;

    const themes = ui.getAllThemes();
    assert.deepEqual(themes.map((t) => t.name).sort(), ["dark", "light"]);
    assert.equal(ui.theme.name, "dark", "默认主题是 dark");

    const light = ui.getTheme("light");
    assert.ok(light, "getTheme 应能按名加载");
    assert.equal(light.name, "light");
    assert.equal(ui.theme.name, "dark", "getTheme 不得切换当前主题");
    assert.equal(ui.getTheme("nope"), undefined, "未知名返回 undefined");
    assert.equal(
      emitted.some((e) => String(e.message ?? "").includes("not supported")),
      false,
      "主题三件套已经是真实现，不能再报「不支持」",
    );
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("主题：setTheme 切内置主题会下发壳明暗命令并落偏好；未知名不动主题且提示一次", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pidance-theme-ui-"));
  try {
    const { adapter, emitted } = makeAdapter({ agentDir });
    const ui = adapter.uiContext;
    // 偏好广播是**跨客户端**的：正在看别的会话的标签/别的设备靠它跟上这个进程级外观。
    const broadcast = [];
    const unsubscribeBroadcast = getPidancePrefsBus().subscribe((change) => broadcast.push(change.changed));
    try {
      assert.deepEqual(ui.setTheme("light"), { success: true });
    assert.equal(ui.theme.name, "light");
    const command = emitted.find((e) => e.method === "setTheme");
    assert.equal(command?.mode, "light", "必须下发壳的明暗（皮肤不变）");
    const prefs = JSON.parse(readFileSync(join(agentDir, "pidance-preferences.json"), "utf8"));
    assert.equal(prefs.theme.mode, "light", "刷新后壳仍是这个明暗：偏好也要落盘");

      assert.ok(
        broadcast.some((changed) => changed["theme.mode"] === "light"),
        "写入偏好后必须广播（否则别的标签的壳不会跟着变）",
      );
    } finally {
      unsubscribeBroadcast();
    }

    emitted.length = 0;
    const failed = ui.setTheme("does-not-exist");
    assert.equal(failed.success, false);
    assert.match(String(failed.error), /does-not-exist/);
    assert.equal(ui.theme.name, "light", "失败不得换掉当前主题");
    const warnings = emitted.filter((e) => e.method === "notify");
    assert.equal(warnings.length, 1, "失败要可见，但同一条错误只提示一次");
    assert.match(String(warnings[0].message), /does-not-exist/);

    emitted.length = 0;
    ui.setTheme("does-not-exist");
    assert.equal(emitted.filter((e) => e.method === "notify").length, 0, "同一条错误不重复提示");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("主题：切用户主题（非内置）不冒充壳明暗", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pidance-theme-ui-"));
  try {
    const themesDir = join(agentDir, "themes");
    mkdirSync(themesDir, { recursive: true });
    const full = JSON.parse(readFileSync(new URL("./pi-themes/dark.json", import.meta.url), "utf8"));
    writeFileSync(join(themesDir, "mine.json"), JSON.stringify({ ...full, name: "mine" }), "utf8");

    const { adapter, emitted } = makeAdapter({ agentDir });
    const ui = adapter.uiContext;
    assert.ok(ui.getAllThemes().some((t) => t.name === "mine"), "用户主题要出现在清单里");
    assert.deepEqual(ui.setTheme("mine"), { success: true });
    assert.equal(ui.theme.name, "mine");
    assert.equal(
      emitted.some((e) => e.method === "setTheme"),
      false,
      "用户主题在壳这边没有对应外观，不能把壳改成 dark/light",
    );
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("宿主必须在构造任何 host 之前注入 Theme 类（模块级注入）", () => {
  const src = readFileSync(new URL("./sdk-session-host.ts", import.meta.url), "utf8");
  assert.match(src, /^setPiThemeConstructor\(SdkTheme/m, "注入必须是模块级的：晚于 host 构造会让首个会话渲染不出主题");
  assert.match(src, /agentDir: this\.agentDir,/, "适配器要拿到 agent 目录（用户主题目录与壳偏好都按它解析）");
  assert.match(
    src,
    /this\.onDestroy\(onPiThemeChange\(\(\) => this\.rerenderToolLines\(\)\)\)/,
    "别处切主题后必须重渲本会话已渲染的插件行（否则留着旧主题的颜色），且退订要挂在 onDestroy 上",
  );
  assert.match(
    src,
    /alignPiThemeWithShellPreferenceOnStartup\(this\.agentDir\)/,
    "构造期必须按壳的明暗偏好对齐插件主题：否则重启后壳 light、插件 ANSI 还是 dark",
  );
});

/** 主题是进程级状态：跑完把渲染桥恢复成默认（同文件其它用例依赖 dark）。 */
async function withFreshTheme(body) {
  const bridge = await jiti.import("./tui-render-bridge.ts");
  bridge.setPiThemeConstructor(SdkTheme);
  bridge.resetPiThemeForTests();
  bridge.loadPiTheme();
  try {
    return await body(bridge);
  } finally {
    bridge.setPiThemeConstructor(SdkTheme);
    bridge.resetPiThemeForTests();
    bridge.loadPiTheme();
  }
}

test("主题视图：切主题后已挂的 widget 重渲换色（含别的会话切的场景）", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pidance-theme-view-"));
  try {
    await withFreshTheme(async (bridge) => {
      // 两个适配器 = 两个会话：主题是**进程级**的，A 切主题后 B 已挂的 widget 也要换色。
      const a = makeAdapter({ agentDir });
      const b = makeAdapter({ agentDir });
      const lastFrame = () => setWidgetFrames(b.emitted).at(-1)?.widgetLines?.[0];

      b.adapter.uiContext.setWidget("w", (_tui, theme) => ({
        render: () => [theme.fg("accent", "WIDGET")],
      }));
      const before = lastFrame();
      assert.ok(before && before.includes("\u001b["), `widget 行应带 ANSI 颜色，实际：${JSON.stringify(before)}`);
      assert.equal(stripAnsi(before), "WIDGET", "上色不得改内容（Web 侧状态栏与 widget 行都解析 ANSI）");

      assert.deepEqual(a.adapter.uiContext.setTheme("light"), { success: true });
      // widget 的重渲是**批帧**的（queueMicrotask 合并同一 tick 内的多次 requestRender），
      // 所以读帧前要等一拍；custom 面板那侧是同步 emit。
      await tick();
      const after = lastFrame();
      assert.notEqual(after, before, "别的会话切主题后，本会话已挂的 widget 必须重渲换色");
      assert.equal(stripAnsi(after), "WIDGET", "换色后内容仍然不变");
      assert.equal(
        after,
        bridge.loadPiTheme().fg("accent", "WIDGET"),
        "颜色必须来自**当前**主题，不是挂载时的那个实例",
      );
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("主题视图：custom 面板同样按当前主题取色（切主题后重渲换色）", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pidance-theme-view-"));
  try {
    await withFreshTheme(async (bridge) => {
      const { adapter, emitted } = makeAdapter({ agentDir });
      const panelFrames = () => emitted.filter((event) => event.method === "custom" && !event.closed);
      let close;
      void adapter.uiContext.custom((_tui, theme, _kb, done) => {
        close = done;
        return { render: () => [theme.fg("accent", "PANEL")] };
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const before = panelFrames().at(-1)?.lines?.[0];
      assert.ok(before?.includes("\u001b["), `custom 面板行应带 ANSI 颜色，实际：${JSON.stringify(before)}`);

      assert.deepEqual(adapter.uiContext.setTheme("light"), { success: true });
      const after = panelFrames().at(-1)?.lines?.[0];
      assert.notEqual(after, before, "切主题后 custom 面板必须重渲换色");
      assert.equal(after, bridge.loadPiTheme().fg("accent", "PANEL"));
      close?.(undefined);
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("主题订阅随适配器释放：dispose 后退订（不留常驻订阅者）", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pidance-theme-view-"));
  try {
    await withFreshTheme(async (bridge) => {
      const baseline = bridge.piThemeChangeListenerCountForTests();
      const { adapter, emitted } = makeAdapter({ agentDir });
      assert.equal(bridge.piThemeChangeListenerCountForTests(), baseline + 1, "每个适配器订阅一次主题变化");
      adapter.uiContext.setWidget("w", (_tui, theme) => ({ render: () => [theme.fg("accent", "X")] }));
      const framesBefore = setWidgetFrames(emitted).length;

      adapter.dispose();
      assert.equal(bridge.piThemeChangeListenerCountForTests(), baseline, "dispose 必须退订");
      bridge.setCurrentPiTheme(bridge.loadPiTheme());
      await tick();
      assert.equal(setWidgetFrames(emitted).length, framesBefore, "退订后不得再推帧");
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ctx.ui.setFooter / setHeader：页头页脚槽位（issue #98）
// ---------------------------------------------------------------------------

const slotFrames = (emitted, kind) => emitted.filter((e) => e.method === (kind === "footer" ? "setFooter" : "setHeader"));

/** 挂一个页头/页脚槽位，记录工厂收到的 tui 与第三个参数、以及 dispose 次数。 */
function mountSlotOn(adapter, kind, render) {
  const state = { tui: null, footerData: "unset", disposed: 0, theme: null };
  adapter.uiContext[kind === "footer" ? "setFooter" : "setHeader"]((pluginTui, theme, footerData) => {
    state.tui = pluginTui;
    state.theme = theme;
    state.footerData = footerData;
    return {
      render,
      dispose: () => {
        state.disposed += 1;
      },
    };
  });
  return state;
}

test("setFooter 工厂：首帧立即下发，requestRender 热更新且快照跟随", async () => {
  const { adapter, emitted } = makeAdapter();
  let frame = 0;
  let tui = null;
  adapter.uiContext.setFooter((pluginTui) => {
    tui = pluginTui;
    return { render: () => [`footer ${++frame}`] };
  });

  assert.deepEqual(slotFrames(emitted, "footer").at(-1).lines, ["footer 1"], "首帧必须同步下发");
  assert.deepEqual(adapter.footerLines, ["footer 1"], "快照要跟随（页面后加载靠它水合）");
  assert.equal(adapter.headerLines, null, "页脚不该影响页头快照");

  tui.requestRender();
  await tick();
  assert.deepEqual(slotFrames(emitted, "footer").at(-1).lines, ["footer 2"], "requestRender 推新帧");
  assert.deepEqual(adapter.footerLines, ["footer 2"], "快照跟随热更新");
});

test("setFooter(undefined)：恢复内置（下发 lines=null、快照清空），没有槽位时不发事件", () => {
  const { adapter, emitted } = makeAdapter();
  // 本来就没有槽位：恢复默认不该产生任何事件（插件反复调 reset 时不能刷屏）。
  adapter.uiContext.setFooter(undefined);
  assert.equal(slotFrames(emitted, "footer").length, 0);

  adapter.uiContext.setFooter(() => ({ render: () => ["x"] }));
  assert.deepEqual(adapter.footerLines, ["x"]);

  adapter.uiContext.setFooter(undefined);
  assert.equal(slotFrames(emitted, "footer").at(-1).lines, null, "恢复内置要下发 null");
  assert.equal(adapter.footerLines, null, "快照也要清掉");

  // 再挂回来：同一适配器可以反复替换。
  adapter.uiContext.setFooter(() => ({ render: () => ["y"] }));
  assert.deepEqual(adapter.footerLines, ["y"]);
});

test("setFooter：替换时 dispose 旧组件，旧在途帧不得覆盖新槽位", async () => {
  const { adapter, emitted } = makeAdapter();
  let delayedTui = null;
  let oldDisposed = 0;
  adapter.uiContext.setFooter((pluginTui) => {
    delayedTui = pluginTui;
    return {
      render: () => ["old frame"],
      dispose: () => {
        oldDisposed += 1;
      },
    };
  });
  // 让旧组件排一帧，然后立刻替换：那一帧到达时槽位已经换人。
  delayedTui.requestRender();
  adapter.uiContext.setFooter(() => ({ render: () => ["new frame"] }));

  assert.equal(oldDisposed, 1, "替换必须 dispose 旧组件（插件的定时器/监听器挂在它上面）");
  await tick();
  assert.deepEqual(slotFrames(emitted, "footer").at(-1).lines, ["new frame"], "旧在途帧不得覆盖新槽位");
});

test("setFooter：工厂抛错 → 槽位隐藏 + 每种槽位只提示一次，且不把异常文本贴进界面", () => {
  const { adapter, emitted } = makeAdapter();
  const notices = () => emitted.filter((e) => e.method === "notify" && e.notifyType === "warning");

  adapter.uiContext.setFooter(() => {
    throw new Error("PLUGIN_SECRET_TEXT");
  });
  assert.equal(adapter.footerLines, null, "工厂失败时槽位必须是空的");
  assert.equal(notices().length, 1, "失败要可见（不能静默 no-op）");
  assert.ok(!notices()[0].message.includes("PLUGIN_SECRET_TEXT"), "异常文本不得进界面");
  assert.match(notices()[0].message, /"footer"/);

  // 再挂一个同样会抛的工厂：只提示一次。
  adapter.uiContext.setFooter(() => {
    throw new Error("ANOTHER");
  });
  assert.equal(notices().length, 1, "同一种槽位只提示一次");

  // 页头是另一种槽位，单独计数。
  adapter.uiContext.setHeader(() => {
    throw new Error("HEADER_BOOM");
  });
  assert.equal(notices().length, 2, "页头与页脚各自只提示一次");
});

test("setFooter：渲染抛错 → 槽位隐藏，但下一帧成功能自己回来", async () => {
  const { adapter, emitted } = makeAdapter();
  let broken = false;
  const state = mountSlotOn(adapter, "footer", () => {
    if (broken) throw new Error("render boom");
    return ["ok"];
  });
  assert.deepEqual(adapter.footerLines, ["ok"]);

  broken = true;
  state.tui.requestRender();
  await tick();
  assert.equal(adapter.footerLines, null, "渲染失败要隐藏槽位，而不是显示上一次的旧内容");
  assert.equal(slotFrames(emitted, "footer").at(-1).lines, null);

  broken = false;
  state.tui.requestRender();
  await tick();
  assert.deepEqual(adapter.footerLines, ["ok"], "恢复后同一实例应该能再显示（不是永久摘掉）");
});

test("setFooter 的第三个参数是完整的 ReadonlyFooterDataProvider（否则官方写法的工厂整槽抛错）", () => {
  const { adapter } = makeAdapter();
  adapter.uiContext.setStatus("mcp", "MCP: 1 server");
  const footer = mountSlotOn(adapter, "footer", () => ["f"]);
  const data = footer.footerData;
  assert.ok(data && typeof data === "object", "必须传第三个参数（SDK 契约）");

  // 官方示例 examples/extensions/custom-footer.ts 在工厂里**无条件**调用
  // footerData.onBranchChange(...)：没有这个方法就会 TypeError，槽位被隐藏，
  // 连不依赖 git 的行也一起没。
  assert.equal(typeof data.onBranchChange, "function");
  assert.equal(typeof data.onBranchChange(() => {}), "function", "onBranchChange 要返回退订函数");
  assert.equal(typeof data.getGitBranch, "function");
  assert.equal(data.getGitBranch(), null, "没有 git 来源时如实返回 null（不是假装有分支）");
  assert.equal(typeof data.getExtensionStatuses, "function");
  assert.equal(data.getExtensionStatuses().get("mcp"), "MCP: 1 server", "状态要能读到 setStatus 放的内容");
  assert.equal(typeof data.getAvailableProviderCount, "function");
  assert.equal(data.getAvailableProviderCount(), 0, "没有同步来源时如实返回 0");

  // 四个成员齐全 → 按官方写法写的工厂能正常渲染（不再整槽抛错）。
  const official = makeAdapter();
  official.adapter.uiContext.setFooter((_tui, _theme, footerData) => {
    const unsubscribe = footerData.onBranchChange(() => {});
    return {
      render: () => [`branch=${String(footerData.getGitBranch())} statuses=${footerData.getExtensionStatuses().size}`],
      dispose: unsubscribe,
    };
  });
  assert.deepEqual(
    slotFrames(official.emitted, "footer").at(-1).lines,
    ["branch=null statuses=0"],
    "官方写法的工厂必须能渲染出来",
  );
});

test("槽位渲染出 0 行：隐藏但**不**报失败（组件让页脚自己藏起来是正常状态）", () => {
  const { adapter, emitted } = makeAdapter();
  adapter.uiContext.setFooter(() => ({ render: () => [] }));

  const frames = slotFrames(emitted, "footer");
  assert.equal(frames.length, 1, "要下发一帧（把槽位隐藏）");
  assert.equal(frames.at(-1).lines, null, "空帧 = 没有内容");
  assert.equal(adapter.footerLines, null);
  assert.deepEqual(adapter.capabilityNoticeSnapshot, [], "空帧不是失败，不该进能力提示快照");

  // 下一帧有内容要能自己回来（entry 被保留）
  let empty = true;
  let tui = null;
  adapter.uiContext.setHeader((pluginTui) => {
    tui = pluginTui;
    return { render: () => (empty ? [] : ["back"]) };
  });
  assert.equal(adapter.headerLines, null);
  empty = false;
  tui.requestRender();
  return tick().then(() => {
    assert.deepEqual(adapter.headerLines, ["back"], "从空帧恢复要能显示");
  });
});

test("槽位渲染失败进能力提示快照（一次性 SSE 会漏，页头在订阅前就挂上了）", () => {
  const { adapter, emitted } = makeAdapter();
  adapter.uiContext.setFooter(() => ({ render: () => "not-an-array" }));

  assert.equal(adapter.footerLines, null, "失败要隐藏槽位");
  const notices = adapter.capabilityNoticeSnapshot;
  assert.equal(notices.length, 1, "失败提示要进快照");
  assert.match(notices[0].message, /^Extension UI "footer" component could not be rendered/);
  // capabilityFeatureOf 靠这句式取能力名（lib/capability-notice-seen.ts）
  assert.equal(/Extension UI "([^"]{1,80})"/.exec(notices[0].message)?.[1], "footer");

  // 同一种槽位只提示一次
  adapter.uiContext.setFooter(() => ({ render: () => "still-bad" }));
  assert.equal(adapter.capabilityNoticeSnapshot.length, 1, "同一种槽位不重复提示");

  // reload 前宿主会清掉记忆：新组件再失败要能重新提示
  adapter.resetSlotFailures();
  adapter.uiContext.setFooter(() => ({ render: () => "bad-again" }));
  assert.equal(adapter.capabilityNoticeSnapshot.length, 2, "清掉记忆后应能再提示一次");
  assert.equal(slotFrames(emitted, "footer").at(-1).lines, null);
});

test("setEditorFocus 也会重渲页头/页脚槽位（读 tui.focusedComponent 的页头会停在旧帧）", async () => {
  const { adapter } = makeAdapter();
  adapter.uiContext.setHeader((pluginTui) => ({
    render: () => [`focus=${String(Boolean(pluginTui.focusedComponent))}`],
  }));
  assert.deepEqual(adapter.headerLines, ["focus=false"], "首帧：输入框还没聚焦");

  assert.equal(adapter.setEditorFocus(true, "c1"), true, "焦点变化要报告变化");
  await tick();
  assert.deepEqual(adapter.headerLines, ["focus=true"], "槽位必须跟着重渲");
});

test("setToolsExpanded：isExpandable 的页头拿到新的展开态并重渲", async () => {
  const { adapter } = makeAdapter();
  const calls = [];
  adapter.uiContext.setHeader(() => ({
    render: () => ["head"],
    setExpanded: (expanded) => calls.push(expanded),
  }));
  assert.deepEqual(calls, [false], "挂载时同步一次（默认展开态是 false）");

  adapter.uiContext.setToolsExpanded(true);
  await tick();
  assert.deepEqual(calls, [false, true], "setToolsExpanded 要交给页头");

  // 普通组件（没有 setExpanded）不该被调用、也不该抛
  const plain = makeAdapter();
  plain.adapter.uiContext.setHeader(() => ({ render: () => ["h"] }));
  plain.adapter.uiContext.setToolsExpanded(true);
  assert.deepEqual(plain.adapter.headerLines, ["h"]);
});

test("SDK 官方示例 custom-footer.ts 能整槽渲染出来（第三个参数必须是完整 provider）", async () => {
  // 不是「我照官方写法写一个」：**直接跑 SDK 自带的那个示例**。
  // 它在工厂里无条件调用 footerData.onBranchChange(...)，并在 render 里读
  // getGitBranch() / ctx.model.id / ctx.sessionManager —— 正是审查指出会整槽抛错的那种写法。
  const mod = await jiti.import(
    new URL("../node_modules/@earendil-works/pi-coding-agent/examples/extensions/custom-footer.ts", import.meta.url).pathname,
  );
  const extension = typeof mod === "function" ? mod : mod.default;
  assert.equal(typeof extension, "function", "没加载到官方示例");

  const commands = new Map();
  extension({ registerCommand: (name, options) => commands.set(name, options) });
  const handler = commands.get("footer")?.handler;
  assert.equal(typeof handler, "function", "官方示例应注册 footer 命令");

  const { adapter, emitted } = makeAdapter();
  adapter.uiContext.setStatus("mcp", "MCP: 1 server");
  const ctx = {
    ui: adapter.uiContext,
    sessionManager: { getBranch: () => [] },
    model: { id: "test-model" },
  };

  await handler("", ctx);
  const frame = slotFrames(emitted, "footer").at(-1);
  assert.ok(frame && Array.isArray(frame.lines) && frame.lines.length === 1, "官方示例的页脚必须渲染出来");
  assert.match(stripAnsi(frame.lines[0]), /test-model/, "页脚右侧应显示模型 id");
  assert.deepEqual(adapter.capabilityNoticeSnapshot, [], "官方示例不该触发『渲染失败』提示");

  // 再跑一次 = 关掉：清槽 + dispose（官方示例的 dispose 就是 onBranchChange 的退订函数）
  await handler("", ctx);
  assert.equal(adapter.footerLines, null, "关掉后槽位要清空");
});

test("SDK 官方示例 custom-header.ts 能整槽渲染（含 ctx.mode === \"tui\" 分支与恢复内置）", async () => {
  // 与页脚同一个口径：直接跑 SDK 自带的示例，而不是我照写法自造一个。
  const mod = await jiti.import(
    new URL("../node_modules/@earendil-works/pi-coding-agent/examples/extensions/custom-header.ts", import.meta.url).pathname,
  );
  const extension = typeof mod === "function" ? mod : mod.default;
  const listeners = new Map();
  const commands = new Map();
  extension({
    on: (name, handler) => listeners.set(name, handler),
    registerCommand: (name, options) => commands.set(name, options),
  });

  const { adapter } = makeAdapter();
  await listeners.get("session_start")({}, { ui: adapter.uiContext, mode: "tui" });
  const lines = adapter.headerLines;
  assert.ok(lines && lines.length >= 2, "页头应渲染出吉祥物 + 副标题（多行）");
  assert.match(stripAnsi(lines.at(-1)), /shitty coding agent/, "副标题应在最后一行");

  await commands.get("builtin-header").handler("", { ui: adapter.uiContext });
  assert.equal(adapter.headerLines, null, "恢复内置页头要清掉槽位");
});

test("setHeader 与 setFooter 各自独立：互不覆盖、替换各算各的", () => {
  const { adapter, emitted } = makeAdapter();
  const header = mountSlotOn(adapter, "header", () => ["head"]);
  const footer = mountSlotOn(adapter, "footer", () => ["foot"]);

  assert.deepEqual(adapter.headerLines, ["head"]);
  assert.deepEqual(adapter.footerLines, ["foot"]);

  adapter.uiContext.setHeader(() => ({ render: () => ["head 2"] }));
  assert.equal(header.disposed, 1, "页头替换要 dispose 旧组件");
  assert.equal(footer.disposed, 0, "替换页头不该动页脚");
  assert.deepEqual(adapter.footerLines, ["foot"]);
  assert.deepEqual(slotFrames(emitted, "header").at(-1).lines, ["head 2"]);
});

test("setRenderSize：尺寸变化让页头页脚用新宽度重渲；dispose 适配器时摘掉并 dispose 组件", async () => {
  const { adapter, emitted } = makeAdapter();
  adapter.setRenderSize({ width: 80, rows: 45 });
  const footer = mountSlotOn(adapter, "footer", (width) => [`footer@${width}`]);
  assert.deepEqual(slotFrames(emitted, "footer").at(-1).lines, ["footer@80"]);

  adapter.setRenderSize({ width: 60, rows: 31 });
  await tick();
  assert.deepEqual(slotFrames(emitted, "footer").at(-1).lines, ["footer@60"], "插件按列数排版，宽度变了要重渲");
  assert.equal(footer.tui.terminal.columns, 60, "terminal.columns 是 getter，要与 render 参数一致");

  adapter.dispose();
  assert.equal(footer.disposed, 1, "适配器释放要 dispose 槽位组件");
  assert.equal(adapter.footerLines, null, "释放后快照要清空");
});

/**
 * 插件编辑器接管（issue #107）。
 *
 * 用**真 pi-tui 组件**（Text）而不是自造 stub：插件交出来的就是这类组件，只有真组件才会
 * 暴露「我们的取值顺序 / 生命周期假设不对」这类问题（issue #104 的教训：假钩子全绿、
 * 真组件不工作）。
 */
test("编辑器接管：工厂被调用，组件渲染行下发，getEditorComponent 能读回工厂", () => {
  const { adapter, emitted } = makeAdapter();
  const tuiArgs = [];
  const factory = (tui, theme, keybindings) => {
    tuiArgs.push({ tui, theme, keybindings });
    return new Text("PLUGIN EDITOR LINE", 0, 0);
  };
  adapter.uiContext.setEditorComponent(factory);

  assert.equal(adapter.getEditorComponent ?? adapter.uiContext.getEditorComponent(), factory, "工厂要能被读回");
  assert.equal(tuiArgs.length, 1, "工厂应被调用一次");
  const arg = tuiArgs[0];
  assert.equal(typeof arg.tui.requestRender, "function", "工厂收到 tui（插件靠它重渲）");
  assert.equal(typeof arg.tui.terminal.columns, "number", "tui.terminal.columns 要可用");
  assert.equal(typeof arg.keybindings.matches, "function", "工厂收到 keybindings（插件用它判断按键）");
  // 第二个参数**不是**插件那个 Theme：TUI 的 setCustomEditorComponent 交的是
  // `getEditorTheme()` 的 `{ borderColor, selectList }`（interactive-mode + theme/theme.js），
  // 插件组件按这个形状取成员。曾经这里断言 `theme.fg` 存在 —— 那是把「工厂收到 Theme」
  // 当成了契约，方向反了：组件真去调 `theme.borderColor(...)` 会撞 undefined。
  assert.equal(typeof arg.theme.borderColor, "function", "工厂收到的是 EditorTheme：必须有 borderColor");
  assert.equal(typeof arg.theme.selectList?.noMatch, "function", "工厂收到的是 EditorTheme：必须有 selectList");

  const frames = emitted.filter((e) => e.method === "editorComponent");
  assert.equal(frames.length, 1, "挂载时要下发一帧");
  assert.equal(frames[0].closed, undefined);
  // 真 pi-tui 组件按宽度补空格，比内容时去掉首尾空白。
  assert.deepEqual(frames[0].lines.map((line) => stripAnsi(line).trim()), ["PLUGIN EDITOR LINE"]);
  assert.equal(typeof frames[0].id, "string");
  assert.equal(adapter.editorTakeoverSnapshot?.id, frames[0].id, "快照要能供 /state 水合");
});

test("编辑器接管：按键进组件的 handleInput，并且先过插件的全局监听器（pi-tui 顺序）", () => {
  const { adapter, emitted } = makeAdapter();
  const received = [];
  // 真组件 + 记录收到的按键：插件要实现 handleInput 就得自己写，这里包一层。
  const base = new Text("BODY", 0, 0);
  const component = Object.assign(base, {
    handleInput(data) { received.push(data); this.setText("BODY:" + data); },
  });
  adapter.uiContext.setEditorComponent(() => component);

  assert.deepEqual(adapter.dispatchEditorComponentInput("a"), { consumed: true, data: "a" });
  assert.deepEqual(received, ["a"], "按键要进组件");
  const frames = emitted.filter((e) => e.method === "editorComponent");
  assert.deepEqual(frames.at(-1).lines.map((line) => stripAnsi(line).trim()), ["BODY:a"], "输入后要重渲并下发新内容");

  // 全局监听器先看：consume 掉之后组件收不到（终端里监听器本来就在聚焦组件之前）。
  adapter.uiContext.onTerminalInput((data) => (data === "x" ? { consume: true } : undefined));
  assert.equal(adapter.dispatchEditorComponentInput("x").consumed, true);
  assert.deepEqual(received, ["a"], "被监听器消费的按键不该进组件");
  // 没被消费的照旧进组件
  adapter.dispatchEditorComponentInput("y");
  assert.deepEqual(received, ["a", "y"]);
});

test("编辑器接管：组件调 onSubmit 只发一条提交事件（正文由客户端交给发送管线）", () => {
  const { adapter, emitted } = makeAdapter();
  const component = Object.assign(new Text("BODY", 0, 0), {
    // 插件会这样调（TUI 也是把 onSubmit 接到发送）：这里验证适配器把 onSubmit 换成了
    // 「通知客户端」——服务端不得自己提交 prompt。
    handleInput() { this.onSubmit?.("你好世界"); },
  });
  adapter.uiContext.setEditorComponent(() => component);
  adapter.dispatchEditorComponentInput("\r");

  const submits = emitted.filter((e) => e.method === "editorComponentSubmit");
  assert.equal(submits.length, 1, "提交要发且只发一条");
  assert.equal(submits[0].text, "你好世界");
  assert.equal(
    emitted.some((e) => e.type === "prompt" || e.method === "prompt"),
    false,
    "服务端不得直接提交 prompt（要由客户端走既有发送入口）",
  );
});

test("编辑器接管：组件抛错 / 返回垃圾 → 收掉接管并通知客户端恢复输入框（可见降级）", () => {
  const thrown = makeAdapter();
  thrown.adapter.uiContext.setEditorComponent(() => ({ render() { throw new Error("boom"); } }));
  const thrownFrames = thrown.emitted.filter((e) => e.method === "editorComponent");
  assert.equal(thrownFrames.at(-1)?.closed, true, "渲染失败要结束接管（回到我们自己的输入框）");
  assert.equal(thrown.adapter.editorTakeoverSnapshot, null);
  assert.equal(
    JSON.stringify(thrown.emitted).includes("boom"),
    false,
    "异常文本不能进下发内容（那是把插件私有内容当正文）",
  );

  const garbage = makeAdapter();
  garbage.adapter.uiContext.setEditorComponent(() => 42);
  assert.equal(garbage.adapter.editorTakeoverSnapshot, null);
  assert.equal(garbage.emitted.filter((e) => e.method === "editorComponent").at(-1)?.closed, true);

  const factoryThrows = makeAdapter();
  factoryThrows.adapter.uiContext.setEditorComponent(() => { throw new Error("factory boom"); });
  assert.equal(factoryThrows.adapter.editorTakeoverSnapshot, null, "工厂就抛错时没有可显示的内容");
  assert.equal(
    factoryThrows.emitted.filter((e) => e.method === "editorComponent").at(-1)?.closed,
    true,
    "也要告诉客户端恢复输入框（免得它还以为有接管）",
  );
  assert.equal(JSON.stringify(factoryThrows.emitted).includes("factory boom"), false, "异常文本不进下发内容");
});

test("编辑器接管：setEditorComponent(undefined) 结束接管，getEditorComponent 回到 undefined", () => {
  const { adapter, emitted } = makeAdapter();
  const factory = () => new Text("X", 0, 0);
  adapter.uiContext.setEditorComponent(factory);
  assert.ok(adapter.editorTakeoverSnapshot);

  adapter.uiContext.setEditorComponent(undefined);
  assert.equal(adapter.editorTakeoverSnapshot, null);
  assert.equal(adapter.uiContext.getEditorComponent(), undefined);
  assert.equal(emitted.filter((e) => e.method === "editorComponent").at(-1)?.closed, true);
  // 结束之后再按键：不再进任何组件（已经摘掉了）
  assert.deepEqual(adapter.dispatchEditorComponentInput("a"), { consumed: false, data: "a" });
});

test("编辑器接管：换一个新工厂会先收掉旧组件（dispose 要调），再挂新的", () => {
  const { adapter, emitted } = makeAdapter();
  let disposed = 0;
  const make = (label) => Object.assign(new Text(label, 0, 0), { dispose() { disposed += 1; } });
  adapter.uiContext.setEditorComponent(() => make("ONE"));
  const firstId = adapter.editorTakeoverSnapshot?.id;
  adapter.uiContext.setEditorComponent(() => make("TWO"));
  assert.equal(disposed, 1, "旧组件要 dispose");
  assert.notEqual(adapter.editorTakeoverSnapshot?.id, firstId, "新工厂是新接管");
  assert.deepEqual(
    emitted.filter((e) => e.method === "editorComponent").at(-1)?.lines.map((line) => stripAnsi(line).trim()),
    ["TWO"],
  );
});

test("编辑器接管：dispose 时静默收掉（宿主正在销毁，没有订阅者需要通知）", () => {
  const { adapter, emitted } = makeAdapter();
  adapter.uiContext.setEditorComponent(() => new Text("X", 0, 0));
  adapter.dispose();
  assert.equal(adapter.editorTakeoverSnapshot, null);
  assert.equal(
    emitted.filter((e) => e.method === "editorComponent").at(-1)?.closed,
    undefined,
    "dispose 不该再发「接管结束」帧",
  );
});

// ---------------------------------------------------------------------------
// 编辑器接管：TUI 的 setCustomEditorComponent 契约（issue #107）
// ---------------------------------------------------------------------------
test("编辑器接管：工厂拿到的是 EditorTheme（{borderColor, selectList}），不是插件那个 Theme", () => {
  const { adapter } = makeAdapter();
  const themes = [];
  adapter.uiContext.setEditorComponent((_tui, theme) => {
    themes.push(theme);
    return new Text("X", 0, 0);
  });
  const theme = themes[0];
  // TUI：getEditorTheme() → { borderColor, selectList }。插件组件按这个形状取成员。
  assert.equal(typeof theme.borderColor, "function", "缺 borderColor：插件组件取边框色会 TypeError");
  assert.ok(theme.borderColor("边框").includes("\u001b["), "边框色应真的上色（真主题产出 ANSI）");
  assert.equal(stripAnsi(theme.borderColor("边框")), "边框", "上色不该改文本内容");
  for (const member of ["selectedPrefix", "selectedText", "description", "scrollInfo", "noMatch"]) {
    assert.equal(typeof theme.selectList?.[member], "function", `selectList 缺 ${member}`);
  }
  assert.equal(stripAnsi(theme.selectList.noMatch("无匹配")), "无匹配");
});

test("编辑器接管：onSubmit 与 onChange 由宿主挂到组件实例上（组件自己调 this.onSubmit）", () => {
  const { adapter, emitted } = makeAdapter();
  // 插件照接口写：不自己实现 onSubmit/onChange，等宿主挂（TUI 就是这么接的）。
  const component = Object.assign(new Text("BODY", 0, 0), {
    handleInput() { this.onSubmit?.("宿主挂上来的提交"); },
  });
  adapter.uiContext.setEditorComponent(() => component);

  assert.equal(typeof component.onSubmit, "function", "宿主没挂 onSubmit：组件调 this.onSubmit 会 TypeError");
  assert.equal(typeof component.onChange, "function", "宿主没挂 onChange：组件调 this.onChange 会 TypeError");

  // 挂上去之后组件一调就真的走那条路（一条提交事件，服务端不自作主张提交）
  component.handleInput("x");
  const submits = emitted.filter((e) => e.method === "editorComponentSubmit");
  assert.equal(submits.length, 1, "组件调 onSubmit 应发且只发一条提交事件");
  assert.equal(submits[0].text, "宿主挂上来的提交");
});

test("编辑器接管：提交带上「谁敲的字」，落点由请求 id 兜住（issue #107 审查 阻断 2）", () => {
  const { adapter, emitted } = makeAdapter();
  const component = Object.assign(new Text("BODY", 0, 0), {
    handleInput(data) { if (data === "\r") this.onSubmit("提交正文"); },
  });
  adapter.uiContext.setEditorComponent(() => component);

  // 由标签 A 的按键触发：提交事件必须带上 A。
  adapter.dispatchEditorComponentInput("\r", "tab-A");
  const submits = emitted.filter((e) => e.method === "editorComponentSubmit");
  assert.equal(submits.length, 1);
  assert.equal(submits[0].text, "提交正文");
  assert.equal(submits[0].clientId, "tab-A", "没有来源标签，每个标签都会执行一次提交");

  // 非按键来源（插件自己调 onSubmit）：不带 clientId，由正在显示接管的标签兜底。
  component.onSubmit("插件自己提交");
  const submits2 = emitted.filter((e) => e.method === "editorComponentSubmit");
  assert.equal(submits2.length, 2);
  assert.equal(submits2.at(-1).clientId, undefined, "没有来源就不能硬说是某个标签");
});

test("编辑器接管：applyEditorTakeoverText 只在请求 id 还对得上时写组件（提交失败回填 / 重进灌草稿）", () => {
  const written = [];
  const { adapter } = makeAdapter();
  const component = Object.assign(new Text("BODY", 0, 0), {
    handleInput() {},
    setText(text) { written.push(text); },
  });
  adapter.uiContext.setEditorComponent(() => component);
  const id = adapter.editorTakeoverSnapshot.id;
  assert.equal(adapter.applyEditorTakeoverText(id, "失败回填的正文"), true);
  assert.deepEqual(written.at(-1), "失败回填的正文", "回填要真的写进组件");
  assert.equal(adapter.applyEditorTakeoverText("other-id", "不该落进去"), false, "换了接管就别写") ;
  assert.notDeepEqual(written.at(-1), "不该落进去");

  // 组件漏实现 setText → false（调用方据此决定兜底），且不抛。
  const { adapter: adapter2 } = makeAdapter();
  // 注意：不能 `delete bare.setText` —— Text 的 setText 在**原型**上，删实例属性删不掉，
  // 断言会因此恒真（审查者点出过这条）。这里用一个显式 setText: undefined 的普通组件。
  const bare = { render: () => ["BARE"], invalidate() {}, handleInput() {}, getText: () => "", setText: undefined };
  adapter2.uiContext.setEditorComponent(() => bare);
  assert.equal(adapter2.applyEditorTakeoverText(adapter2.editorTakeoverSnapshot.id, "x"), false);
});

test("编辑器接管：「返回输入框」把组件文本定向交还给发起标签（其它标签不动）", () => {
  const { adapter, emitted } = makeAdapter();
  const component = Object.assign(new Text("BODY", 0, 0), {
    handleInput() {},
    getText() { return "组件里改过的字"; },
  });
  adapter.uiContext.setEditorComponent(() => component);
  const id = adapter.editorTakeoverSnapshot.id;
  assert.equal(adapter.dismissEditorTakeover(id, "tab-A"), true);
  const sent = emitted.filter((e) => e.method === "set_editor_text");
  assert.equal(sent.length, 1, "收起时要把组件文本交给输入框");
  assert.equal(sent[0].text, "组件里改过的字");
  assert.equal(sent[0].appliedToTakeover, false, "交还的目标是输入框，不是组件");
  assert.equal(sent[0].clientId, "tab-A", "只发给发起标签（其它标签还显示着面板）");

  // 组件里是空的：不发无意义的空文本
  const { adapter: adapter2, emitted: emitted2 } = makeAdapter();
  const empty = Object.assign(new Text("BODY", 0, 0), { handleInput() {}, getText() { return ""; } });
  adapter2.uiContext.setEditorComponent(() => empty);
  assert.equal(adapter2.dismissEditorTakeover(adapter2.editorTakeoverSnapshot.id, "tab-A"), false);
  assert.equal(emitted2.filter((e) => e.method === "set_editor_text").length, 0);
});

test("编辑器接管：pasteToEditor 按 bracketed 走组件的 handleInput（不是整段替换 setText）", () => {
  const inputs = [];
  const written = [];
  const { adapter } = makeAdapter();
  const component = Object.assign(new Text("BODY", 0, 0), {
    handleInput(data) { inputs.push(data); },
    setText(text) { written.push(text); },
  });
  adapter.uiContext.setEditorComponent(() => component);
  adapter.uiContext.pasteToEditor("贴进来的字");
  assert.equal(inputs.length, 1, "粘贴要喂进 handleInput（TUI 的 pasteToEditor 就是这么做的）");
  assert.match(inputs[0], /贴进来的字/);
  assert.ok(inputs[0].includes("\u001b[200~"), "要用括号粘贴标记，组件才认得出这是粘贴");
  assert.deepEqual(written, [], "粘贴不该走 setText（那是整段替换）");
});

test("编辑器接管：卸下工厂时把组件文本交还给输入框（TUI 恢复默认编辑器时的 getText/setText）", () => {
  const { adapter, emitted } = makeAdapter();
  const component = Object.assign(new Text("BODY", 0, 0), {
    handleInput() {},
    getText() { return "还没提交的字"; },
  });
  adapter.uiContext.setEditorComponent(() => component);
  emitted.length = 0;
  adapter.uiContext.setEditorComponent(undefined);
  const closed = emitted.filter((e) => e.method === "editorComponent" && e.closed);
  assert.equal(closed.length, 1, "要先告诉客户端接管结束（恢复输入框）");
  const carried = emitted.filter((e) => e.method === "set_editor_text");
  assert.equal(carried.length, 1, "组件里的文本不能随它一起消失");
  assert.equal(carried[0].text, "还没提交的字");
  assert.equal(carried[0].appliedToTakeover, false);
});

test("编辑器接管：挂载时把当前草稿灌进组件（TUI: newEditor.setText(currentText)）", () => {
  const written = [];
  const { adapter } = makeAdapter({ readComposerText: () => "切之前的草稿" });
  const component = Object.assign(new Text("BODY", 0, 0), {
    handleInput() {},
    setText(text) { written.push(text); },
  });
  adapter.uiContext.setEditorComponent(() => component);
  assert.deepEqual(written, ["切之前的草稿"], "接管时应把草稿灌进组件");

  // 组件漏实现 setText（接口必选，插件可能漏）：跳过而不是把整次接管搞挂
  const { adapter: adapter2 } = makeAdapter({ readComposerText: () => "草稿" });
  const bare = Object.assign(new Text("BODY", 0, 0), { handleInput() {} });
  adapter2.uiContext.setEditorComponent(() => bare);
  assert.equal(typeof adapter2.uiContext.getEditorComponent(), "function", "漏 setText 不该阻断接管");
});

test("编辑器接管：接管期间 getEditorText 回传组件的文本（TUI 的 editor.getText）", () => {
  const { adapter } = makeAdapter({ readComposerText: () => "旧草稿" });
  const component = Object.assign(new Text("BODY", 0, 0), {
    handleInput() {},
    getText() { return "组件里的文本"; },
  });
  adapter.uiContext.setEditorComponent(() => component);
  assert.equal(adapter.uiContext.getEditorText(), "组件里的文本", "接管时输入框是组件的，草稿镜像不该顶上来");

  // getExpandedText 优先（与 TUI 一致）
  const expanded = Object.assign(new Text("BODY", 0, 0), {
    handleInput() {},
    getText() { return "原始"; },
    getExpandedText() { return "展开后"; },
  });
  const { adapter: adapter2 } = makeAdapter({ readComposerText: () => "旧草稿" });
  adapter2.uiContext.setEditorComponent(() => expanded);
  assert.equal(adapter2.uiContext.getEditorText(), "展开后");

  // 对照组：没有接管时仍然读草稿镜像（确认上面不是恒真）
  const { adapter: adapter3 } = makeAdapter({ readComposerText: () => "旧草稿" });
  adapter3.uiContext.setEditorComponent(undefined);
  assert.equal(adapter3.uiContext.getEditorText(), "旧草稿");
});

test("编辑器接管：setEditorText 写进组件并广播 appliedToTakeover（手机 / 收起过的页面也要收到字）", () => {
  const written = [];
  const { adapter, emitted } = makeAdapter();
  const component = Object.assign(new Text("BODY", 0, 0), {
    handleInput() {},
    setText(text) { written.push(text); },
  });
  adapter.uiContext.setEditorComponent(() => component);
  const before = emitted.filter((e) => e.method === "set_editor_text").length;
  adapter.uiContext.setEditorText("插件写进来的文本");
  assert.deepEqual(written.at(-1), "插件写进来的文本", "接管时文本要落进插件组件（TUI 的 editor.setText）");
  // 契约变更（issue #107 审查 重要 4）：**仍然广播**，但要带上 appliedToTakeover。
  // 旧实现「组件有 setText 就直接 return、不发事件」会让**没在显示接管**的页面
  //（手机、设置关掉、点过「返回输入框」）收不到任何字 —— 那些页面靠这条插进可见输入框。
  const sent = emitted.filter((e) => e.method === "set_editor_text");
  assert.equal(sent.length, before + 1, "接管时也要广播（否则手机等页面收不到）");
  assert.equal(sent.at(-1).text, "插件写进来的文本");
  assert.equal(sent.at(-1).appliedToTakeover, true, "要说明组件已经拿到了，显示接管的页面别再送一遍");
  assert.ok(
    emitted.filter((e) => e.method === "editorComponent").length > 0,
    "写进组件后要重渲一帧",
  );

  // 组件漏实现 setText：发出去的 appliedToTakeover 必须是 false（显示接管的页面据此
  // 走「当粘贴送进组件」的兜底），而不是假装已经写进去了。
  const { adapter: adapter2, emitted: emitted2 } = makeAdapter();
  // 注意：不能 `delete bare.setText` —— Text 的 setText 在**原型**上，删实例属性删不掉，
  // 断言会因此恒真（审查者点出过这条）。这里用一个显式 setText: undefined 的普通组件。
  const bare = { render: () => ["BARE"], invalidate() {}, handleInput() {}, getText: () => "", setText: undefined };
  adapter2.uiContext.setEditorComponent(() => bare);
  adapter2.uiContext.setEditorText("组件收不下");
  const sent2 = emitted2.filter((e) => e.method === "set_editor_text");
  assert.equal(sent2.at(-1).text, "组件收不下");
  assert.equal(sent2.at(-1).appliedToTakeover, false, "没写进组件就要如实说");

  // 对照组：没有接管时照旧发 set_editor_text 给输入框
  const { adapter: adapter3, emitted: emitted3 } = makeAdapter();
  adapter3.uiContext.setEditorText("普通路径");
  const sent3 = emitted3.filter((e) => e.method === "set_editor_text");
  assert.equal(sent3.length, 1);
  assert.equal(sent3[0].text, "普通路径");
  assert.equal(sent3[0].appliedToTakeover, false, "没有组件可写，客户端照旧插进输入框");
});

test("编辑器接管：拿 SDK 官方示例 rainbow-editor 真跑一遍（真 CustomEditor 子类，不是假组件）", async () => {
  // 官方示例的注册方式与真插件一致（examples/extensions/rainbow-editor.ts）：
  //   pi.on("session_start", (_e, ctx) => ctx.ui.setEditorComponent((tui, theme, kb) => new RainbowEditor(tui, theme, kb)))
  // 拿它当夹具的意义：它是**真** CustomEditor 子类 —— 构造/渲染会走 pi-tui 真编辑器（边框取色走
  // EditorTheme，传错就在这一刻抛），挂载时也会真的调用 setText 收草稿；假组件（Text）这两点都验不到。
  const examplePath = new URL(
    "../node_modules/@earendil-works/pi-coding-agent/examples/extensions/rainbow-editor.ts",
    import.meta.url,
  ).pathname;
  const example = (await jiti.import(examplePath)).default;
  const handlers = new Map();
  example({ on: (event, handler) => handlers.set(event, handler) });
  assert.equal(typeof handlers.get("session_start"), "function", "官方示例应注册 session_start");

  const { adapter, emitted } = makeAdapter({ readComposerText: () => "hello ultrathink" });
  handlers.get("session_start")({ type: "session_start" }, { ui: adapter.uiContext });

  const frames = emitted.filter((e) => e.method === "editorComponent");
  assert.equal(frames.length, 1, "官方示例应挂上接管并下发一帧（渲染失败会被收掉，帧就没了）");
  const rendered = frames[0].lines.map((line) => stripAnsi(line)).join("\n");
  assert.match(rendered, /hello ultrathink/, "草稿要经 setText 进真编辑器并渲染出来");
  assert.ok(adapter.editorTakeoverSnapshot, "接管快照要能投影给后加载的页面");

  // 真组件也接受宿主挂的 onSubmit/onChange（挂不上这里就是 TypeError）
  assert.equal(typeof adapter.editorTakeoverSnapshot.id, "string");
});

test("编辑器接管：渲染尺寸变化会按新宽度重渲（与 custom 面板同一入口）", () => {
  const { adapter, emitted } = makeAdapter();
  const widths = [];
  const component = Object.assign(new Text("X", 0, 0), {
    render(width) { widths.push(width); return [String(width)]; },
    invalidate() {},
  });
  adapter.uiContext.setEditorComponent(() => component);
  adapter.setRenderSize({ width: 33, rows: 20 });
  assert.ok(widths.includes(33), "换尺寸要重渲接管内容");
  assert.deepEqual(
    emitted.filter((e) => e.method === "editorComponent").at(-1)?.lines.map((line) => stripAnsi(line).trim()),
    ["33"],
  );
});
