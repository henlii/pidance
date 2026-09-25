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

test("引用到输入框的接线：AppShell 处理器 → ChatWindow → MessageView（漏一环整条链静默失效）", () => {
  const chat = readFileSync(fileURLToPath(new URL("./ChatWindow.tsx", import.meta.url)), "utf8");
  assert.match(chat, /onReferenceFile\?: \(filePath: string\) => void;/, "ChatWindow 没有声明 onReferenceFile");
  assert.match(chat, /onOpenFile, onReferenceFile, entryJumpRequest/, "ChatWindow 没有解构 onReferenceFile");
  assert.match(chat, /onReferenceFile=\{canReferenceIntoComposer \? onReferenceFile : undefined\}/, "ChatWindow 没把 onReferenceFile 传给 MessageView（或没经过挂载门禁）");
  // 输入框会被三种状态换掉（扩展弹窗 / 只读会话 / 被别的 writer 占用）。那时回调拿到的是空
  // ref，点下去没任何反应——所以门禁必须与输入框的渲染分支同步，不留死按钮。
  assert.match(
    chat,
    /const canReferenceIntoComposer = !extensionDialog && !\(isReadOnly && session\) && !lockedByOther;/,
    "引用回调缺少「输入框已挂载」门禁",
  );
  assert.ok(
    chat.indexOf("const canReferenceIntoComposer") < chat.indexOf("const chatInputElement"),
    "门禁必须在渲染前算好",
  );
  const inputBranch = chat.slice(chat.indexOf("const chatInputElement"), chat.indexOf("const aboveEditorWidgets"));
  for (const condition of ["extensionDialog ?", "isReadOnly && session ?", "lockedByOther ?"]) {
    assert.ok(inputBranch.includes(condition), `输入框渲染分支与门禁不同步：分支里没有 ${condition}`);
  }

  const shell = readFileSync(fileURLToPath(new URL("./AppShell.tsx", import.meta.url)), "utf8");
  const at = shell.indexOf("const handleReferenceFile = useCallback(");
  assert.ok(at > 0, "AppShell 没有 handleReferenceFile");
  const handler = shell.slice(at, at + 400);
  assert.match(handler, /chatInputRef\.current\?\.insertText\(/, "引用没有走输入框唯一的插入入口");
  assert.match(handler, /buildFileReferenceText\(filePath, activeCwd/, "引用没有按当前 cwd 转相对路径");
  assert.match(handler, /\}, \[activeCwd\]\)/, "处理器没有跟随 cwd 更新");
  // activeCwd 必须在处理器之前声明：反了会在渲染期 TDZ 报错（实际踩过一次）
  assert.ok(
    shell.indexOf("const activeCwd = identity.cwd;") < at,
    "handleReferenceFile 声明在 activeCwd 之前（渲染期 TDZ）",
  );
  assert.match(shell, /onReferenceFile=\{handleReferenceFile\}/, "AppShell 没把处理器交给 ChatWindow");
});

test("#100 审查修复：面板的卸载不由客户端时钟驱动，改由宿主结算事件驱动", () => {
  const source = readFileSync(fileURLToPath(new URL("./ChatWindow.tsx", import.meta.url)), "utf8");
  // 之前有一段按本地 expiresAt 调用 dismissExtensionUiRequest 的 effect：它在
  // expiresAt 从未被填时是死代码，填上以后就成了「客户端自己关面板」——与手机/宿主
  // 时钟不一致时会提前消失、每次投影闪一下，或反过来让已结算的按钮仍可点。
  assert.ok(
    !source.includes("dismissExtensionUiRequest"),
    "ChatWindow 不该再自己收起面板（宿主结算时推 extension_ui_settled）",
  );
  assert.doesNotMatch(
    source,
    /expiresAt\s*-\s*Date\.now\(\)/,
    "不该再按本地时钟算对话框到期（客户端与宿主不是同一块钟）",
  );
  // 倒计时到 0 只禁用按钮：组件里仍由 expired → inert 负责。
  const dialog = readFileSync(fileURLToPath(new URL("./ExtensionDialog.tsx", import.meta.url)), "utf8");
  assert.match(dialog, /const inert = disabled \|\| expired \|\| responded;/, "到点后按钮必须不可用");
});

test("扩展页头 / 页脚槽位：位置（页头在转写区之前、页脚在状态条之上）与限高内滚", () => {
  const source = readFileSync(fileURLToPath(new URL("./ChatWindow.tsx", import.meta.url)), "utf8");

  const header = source.indexOf('kind="header"');
  const scroller = source.indexOf('data-chat-scroller="true"');
  assert.ok(header !== -1, "没有渲染插件页头槽位");
  assert.ok(header < scroller, "页头要渲染在转写区之前（TUI 里页头常驻在转写区之上）");

  const footer = source.indexOf('kind="footer"');
  const statusBar = source.indexOf("<ExtensionStatusBar");
  assert.ok(footer !== -1, "没有渲染插件页脚槽位");
  assert.ok(footer < statusBar, "页脚要在我们自己的状态条之上");

  // 槽位组件本体：限高 + 块内滚动（超长页头/页脚不能把输入区顶出可视区）。
  const slot = source.slice(source.indexOf("function ExtensionSlot("), source.indexOf("function ExtensionStatusBar("));
  assert.ok(slot.includes('data-extension-slot={kind}'), "槽位要有可断言的标记");
  assert.match(slot, /EXTENSION_SLOT_MAX_HEIGHT_MOBILE : EXTENSION_SLOT_MAX_HEIGHT/, "限高要复用共享常量");
  assert.ok(slot.includes('overflow: "auto"'), "槽位缺少块内滚动");
});

test("扩展页头 / 页脚槽位的限高：移动端约 4 行、桌面约 6 行（12px/1.5 行高）", () => {
  const source = readFileSync(fileURLToPath(new URL("../lib/chat-column.ts", import.meta.url)), "utf8");
  const mobile = /EXTENSION_SLOT_MAX_HEIGHT_MOBILE = "min\((\d+)px/.exec(source);
  const desktop = /export const EXTENSION_SLOT_MAX_HEIGHT = "min\((\d+)px/.exec(source);
  assert.ok(mobile && desktop, "限高常量必须存在（槽位不限高会顶掉输入区）");
  const lineHeight = 12 * 1.5;
  // 4 行 ≈ 72px + 上下 8px 内边距；6 行 ≈ 108px + 16px。
  assert.ok(Number(mobile[1]) >= 4 * lineHeight && Number(mobile[1]) <= 4 * lineHeight + 24, `移动端限高应约 4 行（实际 ${mobile[1]}px）`);
  assert.ok(Number(desktop[1]) >= 6 * lineHeight && Number(desktop[1]) <= 6 * lineHeight + 24, `桌面限高应约 6 行（实际 ${desktop[1]}px）`);
});
