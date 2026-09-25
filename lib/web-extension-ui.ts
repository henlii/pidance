/**
 * Pi ExtensionUIContext → Pidance Web 事件适配器。
 * 对齐 RPC mode 的 request/response 协议字段，供 SdkSessionHost 注入 bindExtensions。
 */
import { randomUUID } from "node:crypto";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import {
  createHeadlessCustomUiTui,
  DEFAULT_CUSTOM_UI_ROWS,
} from "./custom-ui-terminal";
import { getAgentDir } from "./pi-paths";
import { getPidancePrefsBus } from "./pidance-prefs-bus";
import { updatePidancePref } from "./pidance-prefs-file";
import { listPiThemes, loadPiThemeByName, setPiTheme } from "./pi-theme-registry";
import {
  createLivePiTheme,
  loadPiTheme,
  onPiThemeChange,
  RENDER_WIDTH,
  renderWidgetComponentLines,
} from "./tui-render-bridge";
import type { ExtensionUiCustomLayout } from "./types";

/**
 * 能力提示快照的上限。
 *
 * 取舍：宿主能力提示的种类是**枚举**（现在公开面一共 5 种：setFooter、setHeader、
 * addAutocompleteProvider、setEditorComponent、onTerminalInput），
 * 远小于这个 16 条上限，所以正常永远截不到。
 * 保留上限只是防止将来有人拿新 feature 名反复调用（把 API 当循环用）让状态快照无界增长。
 * 截断保留**最新**的：最旧的、可能还没被用户看见的那条会先丢——在 5 种枚举的现实下
 * 不会发生；真发生了也只丢"旧提示"，不会让状态无界。改成无上限是错的（状态会被插件撑着）。
 */
export const MAX_CAPABILITY_NOTICES = 16;

/**
 * `setTheme` 失败提示的去重上限。
 *
 * 坏主题名是**任意字符串**（不像能力名那样是枚举），所以上限是防插件循环调用把状态撑起来。
 */
export const MAX_REJECTED_THEME_ERRORS = 16;

/** 追加一条能力提示并按上限截断（保留最新）。导出只为单测覆盖上限行为。 */
export function appendCapabilityNotice<T>(list: T[], item: T, max = MAX_CAPABILITY_NOTICES): void {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

/**
 * `ctx.ui.custom(factory, options)` 的 overlay 选项 → Web 面板布局。
 *
 * 非 overlay（未声明或 `overlay: false`）返回 null，面板走既有的全屏模态渲染 ——
 * pi-subagents 的 SelectorComponent 就是这种（它要求替换 editor 区域）。
 *
 * `overlayOptions` 为函数形式（可随终端尺寸变化重新求值）时不求值：Web 只在打开
 * 时取一次，求值时机与 pi-tui 每帧重算不同，宁可不给尺寸也不给错的。
 */
function normalizeCustomOverlayLayout(options: unknown): ExtensionUiCustomLayout | null {
  if (!options || typeof options !== "object") return null;
  const opts = options as { overlay?: unknown; overlayOptions?: unknown };
  if (opts.overlay !== true) return null;

  const source =
    opts.overlayOptions && typeof opts.overlayOptions === "object"
      ? (opts.overlayOptions as Record<string, unknown>)
      : {};
  const layout: ExtensionUiCustomLayout = {
    anchor: typeof source.anchor === "string" ? source.anchor : "center",
  };

  const width = source.width;
  if (typeof width === "number" || typeof width === "string") layout.width = width;
  if (typeof source.minWidth === "number") layout.minWidth = source.minWidth;
  const maxHeight = source.maxHeight;
  if (typeof maxHeight === "number" || typeof maxHeight === "string") layout.maxHeight = maxHeight;

  const margin = source.margin;
  if (typeof margin === "number") {
    layout.margin = margin;
  } else if (margin && typeof margin === "object") {
    const raw = margin as Record<string, unknown>;
    const sides: { top?: number; right?: number; bottom?: number; left?: number } = {};
    for (const side of ["top", "right", "bottom", "left"] as const) {
      if (typeof raw[side] === "number") sides[side] = raw[side] as number;
    }
    layout.margin = sides;
  }

  return layout;
}

/**
 * 传给扩展自定义 UI 回调的 keybindings（第 3 个参数）。
 *
 * 扩展用 `keybindings.matches(data, "tui.select.up")` 这类键名判断按键，传空对象会让
 * 第一次按键抛 TypeError（被 catch 吞掉，表现为面板对键盘毫无响应且无错误提示）。
 * 键名定义取 pi-tui 的 TUI_KEYBINDINGS；pi 的应用级键位（如 app.editor.external）
 * 不在其中，那几个 matches 恒为 false。
 */
const extensionKeybindings = new KeybindingsManager(TUI_KEYBINDINGS);

export type ExtensionUiEmit = (event: Record<string, unknown>) => void;

export type PendingExtensionRequest = {
  resolve: (response: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

/**
 * 阻塞请求是怎么结束的（`extension_ui_settled` 的 reason）。
 *
 * - `responded`：浏览器回的响应（多标签下别的标签也据此收起面板）；
 * - `timeout` / `abort`：宿主按取消结算（select/input → undefined，confirm → false）；
 * - `disposed`：适配器释放（会话宿主销毁）；
 * - `failed`：响应解析失败。
 */
export type ExtensionUiSettleReason = "responded" | "timeout" | "abort" | "disposed" | "failed";

type CustomUiSession = {
  handleInput: (data: string) => void;
  handleMouse: (event: Record<string, unknown>) => void;
  done: (result?: unknown) => void;
};

export type WebExtensionUIAdapter = {
  uiContext: ExtensionUIContext;
  pending: Map<string, PendingExtensionRequest>;
  /** 当前 status/widget 快照（get_state 重建） */
  statuses: Map<string, string>;
  widgets: Map<string, unknown>;
  pendingSnapshot: Map<string, Record<string, unknown>>;
  /**
   * 当前活动的 custom 面板快照（最后一次渲染行）。
   *
   * 普通阻塞请求走 pendingSnapshot，但 custom 只有「事件」没有快照：
   * 刷新/切回来时服务端仍在等输入，浏览器却拿不到内容与输入入口。
   * 这里保存最后可重放的投影，由 get_state 下发恢复。
   */
  customSnapshot: { id: string; lines: string[]; layout?: ExtensionUiCustomLayout; hidden?: boolean } | null;
  respond: (id: string, response: Record<string, unknown>) => boolean;
  inputCustom: (id: string, data: string) => boolean;
  /** 面板内的鼠标事件（pi-subagents 的 widget 靠它点标题行折叠）。 */
  inputCustomMouse: (id: string, event: Record<string, unknown>) => boolean;
  /** 按新的可用尺寸重排已挂载的插件界面（custom 面板 + widget 工厂）。 */
  setRenderSize: (size: { width: number; rows: number }) => boolean;
  /**
   * 把前端的一个按键交给插件注册的全局监听器（对齐 pi-tui 的 addInputListener：
   * 逐个调用，`consume` 结束传播，`data` 改写后续输入；改写成空串则丢弃）。
   */
  dispatchTerminalInput: (data: string) => { consumed: boolean; data?: string };
  /**
   * 已注册的插件全局按键监听器数量（只读）。
   *
   * 宿主的状态投影用它做按键窄口子的门槛；只给数量，不给集合本身——
   * 监听器只该由 `dispatchTerminalInput` 逐个调用。
   */
  readonly terminalInputListenerCount: number;
  /**
   * 插件自定义的「收起的思考块」标签（只读）。
   *
   * null = 未设置（客户端用我们自己的 i18n 文案）。宿主的**状态投影**要用它：
   * 插件一般在扩展加载时设一次，而那一刻浏览器常常还没订阅（与
   * terminalInputListenerCount / capabilityNoticeSnapshot 同一类一次性事件）。
   */
  readonly hiddenThinkingLabel: string | null;
  /**
   * 宿主自己发出的能力提示快照（只读）。
   *
   * 宿主的状态投影用它重放给后加载的页面；只重放宿主的能力提示，
   * **不含**插件自己调的 `notify`（那是一次性通知，重放会每次开页面都重弹）。
   */
  readonly capabilityNoticeSnapshot: { id: string; message: string; notifyType: "warning" }[];
  /**
   * 客户端上报主编辑器（Web 输入框）的焦点。返回是否发生了变化。
   *
   * 注入后插件读到的 `tui.focusedComponent` 才有值（鸭子类型探针）；
   * 不注入就永远 undefined，插件的「编辑器有焦点」分支永远不成立。
   */
  setEditorFocus: (focused: boolean, clientId?: string) => boolean;
  dispose: () => void;
};

type DialogOpts = {
  signal?: AbortSignal;
  timeout?: number;
};

/**
 * 宿主能接受的 timeout 上限（毫秒）。
 *
 * 取 32 位有符号整数上限：Node 对更大的延迟会把它当成 1ms **立刻触发**，而按同一个
 * 数字算出的 `expiresAt` 却是很远的未来 —— 面板上的倒计时还在走，宿主已经按取消结算了。
 */
export const MAX_DIALOG_TIMEOUT_MS = 2_147_483_647;

/**
 * 收口宿主给的 timeout。
 *
 * - 非有限值 / 非数字 / ≤ 0 → 不设超时（与 TUI 一致：`timeout > 0` 才计时；
 *   负数在这里是 truthy，直接透传会 arm 一个立刻触发的定时器）；
 * - 超过上限 → 截到上限，**定时器与 expiresAt 用同一个收口后的值**。
 */
export function normalizeDialogTimeout(timeout: unknown): number | null {
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return null;
  return Math.min(Math.floor(timeout), MAX_DIALOG_TIMEOUT_MS);
}

/**
 * 主题副本加载失败时的存根（issue #72）。
 *
 * 只有在 `loadPiTheme()` 返回 null（`lib/pi-themes/dark.json` 解析失败）时才会用到：
 * 那种情况下真 Theme 的成员全都不可用，插件拿到什么都画不出颜色。这里给一层
 * 「原样返回文本」的实现，让插件仍然跑得下去。
 *
 * **刻意不做成 Proxy**：之前对所有属性一律返回可调用透传，会把 `sourcePath` 这类
 * 数据字段也变成函数（`if (theme.sourcePath)` 恒真）。数据字段就是数据字段——
 * 缺失即 `undefined`，与终端里的语义一致。
 */
export function createFallbackThemeStub(): Record<string, unknown> {
  const passthrough = (text: unknown) => String(text ?? "");
  const color = (_name: unknown, text?: unknown) => (text === undefined ? "" : String(text));
  return {
    name: undefined,
    sourcePath: undefined,
    sourceInfo: undefined,
    fg: color,
    bg: color,
    bold: passthrough,
    dim: passthrough,
    italic: passthrough,
    underline: passthrough,
    inverse: passthrough,
    strikethrough: passthrough,
    getFgAnsi: () => "",
    getBgAnsi: () => "",
    getColorMode: () => "truecolor" as const,
    getThinkingBorderColor: () => passthrough,
    getBashModeBorderColor: () => passthrough,
  };
}

function createDialogPromise<T>(
  pending: Map<string, PendingExtensionRequest>,
  pendingSnapshot: Map<string, Record<string, unknown>>,
  emit: ExtensionUiEmit,
  opts: DialogOpts | undefined,
  defaultValue: T,
  request: Record<string, unknown>,
  parse: (response: Record<string, unknown>) => T,
): Promise<T> {
  const id = randomUUID();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    /**
     * 结算后立刻告诉浏览器「这个 id 结束了」。
     *
     * 阻塞面板的消失**只由服务端驱动**：客户端按自己的时钟关会和宿主分叉（手机与
     * 会话宿主不是同一块钟），而等下一次状态投影在运行中要 15s、空闲且流还活着最长
     * 120s —— 面板会挂着不走（倒计时到 0 还在，插件早已按取消继续了）。
     * 每条结算都发（含「浏览器自己回的那条响应」）：多标签下响应只从一个标签发出，
     * 别的标签的面板同样要立刻消失，而不是等下一次投影。
     */
    const emitSettled = (reason: ExtensionUiSettleReason) => {
      emit({ type: "extension_ui_settled", id, reason });
    };

    const cleanup = () => {
      pending.delete(id);
      pendingSnapshot.delete(id);
      if (timeoutId) clearTimeout(timeoutId);
      opts?.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (value: T, reason: ExtensionUiSettleReason) => {
      if (settled) return;
      settled = true;
      cleanup();
      // 先告诉浏览器，再 resolve：插件可能紧接着再发一条请求，顺序反了会让旧面板
      // 挂在新请求之上。
      emitSettled(reason);
      resolve(value);
    };

    const onAbort = () => finish(defaultValue, "abort");

    opts?.signal?.addEventListener("abort", onAbort, { once: true });
    // 超时 = 取消（SDK 语义）：到点按 defaultValue 结算（select/input → undefined，
    // confirm → false）。绝对过期时刻与这个定时器**同一个来源**（都用收口后的
    // timeoutMs），客户端只按 expiresAt 每次重算剩余秒数，不下发「剩余毫秒」让它
    // 自己递减：页面挂起或后台节流之后递减值会漂移，重算则始终与宿主一致。
    const timeoutMs = normalizeDialogTimeout(opts?.timeout);
    const expiresAt = timeoutMs === null ? null : Date.now() + timeoutMs;
    if (timeoutMs !== null) {
      timeoutId = setTimeout(() => finish(defaultValue, "timeout"), timeoutMs);
    }

    pending.set(id, {
      resolve: (response) => {
        try {
          finish(parse(response), "responded");
        } catch (error) {
          if (settled) return;
          settled = true;
          cleanup();
          emitSettled("failed");
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        emitSettled("disposed");
        reject(error);
      },
    });

    const event = {
      type: "extension_ui_request",
      id,
      ...request,
      ...(expiresAt === null ? {} : { expiresAt }),
    };
    pendingSnapshot.set(id, event);
    emit(event);
  });
}

export interface WebExtensionUiOptions {
  /**
   * 读当前输入框（草稿）的文本，供 `ctx.ui.getEditorText()` 回传。
   *
   * 由宿主注入而不是在这里直接读偏好文件：适配器不该知道宿主的存储形状，
   * 测试也能给一个假读取器。省略即恒返回空串（与注入前一致）。
   */
  readComposerText?: () => string;
  /**
   * agent 目录：用户主题目录（`<agentDir>/themes`）与壳的亮/暗偏好都按它解析。
   * 省略时取默认 agent 目录（与 SDK 的 `getCustomThemesDir` 同源）。
   */
  agentDir?: string;
}

/**
 * 创建 Web Extension UI 适配器。emit 将事件推给浏览器 SSE。
 */
export function createWebExtensionUIAdapter(
  emit: ExtensionUiEmit,
  options: WebExtensionUiOptions = {},
): WebExtensionUIAdapter {
  const pending = new Map<string, PendingExtensionRequest>();
  const pendingSnapshot = new Map<string, Record<string, unknown>>();
  const statuses = new Map<string, string>();
  const widgets = new Map<string, unknown>();
  const customSessions = new Map<string, CustomUiSession>();
  let customSnapshot: { id: string; lines: string[]; layout?: ExtensionUiCustomLayout; hidden?: boolean } | null =
    null;

  /** 扩展请求的全局工具展开态（pi-subagents 跑子代理前会 setToolsExpanded(false)）。 */
  let toolsExpanded = false;

  /** 用户主题目录与壳的亮/暗偏好都按这个 agent 目录解析。 */
  const agentDir = options.agentDir ?? getAgentDir();

  /**
   * 插件注册的自定义编辑器工厂（`ctx.ui.setEditorComponent`）。
   *
   * 只存不用：Web 输入区是自己的 React 组件，插件工厂在这里没有渲染入口（已提示降级）。
   * 但它必须能被 `getEditorComponent()` 读回去，否则「包裹上一个编辑器」的插件写法断链。
   */
  let editorComponentFactory: unknown;

  /**
   * 插件自定义的「收起的思考块」标签（ctx.ui.setHiddenThinkingLabel）。
   *
   * TUI 语义：思考收起时那一行只画这个标签（默认 "Thinking..."），展开才画正文。
   * Web 上折叠态那一行正是同一位置，所以标签替代折叠行摘要；展开态照旧显示真实
   * 思考内容 —— 标签不会让内容消失，只是收起时不显示。
   *
   * 适配器一会话一个，所以「切会话要重置」由构造方式保证，不需要额外清账。
   */
  let hiddenThinkingLabel: string | null = null;

  /**
   * 当前渲染尺寸：前端按可用宽高上报，插件组件按它排版与裁切（见 setRenderSize）。
   * 两个维度必须同源 —— columns 是真值而 rows 是常量时，按行数裁切的插件会把
   * 本可以显示的行真丢掉（裁掉的行不在输出里）。
   */
  let renderWidth = RENDER_WIDTH;
  let renderRows = DEFAULT_CUSTOM_UI_ROWS;

  /** custom 面板的重渲入口（setRenderSize 用）：按当前尺寸重渲并下发。 */
  const customRenderers = new Set<() => void>();

  /**
   * 传给 widget / custom 工厂的主题**视图**：每次取色都解析当前主题。
   *
   * 不能把当时的实例闭进工厂：组件实例是常驻的（工厂只调一次，之后靠 requestRender
   * 重渲），而主题实例的颜色在构造时就定了 —— 闭实例会让「切主题」只在下次挂载才生效。
   * 主题副本加载失败时退回存根（与 `ui.theme` 同一口径）。
   */
  const liveThemeView = createLivePiTheme(createFallbackThemeStub);

  /**
   * 主题是**进程级**的：任何会话切主题，本适配器已挂的 widget / custom 面板都要重渲一帧，
   * 否则它们会保留旧主题的颜色（工厂拿到的是视图，重渲才会按新主题取色）。
   * 工具行的重渲由各 host 自己订阅（见 lib/sdk-session-host.ts）。
   */
  const unsubscribeThemeChange = onPiThemeChange(() => {
    for (const entry of [...widgetFactories.values()]) entry.requestRender();
    for (const render of [...customRenderers]) render();
  });

  /** 每个能力只提示一次：插件可能反复调用同一条 API（注册监听器、重复设组件）。 */
  const capabilityNoticesSent = new Set<string>();

  /**
   * 已发出的**能力提示**（宿主自己发的降级提示，不是插件调的 notify）。
   *
   * 为什么必须留下来：它们走一次性 SSE 事件，而 host 启动、扩展加载、注册监听器
   * 都发生在浏览器订阅之前 —— 那一刻没有订阅者，事件直接丢掉，这条"可见降级"
   * 提示在实践中用户永远看不到（实测：服务端日志 5 次、页面 DOM 0 次）。
   * 宿主的状态投影把它当作可重放快照下发，后加载的页面才看得到（与
   * pendingExtensionRequests / activeCustomUi 同一手法）。
   *
   * 只重放能力提示：插件自己调的 notify 是一次性通知，重放会让它每次开页面都重弹。
   */
  const capabilityNotices: { id: string; message: string; notifyType: "warning" }[] = [];
  const recordCapabilityNotice = (id: string, message: string) => {
    appendCapabilityNotice(capabilityNotices, { id, message, notifyType: "warning" as const });
  };

  /** 插件的全局按键监听（ctx.ui.onTerminalInput）。 */
  type TerminalInputListener = (data: string) => { consume?: boolean; data?: string } | undefined;
  const terminalInputListeners = new Set<TerminalInputListener>();

  const emitTerminalInputListeners = () => {
    emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "terminalInputListeners",
      count: terminalInputListeners.size,
    });
  };

  /**
   * 主编辑器焦点状态（客户端在聚焦/失焦/切后台时上报，带本标签的 clientId）。
   *
   * 按 clientId 做**「任一标签聚焦即聚焦」**：多标签下后台标签的失焦/隐藏上报
   * 不能把前台标签的焦点一起清掉（旧实现是单槽 last-write，谁最后上报算谁的）。
   * 每项带 TTL：标签页被直接关掉时没有心跳，焦点必须自己过期，否则插件会永远
   * 以为编辑器有焦点。路由按键那条命令会在同一请求里刷新焦点，正常使用不会过期。
   */
  const EDITOR_FOCUS_TTL_MS = 60_000;
  const editorFocusClients = new Map<string, number>();
  const pruneEditorFocus = (now: number) => {
    for (const [clientId, expiresAt] of editorFocusClients) {
      if (expiresAt <= now) editorFocusClients.delete(clientId);
    }
  };
  const isEditorFocused = () => {
    pruneEditorFocus(Date.now());
    return editorFocusClients.size > 0;
  };

  const setEditorFocus = (focused: boolean, clientId: string = "default"): boolean => {
    const wasFocused = isEditorFocused();
    if (focused) editorFocusClients.set(clientId, Date.now() + EDITOR_FOCUS_TTL_MS);
    else editorFocusClients.delete(clientId);
    if (wasFocused === isEditorFocused()) return false;
    // 焦点会改变插件组件的形态：让挂了工厂的 widget 与 custom 面板重渲一帧。
    for (const entry of [...widgetFactories.values()]) entry.requestRender();
    for (const render of [...customRenderers]) render();
    return true;
  };

  /**
   * 插件调用了 Web 端没有等价语义的 UI 能力。
   *
   * 不能静默 no-op：插件作者会以为生效了（例如 setEditorComponent 之后
   * getEditorComponent() 仍是 undefined，包裹链就断了）。也不能每次都提示，
   * 所以每种能力只报一次。文案用英文：这是面向插件生态的诊断信息。
   */
  const notifyUnsupported = (feature: string) => {
    if (capabilityNoticesSent.has(feature)) return;
    capabilityNoticesSent.add(feature);
    console.warn(`[pidance] extension UI capability not supported on web: ${feature}`);
    const id = randomUUID();
    const message = `Extension UI "${feature}" is not supported by the Pidance web client.`;
    recordCapabilityNotice(id, message);
    emit({
      type: "extension_ui_request",
      id,
      method: "notify",
      message,
      notifyType: "warning",
    });
  };

  /**
   * 插件 `ctx.ui.setTheme` 没成功（名字不存在 / 参数类型不对）：回报失败 + 一次可见提示。
   *
   * 为什么不静默：SDK 的 setTheme 遇到坏名字会静默退回 dark，插件与用户都看不出来
   * 主题被换了；Web 这里保留当前主题，把失败说出来（与 notifyUnsupported 同一口径）。
   * 按**错误文案**去重（插件可能在循环里反复调同一个名字）。
   */
  const rejectedThemeErrors = new Set<string>();
  const notifyThemeSwitchFailure = (error: string) => {
    if (rejectedThemeErrors.has(error)) return;
    // 有界：插件拿不同的坏名字循环调用时，不能把适配器状态撑起来（超了就整批忘掉）。
    if (rejectedThemeErrors.size >= MAX_REJECTED_THEME_ERRORS) rejectedThemeErrors.clear();
    rejectedThemeErrors.add(error);
    console.warn(`[pidance] extension setTheme rejected: ${error}`);
    emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "notify",
      message: `Extension UI theme was not applied: ${error}`,
      notifyType: "warning",
    });
  };

  /**
   * 主题切成功后的「壳」那一半：内置 dark/light 同时切壳的明暗（皮肤不变），
   * 用户主题在壳这边没有对应外观，就不动。
   *
   * 服务端先写偏好，客户端**再**收到命令：进程内存里的主题已经是新的了，
   * 只发命令而不落盘的话，刷新后壳会回到旧明暗，而此时插件输出已经是新主题 —— 两边不一致。
   */
  const applyShellTheme = (name: string | undefined) => {
    if (name !== "dark" && name !== "light") return;
    try {
      updatePidancePref("theme.mode", name, agentDir);
      // 偏好是**跨客户端**共享的：走同一条广播流，正在看别的会话的标签/别的设备
      // 不会收到本会话的 SSE 命令（而壳的明暗是进程级的）。
      getPidancePrefsBus().publish({ "theme.mode": name });
    } catch (error) {
      // 写偏好失败不影响**本次**切换（内存主题已换、命令照发）：只是刷新后不保留。
      console.error("[pidance] failed to persist shell theme preference:", error);
    }
    emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "setTheme",
      mode: name,
    });
  };

  /**
   * 插件用了一个 Web 端**只部分支持**的能力。
   *
   * 与 `notifyUnsupported` 的区别：能力本身在（按键确实会送达），只是覆盖面比 TUI 窄。
   * 不说清楚的话，插件作者会把「没收到按键」当成「用户没按」，于是这块交互静默消失
   * ——所以注册时给一次可见提示。同样只报一次，且去重范围就是**这个适配器（这个会话）**：
   * 插件会反复注册监听器，而通知是发往该会话的 SSE —— 放到进程级去重，会让「在没人开着的
   * 会话里注册」那一次丢掉之后永远不再出现。
   *
   * 文案用英文：与 `notifyUnsupported` 同属面向插件生态的诊断信息（客户端也把这类
   * 通知固定成 `Extension warning` / `Extension error` 英文标题，见
   * `hooks/useAgentSession.ts`），不为它单独开一条服务端 → 客户端的文案键协议。
   * **但文案必须与 `lib/extension-panel-keys.ts` 的实际窗口逐字一致** —— 说错窗口
   * 比不说更糟：插件作者会照着一份不存在的契约去设计交互。
   */
  const notifyLimitedSupport = (feature: string, detail: string) => {
    if (capabilityNoticesSent.has(feature)) return;
    capabilityNoticesSent.add(feature);
    const message = `Extension UI "${feature}" is limited by the Pidance web client: ${detail}`;
    console.warn(`[pidance] ${message}`);
    const id = randomUUID();
    recordCapabilityNotice(id, message);
    emit({
      type: "extension_ui_request",
      id,
      method: "notify",
      message,
      notifyType: "warning",
    });
  };

  /**
   * 工厂形式的 widget（如 pi-subagents 的 async widget）：工厂只调用一次、组件实例
   * 常驻，`tui.requestRender()` 触发重新渲染并按 microtask 合并，产出走与字符串数组
   * 相同的 setWidget 通道。渲染失败保留上一次的行（不推空帧）；替换或卸载时调
   * 组件的 `dispose?.()`。
   */
  /** 把 requestRender 存进 entry，供宽度变化时统一重推一帧。 */
  const widgetFactories = new Map<string, { dispose?: () => void; requestRender: () => void }>();

  const unmountWidgetFactory = (key: string) => {
    const entry = widgetFactories.get(key);
    if (!entry) return;
    widgetFactories.delete(key);
    try {
      entry.dispose?.();
    } catch (error) {
      console.error("[pidance] widget dispose failed:", error);
    }
  };

  /**
   * 清掉某个 key 的 widget 投影（含前端）。
   *
   * 卸载后渲染不出来（theme 加载失败、工厂抛错）时必须走这里：否则 widgets 快照与
   * 界面都留着上一个实例的行，看起来像个活着但永远不更新的 widget。
   */
  const clearWidget = (key: string, placement: string | undefined) => {
    if (!widgets.has(key)) return;
    widgets.delete(key);
    emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "setWidget",
      widgetKey: key,
      widgetLines: undefined,
      widgetPlacement: placement,
    });
  };

  const mountWidgetFactory = (
    key: string,
    factory: (tui: unknown, theme: unknown) => unknown,
    placement: string | undefined,
  ) => {
    unmountWidgetFactory(key);
    // 主题还没建起来（宿主还没注入 Theme 类 / 副本坏了）就不挂载：渲染出来的行没有颜色，
    // 不如不挂（与挂载后渲染失败保留旧行的口径不同：这里连首帧都没有）。
    if (!loadPiTheme()) {
      clearWidget(key, placement);
      return;
    }
    // 工厂拿**视图**而不是实例：组件常驻，切主题后的重渲要按当前主题取色。
    const theme = liveThemeView;

    const entry: { dispose?: () => void; requestRender: () => void } = { requestRender: () => {} };
    let component: unknown;
    let scheduled = false;

    const publish = () => {
      scheduled = false;
      // 已被替换或卸载：丢弃这帧，避免把旧 widget 写回去
      if (widgetFactories.get(key) !== entry) return;
      const lines = renderWidgetComponentLines(component, renderWidth);
      if (lines === null) return;
      widgets.set(key, { lines, placement });
      emit({
        type: "extension_ui_request",
        id: randomUUID(),
        method: "setWidget",
        widgetKey: key,
        widgetLines: lines,
        widgetPlacement: placement,
      });
    };

    const tui = createHeadlessCustomUiTui(
      () => {
        if (scheduled || widgetFactories.get(key) !== entry) return;
        scheduled = true;
        queueMicrotask(publish);
      },
      () => renderWidth,
      () => renderRows,
      { isEditorFocused, onUnsupported: notifyUnsupported },
    );
    entry.requestRender = tui.requestRender;

    try {
      component = factory(tui, theme);
    } catch (error) {
      console.error("[pidance] widget factory failed:", error);
      clearWidget(key, placement);
      return;
    }

    const disposable = component as { dispose?: unknown } | null;
    entry.dispose =
      typeof disposable?.dispose === "function"
        ? () => (component as { dispose: () => void }).dispose()
        : undefined;
    widgetFactories.set(key, entry);
    publish();
  };

  const uiContext: ExtensionUIContext = {
    select: (title, options, opts) =>
      createDialogPromise(
        pending,
        pendingSnapshot,
        emit,
        opts,
        undefined,
        { method: "select", title, options },
        (r) =>
          "cancelled" in r && r.cancelled
            ? undefined
            : "value" in r
              ? (r.value as string)
              : undefined,
      ),
    confirm: (title, message, opts) =>
      createDialogPromise(
        pending,
        pendingSnapshot,
        emit,
        opts,
        false,
        { method: "confirm", title, message },
        (r) =>
          "cancelled" in r && r.cancelled
            ? false
            : "confirmed" in r
              ? Boolean(r.confirmed)
              : false,
      ),
    input: (title, placeholder, opts) =>
      createDialogPromise(
        pending,
        pendingSnapshot,
        emit,
        opts,
        undefined,
        { method: "input", title, placeholder },
        (r) =>
          "cancelled" in r && r.cancelled
            ? undefined
            : "value" in r
              ? (r.value as string)
              : undefined,
      ),
    notify(message, type) {
      emit({
        type: "extension_ui_request",
        id: randomUUID(),
        method: "notify",
        message,
        notifyType: type,
      });
    },
    onTerminalInput(handler) {
      // pi-tui 的 addInputListener 是全局的，Web 没有等价的同步键盘通道：
      // 前端只在两个窄窗口里把按键拿过来问（见 hooks/useExtensionTerminalInput.ts
      // 与 hooks/useExtensionWidgetKeys.ts）。注册数量会下发给前端，
      // 没有监听器时前端完全不介入键盘。
      //
      // 覆盖范围必须**告知**（issue #74）：插件注册后可能一个键都收不到，
      // 无从知道是「用户没按」还是「Web 端收不到」，这块交互就静默消失了。
      notifyLimitedSupport(
        "onTerminalInput",
        "handlers only receive keys in two narrow windows: " +
          // 窗口 1：widget 选择态（lib/extension-panel-keys.ts 的 resolveExtensionWidgetKeyAction）
          "(1) with a widget present and the composer focused and empty, Down/Left start a selection, " +
          "after which arrows, j, k, Enter and Escape are routed while the selection lasts; " +
          // 窗口 2：收起的面板（同文件 shouldRouteKeyToExtensionListener）
          "(2) while a collapsed extension panel exists, Escape, F1-F12, Alt+<char> and Ctrl+<char> " +
          "(browser-reserved chords and Ctrl+Space excluded) are routed. " +
          "Ordinary typing never reaches them.",
      );
      terminalInputListeners.add(handler);
      emitTerminalInputListeners();
      return () => {
        if (!terminalInputListeners.delete(handler)) return;
        emitTerminalInputListeners();
      };
    },
    setStatus(key, text) {
      if (text) statuses.set(key, text);
      else statuses.delete(key);
      emit({
        type: "extension_ui_request",
        id: randomUUID(),
        method: "setStatus",
        statusKey: key,
        statusText: text,
      });
    },
    setWorkingMessage(message) {
      // 无参 = 恢复默认文案
      emit({
        type: "extension_ui_request",
        id: randomUUID(),
        method: "setWorkingMessage",
        message: message ?? null,
      });
    },
    setWorkingVisible(visible) {
      emit({
        type: "extension_ui_request",
        id: randomUUID(),
        method: "setWorkingVisible",
        visible: Boolean(visible),
      });
    },
    setWorkingIndicator(options) {
      // 无参 = 恢复默认；frames: [] = 隐藏指示器（pi 的语义）
      emit({
        type: "extension_ui_request",
        id: randomUUID(),
        method: "setWorkingIndicator",
        frames: Array.isArray(options?.frames)
          ? options.frames.filter((frame): frame is string => typeof frame === "string")
          : null,
        intervalMs: typeof options?.intervalMs === "number" ? options.intervalMs : null,
      });
    },
    setHiddenThinkingLabel(label) {
      // 对齐 TUI 的 `label ?? 默认值`；空串我们一并当恢复默认 —— 空标签只会让
      // 折叠行空着，等于把插件原本的意图变成"看不见"。
      const next = typeof label === "string" && label.trim() !== "" ? label : null;
      if (next === hiddenThinkingLabel) return;
      hiddenThinkingLabel = next;
      emit({
        type: "extension_ui_request",
        id: randomUUID(),
        method: "setHiddenThinkingLabel",
        label: next,
      });
    },
    setWidget(key: string, content: unknown, options?: { placement?: string }) {
      // 组件工厂形式：实例常驻 + requestRender 热更新（见 mountWidgetFactory）。
      if (typeof content === "function") {
        mountWidgetFactory(
          key,
          content as (tui: unknown, theme: unknown) => unknown,
          options?.placement,
        );
        return;
      }
      // 换成字符串数组或清除：先卸载可能存在的工厂实例
      unmountWidgetFactory(key);
      if (content === undefined || Array.isArray(content)) {
        if (content == null) widgets.delete(key);
        else {
          widgets.set(key, {
            lines: content,
            placement: options?.placement,
          });
        }
        emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        });
      }
    },
    setFooter(factory) {
      // undefined = 恢复默认；Web 端的 footer 是自有的，本就没有可恢复的替换
      if (factory === undefined) return;
      notifyUnsupported("setFooter");
    },
    setHeader(factory) {
      if (factory === undefined) return;
      notifyUnsupported("setHeader");
    },
    setTitle(title) {
      emit({
        type: "extension_ui_request",
        id: randomUUID(),
        method: "setTitle",
        title,
      });
    },
    async custom(factory, options) {
      // headless custom：调用 Component.render(width) 得到 ANSI 行，再投影到 Web 面板。
      // /btw 等 overlay 扩展依赖 theme.fg/bg 与 requestRender；缺 lines 会让 React 崩页面。
      // options 决定面板是浮层（按插件给的尺寸/锚点）还是全屏模态。
      const id = randomUUID();
      const layout = normalizeCustomOverlayLayout(options);
      return new Promise((resolve) => {
        let doneCalled = false;
        let component: { render?: (width: number) => unknown; handleInput?: (data: string) => void } | undefined;
        const done = (result: unknown) => {
          if (doneCalled) return;
          doneCalled = true;
          customRenderers.delete(emitLines);
          customSessions.delete(id);
          if (customSnapshot?.id === id) customSnapshot = null;
          emit({
            type: "extension_ui_request",
            id,
            method: "custom",
            closed: true,
            lines: [],
          });
          resolve(result as never);
        };
        // 最后一次渲染的行：hidden 切换时要把完整状态重发一遍（前端按事件整体替换）
        let lastLines: string[] = [];
        let hidden = false;
        // hide() 之后面板被永久移除（pi-tui 语义）：后续渲染一律不再下发，
        // 否则插件一次 invalidate 就把「已摘掉」的面板又画回来。
        let removed = false;
        const emitCustom = () => {
          if (removed) return;
          emit({
            type: "extension_ui_request",
            id,
            method: "custom",
            lines: lastLines,
            ...(hidden ? { hidden } : {}),
            ...(layout ? { layout } : {}),
          });
          // 同时保存快照：刷新/切回后由 get_state 恢复面板内容与输入入口。
          // 只保留最新一个（面板同时只应有一个活动 custom）。
          customSnapshot = {
            id,
            lines: [...lastLines],
            ...(hidden ? { hidden } : {}),
            ...(layout ? { layout } : {}),
          };
        };
        const emitLines = () => {
          if (doneCalled) return;
          let lines: string[] = [];
          try {
            const rendered = component?.render?.(renderWidth);
            if (Array.isArray(rendered)) {
              lines = rendered.filter((line): line is string => typeof line === "string");
            }
          } catch (error) {
            console.error("[pidance] custom UI render failed:", error);
          }
          lastLines = lines;
          emitCustom();
        };
        const setHidden = (value: boolean) => {
          const next = Boolean(value);
          if (hidden === next) return;
          hidden = next;
          if (doneCalled) return;
          emitCustom();
        };
        /**
         * 交给插件的 overlay 句柄。Web 端只有一层面板，focus/unfocus 没有
         * 可切换的目标；setHidden 是真效果：前端隐藏面板，插件借此让用户看到
         * 背后的会话内容（rpiv-ask-user 的折叠键就靠它，见它的 set_overlay_hidden）。
         *
         * `hide()` 按 pi-tui 的 OverlayHandle 契约实现：**永久移除，不能再显示**
         * （TUI 是把它从 overlay 栈里 splice 掉，之后 setHidden(false) 不会让它回来）。
         * 之前把它等同于 setHidden(true) 是个语义谎言：插件若在 hide() 之后再
         * setHidden(false)，TUI 里永不复活，我们这里会重新弹出面板。
         * hide() 不 resolve 插件的 await（与 TUI 一致：它只是把 overlay 摘掉）。
         */
        const overlayHandle = {
          hide() {
            if (removed || doneCalled) return;
            removed = true;
            hidden = true;
            customSessions.delete(id);
            if (customSnapshot?.id === id) customSnapshot = null;
            // 前端按 closed 事件拆除面板；插件自己的 promise 仍挂着（TUI 的 hide() 也只摘
            // overlay，不 resolve）。
            emit({
              type: "extension_ui_request",
              id,
              method: "custom",
              closed: true,
              lines: [],
            });
          },
          setHidden(value: boolean) {
            if (removed) return;
            setHidden(value);
          },
          isHidden: () => hidden,
          focus() {},
          unfocus() {},
          isFocused: () => !removed && !hidden,
          getBounds: () => undefined,
        };
        const handleInput = (data: string) => {
          if (data === "\x03") {
            done(undefined);
            return;
          }
          try {
            component?.handleInput?.(data);
          } catch (error) {
            console.error("[pidance] custom UI input failed:", error);
          }
        };
        const handleMouse = (event: Record<string, unknown>) => {
          try {
            (component as { handleMouse?: (e: unknown) => unknown } | undefined)?.handleMouse?.(event);
          } catch (error) {
            console.error("[pidance] custom UI mouse failed:", error);
          }
        };
        customSessions.set(id, { handleInput, handleMouse, done });
        const tui = createHeadlessCustomUiTui(() => {
          emitLines();
        }, () => renderWidth, () => renderRows, { isEditorFocused, onUnsupported: notifyUnsupported });
        customRenderers.add(emitLines);
        // 同样是视图：custom 面板也是常驻组件，切主题后靠重渲换色。
        const theme = liveThemeView;
        // onHandle 在组件建好之后调，对齐 pi-tui 的顺序（先 showOverlay，再给句柄）
        options?.onHandle?.(overlayHandle as never);
        void Promise.resolve()
          .then(() => factory(tui as never, theme as never, extensionKeybindings as never, done))
          .then((created) => {
            if (doneCalled) return;
            component = created as typeof component;
            emitLines();
          })
          .catch((error) => {
            console.error("[pidance] custom UI factory failed:", error);
            done(undefined);
          });
      });
    },
    pasteToEditor(text) {
      this.setEditorText(text);
    },
    setEditorText(text) {
      emit({
        type: "extension_ui_request",
        id: randomUUID(),
        method: "set_editor_text",
        text,
      });
    },
    getEditorText() {
      // SDK 契约（core/extensions/types.d.ts:134）："Get the current text from the
      // core input editor." Web 的「core input editor」是浏览器里的 React 输入框，
      // 宿主进程没有它的同步视图 —— 客户端会把草稿镜像到服务端偏好（400ms 防抖），
      // 宿主注入的读取器读的就是那份镜像：**不新增任何客户端往返**，代价是一次
      // 小文件读（实测 ~0.6ms）。读不到（没有草稿 / 宿主没注入 / 读失败）即空串，
      // 与注入前一致。多标签下草稿按会话键共享（最后写入者胜出），不是「本标签」。
      try {
        return options.readComposerText?.() ?? "";
      } catch (error) {
        console.error("[pidance] readComposerText failed:", error);
        return "";
      }
    },
    async editor(title, prefill) {
      return createDialogPromise(
        pending,
        pendingSnapshot,
        emit,
        undefined,
        undefined,
        { method: "editor", title, prefill },
        (r) =>
          "cancelled" in r && r.cancelled
            ? undefined
            : "value" in r
              ? (r.value as string)
              : undefined,
      );
    },
    addAutocompleteProvider() {
      notifyUnsupported("addAutocompleteProvider");
    },
    setEditorComponent(factory) {
      // undefined = 恢复默认（SDK 类型：EditorFactory | undefined）
      editorComponentFactory = factory;
      if (factory === undefined) return;
      // Web 端不会用这个工厂去渲染输入区，所以仍然要提示一次降级；但**值要存下来**：
      // 插件「包裹上一个编辑器」的写法（先 get 再 set 一个包住它的工厂）依赖它。
      notifyUnsupported("setEditorComponent");
    },
    getEditorComponent() {
      // SDK 契约（core/extensions/types.d.ts:174）：返回**当前配置的**自定义编辑器工厂，
      // 用默认编辑器时是 undefined。之前恒返回 undefined：即使刚 set 成功也读不回来，
      // 包裹链在第一步就断了。
      return editorComponentFactory as never;
    },
    get theme() {
      // 扩展拿到的 theme：直接给**真 Theme**，与 widget / custom / entry 的渲染路径
      // 是同一个实例（`lib/tui-render-bridge.ts` 的 `loadPiTheme()` 模块级缓存）。
      //
      // 为什么不再用 Proxy 包一层（issue #72）：
      // - 之前对所有属性一律返回可调用透传，于是 `theme.sourcePath` / `theme.sourceInfo`
      //   这类**数据字段**也变成函数（`if (theme.sourcePath)` 恒真），插件据此判断
      //   「主题从哪加载」时会被误导。
      // - 真 Theme 的成员本来就齐（name / sourcePath + fg/bg/bold/… + getThinkingBorderColor…），
      //   缺失成员按 `undefined` 处理才是终端语义。
      //
      // 行为变化（有意）：真 `Theme.fg` 对**未知颜色名**会抛错，而旧存根不抛。
      // 插件因此抛错会被渲染桥的 `try/catch` 兜住并回退原文（可见降级），
      // 状态条与 widget 行本来就解析 ANSI，所以真主题的颜色不会变成转义码。
      //
      // 只有主题副本加载失败时才退回存根（见 `createFallbackThemeStub`）。
      return (loadPiTheme() ?? createFallbackThemeStub()) as never;
    },
    getAllThemes() {
      // 内置 dark/light + 用户主题目录（`<agentDir>/themes/*.json`）。
      // 内置主题没有再分文件，所以它们的 `path` 缺省（见 lib/pi-theme-registry.ts）。
      return listPiThemes(agentDir) as never;
    },
    getTheme(name: string) {
      // 只加载不切换（SDK 语义）。未知名 → undefined，不抛错。
      return loadPiThemeByName(name, agentDir) as never;
    },
    setTheme(target: unknown) {
      const result = setPiTheme(target, agentDir);
      if (!result.success) {
        notifyThemeSwitchFailure(result.error ?? "unknown error");
        return { success: false, error: result.error } as never;
      }
      // widget / custom / 工具行的重渲由各自的主题订阅完成（本适配器的订阅见
      // unsubscribeThemeChange，宿主订阅在 lib/sdk-session-host.ts）：这里不再重复触发，
      // 否则一次切换会渲染两遍。
      applyShellTheme(result.name);
      return { success: true } as never;
    },
    getToolsExpanded() {
      return toolsExpanded;
    },
    setToolsExpanded(expanded) {
      toolsExpanded = Boolean(expanded);
      emit({
        type: "extension_ui_request",
        id: randomUUID(),
        method: "setToolsExpanded",
        toolsExpanded,
      });
    },
  };

  return {
    uiContext,
    pending,
    statuses,
    widgets,
    pendingSnapshot,
    get customSnapshot() {
      return customSnapshot;
    },
    /**
     * 已注册的插件全局按键监听器数量（只读）。
     *
     * 宿主的状态投影要用它做按键窄口子的门槛。只暴露数量，不暴露集合本身：
     * 监听器只该由适配器的 `dispatchTerminalInput` 逐个调用。
     */
    get terminalInputListenerCount() {
      return terminalInputListeners.size;
    },
    /**
     * 插件设置的折叠思考标签（只读）。
     *
     * 宿主的 get_state 投影用它水合：插件通常在加载时设一次就不再调用，
     * 页面稍后加载就只能靠快照补回来（与能力提示同一个坑）。
     */
    get hiddenThinkingLabel() {
      return hiddenThinkingLabel;
    },
    /**
     * 已发出的能力提示快照（只读，拷贝）。
     *
     * 宿主的状态投影用它把"宿主自己不具备的能力"重放给后加载的页面。
     * 返回拷贝：调用方只该读，改动内部数组会让快照与已下发的事件不一致。
     */
    get capabilityNoticeSnapshot() {
      return capabilityNotices.map((item) => ({ ...item }));
    },
    respond(id, response) {
      const entry = pending.get(id);
      if (!entry) return false;
      entry.resolve(response);
      return true;
    },
    inputCustom(id, data) {
      const session = customSessions.get(id);
      if (!session) return false;
      session.handleInput(data);
      return true;
    },
    inputCustomMouse(id, event) {
      const session = customSessions.get(id);
      if (!session) return false;
      session.handleMouse(event);
      return true;
    },
    setRenderSize(size) {
      const width = Math.round(size.width);
      const rows = Math.round(size.rows);
      if (!Number.isFinite(width) || width <= 0) return false;
      if (!Number.isFinite(rows) || rows <= 0) return false;
      if (width === renderWidth && rows === renderRows) return false;
      renderWidth = width;
      renderRows = rows;
      // 两个维度一起生效：插件是在同一次 render 里读它们做布局与裁切的。
      for (const render of [...customRenderers]) render();
      for (const entry of [...widgetFactories.values()]) entry.requestRender();
      return true;
    },
    dispatchTerminalInput(data) {
      let current = data;
      for (const listener of terminalInputListeners) {
        let result: { consume?: boolean; data?: string } | undefined;
        try {
          result = listener(current);
        } catch (error) {
          console.error("[pidance] extension terminal input listener failed:", error);
          continue;
        }
        // 与 pi-tui 一致：先看 consume，再看 data 改写
        if (result?.consume) return { consumed: true, data: current };
        if (result?.data !== undefined) current = result.data;
      }
      // 改写成空串等价于丢弄这次输入
      if (current.length === 0) return { consumed: true, data: current };
      return { consumed: false, data: current };
    },
    setEditorFocus,
    dispose() {
      unsubscribeThemeChange();
      editorFocusClients.clear();
      editorComponentFactory = undefined;
      for (const [id, entry] of pending) {
        pending.delete(id);
        pendingSnapshot.delete(id);
        entry.reject(new Error("Extension UI disposed"));
      }
      for (const session of customSessions.values()) {
        session.done(undefined);
      }
      customSessions.clear();
      customSnapshot = null;
      terminalInputListeners.clear();
      for (const key of [...widgetFactories.keys()]) unmountWidgetFactory(key);
      statuses.clear();
      widgets.clear();
    },
  };
}
