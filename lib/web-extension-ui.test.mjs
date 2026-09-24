/**
 * WebExtensionUIAdapter 回归：SDK 扩展常用 API 签名契约。
 * 曾踩坑：theme.fg(name, text) 两参数签名不匹配导致 mcp status 变 "accent"。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createWebExtensionUIAdapter, createFallbackThemeStub } = await jiti.import("./web-extension-ui.ts");
const { stripAnsi } = await jiti.import("./ansi.ts");

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
  adapter.uiContext.setFooter(() => ({ render: () => ["x"] }));
  adapter.uiContext.setFooter(() => ({ render: () => ["y"] }));
  adapter.uiContext.setEditorComponent(() => ({ render: () => ["z"] }));

  const notices = emitted.filter((e) => e.method === "notify" && e.notifyType === "warning");
  assert.equal(notices.length, 2, "setFooter 两次只提示一次，setEditorComponent 另计");
  assert.match(notices[0].message, /setFooter/);
  assert.match(notices[1].message, /setEditorComponent/);
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
  assert.equal(emitted.filter((e) => e.method === "notify").length, 1, "仍然提示一次「Web 不渲染这个工厂」");

  // 插件常见的包裹写法：拿旧的包一层再设回去
  const wrapped = () => factory();
  adapter.uiContext.setEditorComponent(wrapped);
  assert.equal(adapter.uiContext.getEditorComponent(), wrapped, "后设的胜出");

  adapter.uiContext.setEditorComponent(undefined);
  assert.equal(adapter.uiContext.getEditorComponent(), undefined, "undefined = 恢复默认");
  assert.equal(emitted.filter((e) => e.method === "notify").length, 1, "恢复默认不提示降级");
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
  assert.match(notices[0].message, /Ordinary typing never/, "普通打字到不了，必须说清");

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
