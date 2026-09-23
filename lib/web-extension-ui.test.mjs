/**
 * WebExtensionUIAdapter 回归：SDK 扩展常用 API 签名契约。
 * 曾踩坑：theme.fg(name, text) 两参数签名不匹配导致 mcp status 变 "accent"。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createWebExtensionUIAdapter } = await jiti.import("./web-extension-ui.ts");

function makeAdapter() {
  const emitted = [];
  const adapter = createWebExtensionUIAdapter((event) => emitted.push(event));
  return { adapter, emitted };
}

test("theme.fg(name, text) 两参数返回 text 本身（mcp 状态防退化）", () => {
  const { adapter } = makeAdapter();
  const theme = adapter.uiContext.theme;
  assert.equal(theme.fg("accent", "MCP: 2/2 servers"), "MCP: 2/2 servers");
  assert.equal(theme.bold("x"), "x");
  // 未知属性也可调用（扩展可能用 dim/italic 等）
  assert.equal(theme.dim("y"), "y");
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
