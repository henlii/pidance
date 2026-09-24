import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
// t 走 props 注入，这里返回 key 本身即可断言文案键未被替换/新增。
const t = (key) => key;


test("扩展面板打开时独占输入区：输入栏与底栏都不渲染", () => {
  const source = readFileSync(fileURLToPath(new URL("./ChatWindow.tsx", import.meta.url)), "utf8");
  // 面板与输入栏互斥：面板打开时不再渲染 ReadOnly/Locked 栏或 ChatInput
  const inputBranch = source.slice(source.indexOf("const chatInputElement"), source.indexOf("const aboveEditorWidgets"));
  assert.match(inputBranch, /\{extensionDialog \? \(/, "面板未与输入栏互斥渲染");
  assert.match(inputBranch, /\) : isReadOnly && session \? \(/, "面板分支未排除只读/锁定栏");
  assert.ok(inputBranch.includes("<ChatInput"), "ChatInput 分支应保留");
  // 底栏（belowEditor widget + 状态条）同样让位
  assert.match(source, /\{!extensionDialog && \(\s*\n\s*<div/, "底栏未随面板一起隐藏");
});

test("扩展 widget 内容限高内滚；自定义面板与输入框同宽（共用常量）", () => {
  const source = readFileSync(fileURLToPath(new URL("./ChatWindow.tsx", import.meta.url)), "utf8");
  const widgets = source.slice(source.indexOf("function ExtensionWidgets("), source.indexOf("const COLLAPSED_WIDGET_KEYS_STORAGE"));
  // 内容区限高 + 块内滚动，避免超长 widget 把输入区顶出可视区
  assert.ok(widgets.includes("maxHeight: bodyMaxHeight"), "widget 内容缺少限高");
  assert.ok(widgets.includes("overflow: \"auto\""), "widget 内容缺少块内滚动");
  assert.match(widgets, /CHAT_BLOCK_MAX_HEIGHT_MOBILE : CHAT_BLOCK_MAX_HEIGHT/, "限高应复用共享常量");
  const panel = readFileSync(fileURLToPath(new URL("./ExtensionCustomPanel.tsx", import.meta.url)), "utf8");
  const chrome = readFileSync(fileURLToPath(new URL("./ExtensionPanelChrome.tsx", import.meta.url)), "utf8");
  assert.ok(chrome.includes("CHAT_COLUMN_MAX_WIDTH"), "自定义面板未与输入框同宽");
  assert.ok(panel.includes("extension-panel-ansi"), "ANSI 正文应包在 GUI 外壳里");
  assert.ok(!panel.includes("920"), "自定义面板仍保留旧的 920 宽度");
});

test("思考/工具块与 widget 共用同一内容限高常量", () => {
  const messageView = readFileSync(fileURLToPath(new URL("./MessageView.tsx", import.meta.url)), "utf8");
  assert.ok(messageView.includes("CHAT_BLOCK_MAX_HEIGHT_mobile".replace("_mobile", "_MOBILE")));
  assert.ok(messageView.includes(": CHAT_BLOCK_MAX_HEIGHT;"), "MessageView 未复用共享限高常量");
  assert.ok(!messageView.includes("min(320px, 45vh)"), "MessageView 仍有本地重复的限高字面量");
});

// ---------------------------------------------------------------------------
// 插件 widget 按键窄口子的接线守卫：漏传参数会让整条链静默失效（没有报错，
// 只是按键永远到不了插件），所以按仓库既有做法用源码断言钉住。
// ---------------------------------------------------------------------------
test("ChatWindow 给 ChatInput 传会话 id 与插件按键开关，且门槛条件不被放宽", () => {
  const source = readFileSync(fileURLToPath(new URL("./ChatWindow.tsx", import.meta.url)), "utf8");
  assert.ok(source.includes("sessionId={sessionIdRef.current}"), "未把会话 id 传给 ChatInput");
  const gate = source.slice(source.indexOf("extensionWidgetKeysEnabled={"), source.indexOf("blocked={Boolean(extensionDialog)}"));
  assert.ok(gate.includes("!isReadOnly"), "只读会话不应开这条口子");
  assert.ok(gate.includes("!extensionCustomUi"), "有 custom 面板时按键归面板 keytrap，不能重复路由");
  assert.ok(gate.includes("extensionWidgets.length > 0"), "没有 widget 时不该为按键加往返");
  assert.ok(gate.includes("extensionTerminalInputListenerCount > 0"), "没有插件监听器时不该为按键加往返");
});

test("ChatInput 在输入框失焦/聚焦时同步焦点，且把空文本门槛交给钩子", () => {
  const source = readFileSync(fileURLToPath(new URL("./ChatInput.tsx", import.meta.url)), "utf8");
  assert.ok(source.includes("onFocus={() => setComposerFocused(true)}"), "输入框聚焦未上报");
  assert.ok(source.includes("onBlur={() => setComposerFocused(false)}"), "输入框失焦未上报");
  assert.ok(source.includes("useExtensionWidgetKeys({"), "未接上插件按键钩子");
  assert.ok(source.includes("composerEmpty: value.length === 0"), "空文本门槛必须是真实空串（插件的激活条件）");
});

test("宿主处理 editor_focus：把客户端焦点投影给适配器", () => {
  const source = readFileSync(fileURLToPath(new URL("../lib/sdk-session-host.ts", import.meta.url)), "utf8");
  assert.match(source, /case "editor_focus": \{/, "宿主未处理 editor_focus 命令");
  assert.ok(source.includes("setEditorFocus(focused, clientId)"), "宿主未把焦点与 clientId 交给扩展 UI 适配器");
  assert.ok(source.includes("assertFocus === true"), "terminal_input 必须先刷新焦点再交给插件（同一条命令，避免两条 HTTP 乱序）");
});

test("#83 修复轮：按键路由的四处收口（clientId / 同命令刷新焦点 / Esc 清零 / 保鲜期 / 输入法）", () => {
  const hook = readFileSync(fileURLToPath(new URL("../hooks/useExtensionWidgetKeys.ts", import.meta.url)), "utf8");
  // 多标签聚合：上报必须带本标签 clientId，否则后台标签的失焦会清掉前台标签的焦点。
  assert.ok(hook.includes("clientId: clientIdRef.current"), "焦点上报未带 clientId");
  // 焦点与按键同一条命令：拆两条 HTTP 会乱序，冷启动/过期后第一次 ↓ 不激活。
  assert.ok(hook.includes("assertFocus: true"), "按键未在同一条命令里刷新焦点");
  // 本地选择态必须走纯函数迁移（Esc/Enter 无条件清零），不能在钩子里手写布尔赋值。
  assert.ok(hook.includes("nextWidgetInteractionState("), "本地选择态未走纯函数迁移");
  assert.ok(hook.includes("isWidgetInteractionLive("), "本地选择态缺少保鲜期判定");
  // 输入法：合成结束的宽限期，配合 keyCode 229 判定。
  assert.ok(hook.includes("isImeComposing("), "输入法判定未覆盖 keyCode 229 与合成宽限");
  assert.ok(hook.includes("compositionend"), "未监听合成结束（提交那一下会被当成导航键）");
  // 状态回收：切后台/门槛变化要复位。
  assert.ok(hook.includes("interactionRef.current = initialState()"), "未复位选择态");
  const host = readFileSync(fileURLToPath(new URL("../lib/sdk-session-host.ts", import.meta.url)), "utf8");
  assert.ok(host.includes("setEditorFocus(true, asString(command.clientId)"), "宿主未在同一条 terminal_input 里先刷新焦点");
  const termCase = host.slice(host.indexOf("case \"terminal_input\": {"), host.indexOf("case \"editor_focus\": {"));
  assert.ok(
    termCase.indexOf("setEditorFocus(true") < termCase.indexOf("dispatchTerminalInput("),
    "顺序反了：必须先把焦点交给适配器，再把按键交给插件",
  );
});

test("本轮写入的文件：只在收尾 assistant 消息下汇总一次，并透传给 MessageView", () => {
  const source = readFileSync(fileURLToPath(new URL("./ChatWindow.tsx", import.meta.url)), "utf8");
  const renderer = source.slice(source.indexOf("const renderMessage = (item: ChatRenderItem)"), source.indexOf("const view = ("));
  // 出卡判据必须走纯函数（多步轮次的两张卡回归由 lib/turn-written-files.test.mjs 覆盖真形状）。
  assert.match(renderer, /shouldRenderTurnWrittenFiles\(/, "未按「本轮收尾消息」聚合，中间的 step 也会各渲染一张卡");
  assert.match(renderer, /liveAssistantActive,/, "出卡判据未带「同段有流式助手」——多步轮次会出两张卡");
  assert.match(renderer, /index: isLive \? null : idx/, "流式项没有按「未落盘」传给判据");
  assert.match(
    source,
    /const liveAssistantActive = chatPlan\.some\(/,
    "liveAssistantActive 未从渲染计划推导（拿不到流式助手就判不出同段）",
  );
  assert.match(source, /item\.source === "live" && item\.messageOverride\?\.role === "assistant"/, "liveAssistantActive 判据不对");
  assert.match(renderer, /collectTurnWrittenFiles\(/, "没有聚合本轮写入的文件");
  assert.match(renderer, /toolResults: toolResultsMap/, "聚合没带工具结果（写没写成无从判断）");
  assert.match(renderer, /cwd: messageCwd/, "相对路径没有按会话 cwd 解析");
  assert.match(renderer, /NO_WRITTEN_FILES/, "没有写入时未复用稳定空数组（会打破 memo）");
  assert.match(source, /writtenFiles=\{writtenFiles\}/, "没有把聚合结果透给 MessageView");
});
