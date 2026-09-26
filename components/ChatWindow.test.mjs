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
  // 正文区（含 ANSI 渲染与限高/内滚）自 issue #103 起抽成 ExtensionWidgetBody，
  // 因为只有它才是「插件组件的渲染区」、点击坐标也以它为原点。
  const widgets = source.slice(source.indexOf("function ExtensionWidgetBody("), source.indexOf("function ExtensionWidgets("));
  // 内容区限高 + 块内滚动，避免超长 widget 把输入区顶出可视区
  assert.ok(widgets.includes("maxHeight: bodyMaxHeight"), "widget 内容缺少限高");
  assert.ok(widgets.includes("overflow: \"auto\""), "widget 内容缺少块内滚动");
  assert.match(source, /CHAT_BLOCK_MAX_HEIGHT_MOBILE : CHAT_BLOCK_MAX_HEIGHT/, "限高应复用共享常量");
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

test("#102：插件界面显示中时按键归插件，关闭后焦点还给输入框", () => {
  const source = readFileSync(fileURLToPath(new URL("./ChatWindow.tsx", import.meta.url)), "utf8");

  // 窗口 ③ 的启用条件：可见的面板（hidden 的不算，那条是窗口 ①）或扩展对话框。
  assert.ok(source.includes("const extensionSurfaceActive = Boolean(extensionDialog)"), "未按对话框判定插件界面");
  assert.ok(
    source.includes("Boolean(extensionCustomUi && !extensionCustomUi.hidden)"),
    "hidden 的面板不该算「显示中」（那是窗口 ① 的地盘）",
  );
  const hookCall = source.slice(source.indexOf("useExtensionTerminalInput({"), source.indexOf("const extensionSurfaceWasActiveRef"));
  assert.ok(hookCall.includes("hiddenPanelRouting:"), "窗口 ① 参数丢了");
  assert.ok(hookCall.includes("surfaceRouting:"), "窗口 ③ 参数丢了");
  assert.ok(hookCall.includes("extensionTerminalInputListenerCount > 0"), "没有监听器时不该发请求");
  assert.ok(hookCall.includes("!isReadOnly"), "只读会话没有可写宿主，不该往返");

  // #107：接管面板拿着键盘时，窗口 ① 的捕获式预抢必须让位 —— 接管面板的按键走
  // editor_component_input，适配器先过插件全局监听器（pi-tui 顺序）再进被接管的组件；
  // 被窗口 ① 抢先吃掉的话，未被消费的键就永远到不了插件编辑器。
  // 窗口 ① 的让位判据（#107 审查 次要 6）：**不再**是「接管显示就整段关掉窗口 ①」——
  // 那样焦点在消息列表时，收起面板的白名单键既不进插件的全局监听器、也不进接管组件。
  // 现在是「事件目标落在接管 keytrap 里才让位」，判据由 hook 侧实现（那里有行为断言）。
  assert.match(hookCall, /takeoverKeytrap: takeoverKeytrapRefCallback/, "窗口 ① 要让位给接管 keytrap");
  // 回调必须是**稳定引用**（useCallback）：每次渲染换新函数会让 useExtensionTerminalInput
  // 的 effect 在每个流式 token 上重挂一次 window keydown（三轮审查 次要 8）。
  assert.match(
    source,
    /const takeoverKeytrapRefCallback = useCallback\(\(\) => editorTakeoverKeytrapRef\.current, \[\]\)/,
    "keytrap 判据回调要用 useCallback 固定引用",
  );
  assert.match(
    source,
    /const onKeytrapElementCallback = useCallback\(\(element: Element \| null\) => \{/ ,
    "onKeytrapElement 也要固定引用",
  );
  assert.match(source, /onKeytrapElement={onKeytrapElementCallback}/, "面板登记的仍是那个稳定回调");
  assert.ok(!hookCall.includes("editorTakeoverHoldsKeys"), "窗口 ① 不该再看「接管是否显示」整段停手");
  assert.match(source, /const editorTakeoverKeytrapRef = useRef<Element \| null>\(null\)/, "keytrap 定位器要在渲染前备好");
  assert.match(source, /onKeytrapElement=\{/, "接管面板要把自己的 keytrap 元素登记上来");
  assert.match(
    source,
    /const editorTakeoverHoldsKeys = editorTakeoverActive && !extensionSurfaceActive;/,
    "「接管面板拿着键盘」必须是同一个概念（autoFocus 与窗口让位共用它）",
  );
  assert.match(source, /autoFocus=\{editorTakeoverHoldsKeys\}/, "接管面板的 autoFocus 必须用同一个判定");

  // 与窗口 ② 互斥：widget 选择态要求「没有 custom 面板」，窗口 ③ 要求「插件界面显示中」。
  const widgetGate = source.slice(source.indexOf("extensionWidgetKeysEnabled={"), source.indexOf("blocked={Boolean(extensionDialog)}"));
  assert.ok(widgetGate.includes("!extensionCustomUi"), "窗口 ② 的门槛必须排除有面板的情形");

  // 关掉后把焦点还给输入框（否则用户要先点一下输入框才能继续打字）。
  assert.ok(source.includes("chatInputRef?.current?.focus()"), "插件界面关闭后未把焦点还给输入框");
  const effect = source.slice(source.indexOf("const extensionSurfaceWasActiveRef"), source.indexOf("chatInputRef?.current?.focus()"));
  assert.ok(effect.includes("useLayoutEffect("), "焦点归还应在同一次提交里完成（layout effect）");
  // 「只在从有到无、且焦点没人接管时归还」这条判据已抽到纯函数里，
  // **行为**由 lib/extension-panel-keys.test.mjs 的 shouldReturnComposerFocus 用例覆盖
  // （这里只锁「接线没被绕过」—— 不锁的话，直接在 effect 里 focus() 也能过）。
  assert.match(effect, /shouldReturnComposerFocus\(\{/, "判定没有走纯函数（行为测试就管不到它了）");
  assert.match(effect, /wasSurfaceActive: was/, "缺「之前是活跃」这个入参");
  assert.match(effect, /surfaceActive: active/, "缺「现在是活跃」这个入参");
  assert.ok(effect.includes("document.activeElement"), "没把当前焦点元素交给判据");
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

test("#102：ChatInputHandle.focus 存在且真的聚焦输入框（漏一环焦点归还就是空操作）", () => {
  const types = readFileSync(fileURLToPath(new URL("../lib/types.ts", import.meta.url)), "utf8");
  assert.ok(/\bfocus: \(\) => void;/.test(types), "ChatInputHandle 没有 focus()");
  const input = readFileSync(fileURLToPath(new URL("./ChatInput.tsx", import.meta.url)), "utf8");
  assert.ok(input.includes("textareaRef.current?.focus();"), "ChatInput 的 focus() 没有聚焦输入框");
  assert.ok(
    input.slice(input.indexOf("useImperativeHandle")).includes("focus() {"),
    "focus() 没挂在 useImperativeHandle 上",
  );
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

/**
 * 求 `index` 处**由内向外所有带 className 的祖先 div** 的类名链（按 <div>/</div> 配对扫描）。
 *
 * 为什么需要链而不是「直接父元素」：槽位自己的包装 div 只有 style、没有 className，
 * 而决定「页头排在转写区上方还是左边」的是最近的那个布局容器；同时「页头是不是与转写区
 * 同一条嵌套链」也要靠链来判断（否则页头被挪到别处、转写区没有页头也看不出来）。
 * 自闭合标签（<div ... />）不入栈 —— 它们不是容器。
 */
function ancestorClassNames(source, index) {
  const stack = [];
  const tagPattern = /<div\b|<\/div>/g;
  let match;
  while ((match = tagPattern.exec(source)) !== null && match.index < index) {
    if (match[0] === "</div>") {
      stack.pop();
      continue;
    }
    const tagEnd = source.indexOf(">", match.index);
    if (source[tagEnd - 1] === "/") continue;
    stack.push(match.index);
  }
  const chain = [];
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const open = stack[i];
    const className = /className="([^"]*)"/.exec(source.slice(open, source.indexOf(">", open) + 1))?.[1];
    if (className) chain.push(className);
  }
  return chain;
}
test("扩展页头 / 页脚槽位：位置（页头在转写区之前、页脚在状态条之上）与限高内滚", () => {
  const source = readFileSync(fileURLToPath(new URL("./ChatWindow.tsx", import.meta.url)), "utf8");

  const header = source.indexOf('kind="header"');
  const scroller = source.indexOf('data-chat-scroller="true"');
  assert.ok(header !== -1, "没有渲染插件页头槽位");
  assert.ok(header < scroller, "页头要渲染在转写区之前（TUI 里页头常驻在转写区之上）");

  // 只比下标不够：页头若被放进一个 **row** 容器，就会排到转写区**左侧**
  // （390px 上它按内容撑宽，转写区被挤到右边 —— 审查就是这么发现的）。
  // 所以解析出页头的**直接父元素**并断言它是列方向。用启发式（"前一个带 className 的 div"）
  // 会被中间的自闭合 overlay 之类骗到，这里按标签配对算包围链。
  const headerChain = ancestorClassNames(source, header);
  const scrollerChain = ancestorClassNames(source, scroller);
  assert.ok(headerChain.length > 0, "没找到页头所在的布局容器");
  assert.match(headerChain[0], /flex/, "布局容器应该是 flex");
  // ①页头所在的容器必须是**列方向**：容器默认 row 会把页头排到转写区左边
  //（390px 上它按内容撑宽，转写区被挤到右边 —— 审查发现的原始形态）。
  assert.match(headerChain[0], /flex-col/, "页头与转写区共用的容器必须是列方向，否则页头会排到转写区左边");
  // ②页头所在的容器要是转写区所在容器的**祖先**：这样页头才在转写区之上，
  // 而不是被挪到欢迎页分支或别的分支里（那样转写区就没有页头了）。
  assert.deepEqual(
    scrollerChain.slice(-headerChain.length),
    headerChain,
    "页头必须在转写区的祖先链上（页头在转写区之上、且常驻）",
  );

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
// ---------------------------------------------------------------------------
// widget 鼠标路由（issue #103）
//
// 两条结构事实必须锁住：
// 1) 点击只挂在**正文区**（插件的渲染区），卡片头（折叠按钮）永远归我们的外壳；
// 2) 只有 widget 声明了 interactive（组件真的实现了 handleMouse）才把处理函数传下去，
//    否则一次点击都不发 —— 避免给未实现鼠标的组件付无谓往返。
// ---------------------------------------------------------------------------

test("widget 鼠标：只有 interactive 的 widget 才挂点击，卡片头不参与路由", () => {
  const source = readFileSync(fileURLToPath(new URL("./ChatWindow.tsx", import.meta.url)), "utf8");
  const body = source.slice(source.indexOf("function ExtensionWidgetBody("), source.indexOf("function ExtensionWidgets("));
  const widgets = source.slice(source.indexOf("function ExtensionWidgets("), source.indexOf("const COLLAPSED_WIDGET_KEYS_STORAGE"));

  // 1) 正文区按 interactive 决定
  assert.match(
    widgets,
    /onWidgetMouse=\{widget\.interactive === true \? onWidgetMouse : undefined\}/,
    "正文区未按 interactive 决定是否转发",
  );
  // 2) 卡片头（折叠按钮）不带任何鼠标转发：它只做折叠。
  //    取第一个 <button>…</button> 整块（该切片里的第一个就是折叠头）。
  const buttonStart = widgets.indexOf("<button");
  const buttonEnd = widgets.indexOf("</button>", buttonStart) + "</button>".length;
  const header = widgets.slice(buttonStart, buttonEnd);
  assert.ok(buttonStart !== -1 && buttonEnd > buttonStart, "没找到卡片头按钮");
  assert.ok(header.includes("toggleCollapse(widget.key)"), "卡片头应只做折叠");
  assert.ok(header.includes("aria-expanded"), "卡片头要有 aria-expanded（无障碍不能丢）");
  assert.ok(!header.includes("onWidgetMouse"), "卡片头不得转发 widget 鼠标事件");
  // 卡片头只该有折叠用的 onClick：不应出现任何 move/touch 类处理（那些是正文区的事）
  assert.ok(!/onMouse|onTouch/.test(header), "卡片头不得有 move/touch 类鼠标处理");

  // 3) 正文区自身才是坐标原点：换算读的是同一个元素
  assert.match(body, /const el = event\.currentTarget/, "换算必须基于被点元素本身");
  assert.match(body, /measureCharWidth\(el\)/, "字符宽必须量正文区自己（与 render 同源）");
  assert.match(body, /measureLineHeight\(el\)/, "行高必须量正文区自己");
  // 4) 量不出不转发（不给插件送错坐标）
  assert.match(body, /if \(!point\) return;/, "换算失败必须放弃这次点击");
  // 5) 滚动不拦：不出现 wheel/move 的事后 preventDefault
  assert.ok(!/onWheel/.test(body), "不得拦滚动");
  assert.ok(!/onMouseMove/.test(body), "不转 move");
});

test("widget 鼠标：长按映射右键且吃掉补发的 click", () => {
  const source = readFileSync(fileURLToPath(new URL("./ChatWindow.tsx", import.meta.url)), "utf8");
  const body = source.slice(source.indexOf("function ExtensionWidgetBody("), source.indexOf("function ExtensionWidgets("));
  assert.match(body, /consumeTapClick\(touchRef\.current\)/, "补发的 click 必须经由 consumeTapClick 判定");
  assert.match(body, /button: "right"/, "长按要映射成右键");
  assert.match(body, /WIDGET_LONG_PRESS_MS/, "长按计时用共享常量");
  assert.match(body, /isScrollGesture\(dx, dy\)/, "滑动必须取消长按（滚动优先）");
});