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
import { asBracketedPaste } from "./terminal-input";
import { getPidancePrefsBus } from "./pidance-prefs-bus";
import { updatePidancePref } from "./pidance-prefs-file";
import { listPiThemes, loadPiThemeByName, setPiTheme } from "./pi-theme-registry";
import {
  createLivePiTheme,
  loadPiTheme,
  onPiThemeChange,
  RENDER_WIDTH,
  renderMountedComponentOutput,
  renderWidgetComponentLines,
} from "./tui-render-bridge";
import { sameImageFallbacks, sameRenderedImages, type RenderedImage, type RenderedImageFallback, extractKittyImages } from "./kitty-image";
import type {
  CustomPanelBounds,
  CustomPanelFocus,
  ExtensionRenderedImage,
  ExtensionRenderedImageFallback,
  ExtensionUiCustomLayout,
} from "./types";
import {
  buildCompletionChain,
  classifyCompletionSuggestions,
  normalizeAppliedCompletion,
  type CompletionItem,
  type CompletionProvider,
  type CompletionProviderFactory,
  type CompletionSuggestionsOutcome,
} from "./autocomplete-providers";

/**
 * 能力提示快照的上限。
 *
 * 取舍：宿主能力提示的种类是**枚举**（现在公开面只剩两条：onTerminalInput 走
 * notifyLimitedSupport，终端 stdio 让出（tui.stop()/start()）走 notifyUnsupported），
 * 远小于这个 16 条上限，所以正常永远截不到。
 * 保留上限只是防止将来有人拿新 feature 名反复调用（把 API 当循环用）让状态快照无界增长。
 * 截断保留**最新**的：最旧的、可能还没被用户看见的那条会先丢——在个位数枚举的现实下
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
/**
 * 插件是否声明了 `nonCapturing`（pi-tui：这类 overlay 不抢焦点）。
 *
 * 与 normalizeCustomOverlayLayout 同一处解析 overlayOptions，但影响的是**焦点**而不是布局，
 * 所以单独一个函数：并进 ExtensionUiCustomLayout 会把两个不同的问题捆在一起。
 */
function isNonCapturingOverlay(options: unknown): boolean {
  if (!options || typeof options !== "object") return false;
  const opts = options as { overlay?: unknown; overlayOptions?: unknown };
  if (opts.overlay !== true) return false;
  const layout = opts.overlayOptions;
  return (
    typeof layout === "object" &&
    layout !== null &&
    (layout as { nonCapturing?: unknown }).nonCapturing === true
  );
}

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
  /** 客户端上报的面板几何（字符单元格）；见 lib/custom-panel-bounds.ts。 */
  setBounds: (bounds: CustomPanelBounds) => boolean;
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
  customSnapshot: { id: string; lines: string[]; layout?: ExtensionUiCustomLayout; hidden?: boolean; focus?: CustomPanelFocus } | null;
  respond: (id: string, response: Record<string, unknown>) => boolean;
  inputCustom: (id: string, data: string) => boolean;
  /** 面板内的鼠标事件（pi-subagents 的 custom 面板靠它点标题行折叠）。 */
  inputCustomMouse: (id: string, event: Record<string, unknown>) => boolean;
  /**
   * 客户端上报 custom 面板的几何（字符单元格坐标）。
   *
   * 面板的 `getBounds()` 是**同步**接口，插件随时可能读，所以这里存下来而不是回调；
   * 非法报文（见 normalizeCustomBounds）不动已有值 —— 别人的布局不该被一个坏报文清掉。
   */
  setCustomBounds: (id: string, bounds: unknown) => boolean;

  /**
   * widget 组件内的鼠标事件（issue #103）：按 widget key 找到工厂实例，把它实现的
   * `handleMouse` 叫起来。没有该实例、或该组件的渲染结果不是组件（字符串数组 widget）
   * 时返回 false —— 前端据此不发无谓请求。
   */
  inputWidgetMouse: (key: string, event: Record<string, unknown>) => boolean;

  /**
   * 当前自定义编辑器接管的快照（「setEditorComponent」的组件最后一次渲染行）；null = 没接管。
   *
   * 与 customSnapshot 同一个理由：工厂通常在扩展加载时就设好，而那一刻浏览器往往
   * 还没订阅（一次性 SSE 事件直接丢），所以 /state 必须能把接管内容补回来。
   */
  readonly editorTakeoverSnapshot: {
    id: string;
    lines: string[];
    images?: ExtensionRenderedImage[];
    imageFallbacks?: ExtensionRenderedImageFallback[];
  } | null;

  /**
   * 前端在插件编辑器里敲的一个按键/一段粘贴文本。
   *
   * 顺序对齐 pi-tui：**先**过插件的全局按键监听器（可 consume / 改写），未被消费才进
   * 被接管的编辑器组件 —— 终端里监听器本来就在聚焦组件之前。没有接管时返回
   * `{ consumed: false }`（前端据此知道这次没有被消费）。
   */
  dispatchEditorComponentInput: (
    data: string,
    /** 触发这次输入的标签（提交要按它定向，见 editorComponentSubmit 的 clientId）。 */
    clientId?: string,
  ) => { consumed: boolean; data?: string };
  /**
   * 把文本放回**当前接管组件**（组件实现了 setText 时）。
   *
   * 用途：提交失败/早退时把原文交回用户正看着的那块编辑器（它自己已经清空了），
   * 以及用户重新进入接管时把输入框里的草稿灌回去。请求 id 不匹配（接管换过）则不动。
   */
  applyEditorTakeoverText: (requestId: string, text: string) => boolean;
  /**
   * 用户点了「返回输入框」：把组件里的文本交还给**这个标签**的输入框。
   *
   * 只发给发起标签（clientId 定向）：其它标签还显示着接管面板，不该被动改内容。
   */
  dismissEditorTakeover: (requestId: string, clientId?: string) => boolean;
  /**
   * 某个标签上报「本页知道这个接管、并且是否正在显示它」（issue #107 三轮审查）。
   *
   * 两处要用：① 卸下工厂时只把组件文本交给**刚才在显示接管**的标签（否则手机、用户
   * 收起过的标签会被塞进一段它们从没看过的文本）；② 插件**自己**调 onSubmit（没有来源
   * 标签）时，宿主据此挑**恰好一个**归属者，而不是让每个订阅该会话的标签都执行一次。
   */
  recordEditorTakeoverView: (requestId: string, shown: boolean, clientId: string) => void;

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
   * 已注册的自动补全 provider 工厂数量（只读）。
   *
   * 客户端**只在大于 0 时**才为一次输入发补全请求（没注册就零往返）。
   */
  readonly autocompleteProviderCount: number;
  /** 链最终 provider 声明的触发字符（并集；客户端用它决定何时请求）。 */
  readonly autocompleteTriggerCharacters: readonly string[];
  /**
   * 问插件补全链要候选（宿主按客户端请求调用）。
   *
   * 返回四态见 CompletionSuggestionsOutcome：链没注册/抛错/形状坏 → 客户端回退到自己的
   * 文件补全；`empty` 是插件**明确**说没有候选，不回退。
   */
  suggestCompletions: (input: {
    lines: string[];
    cursorLine: number;
    cursorCol: number;
    force?: boolean;
    signal: AbortSignal;
  }) => Promise<CompletionSuggestionsOutcome | { kind: "no-provider" } | { kind: "error" }>;
  /**
   * 应用一个候选：替换区间由插件链自己决定（`applyCompletion`），不由客户端猜。
   * 返回 null 表示插件链没给出可应用的结果（调用方保持文本不变）。
   */
  applyCompletion: (input: {
    lines: string[];
    cursorLine: number;
    cursorCol: number;
    item: CompletionItem;
    prefix: string;
  }) => { lines: string[]; cursorLine: number; cursorCol: number } | null;
  /**
   * 插件自定义的「收起的思考块」标签（只读）。
   *
   * null = 未设置（客户端用我们自己的 i18n 文案）。宿主的**状态投影**要用它：
   * 插件一般在扩展加载时设一次，而那一刻浏览器常常还没订阅（与
   * terminalInputListenerCount / capabilityNoticeSnapshot 同一类一次性事件）。
   */
  readonly hiddenThinkingLabel: string | null;
  /**
   * 页头 / 页脚槽位当前渲染的行（只读拷贝）；null = 没有插件槽位。
   *
   * 与 widget 同理：插件通常在扩展加载时设一次就不再调用，而那一刻浏览器常常
   * 还没订阅（与 hiddenThinkingLabel / capabilityNoticeSnapshot 同一类一次性事件），
   * 所以宿主的 get_state 投影必须能把它水合回去。
   */
  readonly headerLines: string[] | null;
  readonly footerLines: string[] | null;
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
  /**
   * 忘掉「这种槽位已经提示过失败」的记录（宿主在插件 reload 前调用）。
   * 重载后是新组件，再失败应该能重新提示一次。
   */
  resetSlotFailures: () => void;
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
 * 收口客户端上报的面板几何。
 *
 * 只接受**有限整数**且宽高 ≥ 1 的 `{row, col, width, height}`，其余返回 null。
 * 坐标允许为负（面板可以部分在滚动区之外，pi-tui 的 bounds 同样允许），但给一个量级上限：
 * 这份数据被插件用来算命中区域，一个坏报文不该把它撑成天文数字。
 */
export function normalizeCustomBounds(value: unknown): CustomPanelBounds | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const num = (key: string): number | null => {
    const candidate = raw[key];
    return typeof candidate === "number" && Number.isFinite(candidate) ? Math.round(candidate) : null;
  };
  const row = num("row");
  const col = num("col");
  const width = num("width");
  const height = num("height");
  if (row === null || col === null || width === null || height === null) return null;
  if (width <= 0 || height <= 0) return null;
  const MAX_COORDINATE = 10_000;
  if (Math.abs(row) > MAX_COORDINATE || Math.abs(col) > MAX_COORDINATE) return null;
  if (width > MAX_COORDINATE || height > MAX_COORDINATE) return null;
  return { row, col, width, height };
}

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
   * 把文本写进本会话的输入框草稿（issue #107 三轮审查 重要 3 的最后一级兜底）。
   *
   * 只在「插件自己调 onSubmit、而当时一个标签都没上报过」时用：那时没有任何客户端在场
   * 可以执行这次提交，把它写进草稿至少不会静默丢掉（用户下次打开会话就能看到）。
   */
  writeComposerDraft?: (text: string) => void;
  /**
   * agent 目录：用户主题目录（`<agentDir>/themes`）与壳的亮/暗偏好都按它解析。
   * 省略时取默认 agent 目录（与 SDK 的 `getCustomThemesDir` 同源）。
   */
  agentDir?: string;
  /**
   * 时钟。视图新鲜度（编辑器接管的提交归属）要按「最近还在心跳」判定，
   * 测试要能把它推快，所以与 `readComposerText` 一样做成可注入。
   */
  now?: () => number;
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
  let customSnapshot:
    | { id: string; lines: string[]; layout?: ExtensionUiCustomLayout; hidden?: boolean; focus?: CustomPanelFocus }
    | null = null;

  /** 扩展请求的全局工具展开态（pi-subagents 跑子代理前会 setToolsExpanded(false)）。 */
  let toolsExpanded = false;

  /** 用户主题目录与壳的亮/暗偏好都按这个 agent 目录解析。 */
  const agentDir = options.agentDir ?? getAgentDir();

  /** 时钟（可注入，见 WebExtensionUiOptions.now）。 */
  const now = options.now ?? Date.now;

  // 捕获一份引用：`unmountEditorTakeover` 自己的形参也叫 `options`，会遮蔽适配器选项。
  const writeComposerDraftOption = options.writeComposerDraft;

  /**
   * 插件注册的自定义编辑器工厂（`ctx.ui.setEditorComponent`）。
   *
   * 既要能被 `getEditorComponent()` 读回去（「包裹上一个编辑器」的插件写法依赖它），
   * 也要真的挂起来：工厂返回的 `EditorComponent` 会接管**输入框本体**（issue #107）。
   */
  let editorComponentFactory: unknown;

  /**
   * 当前生效的编辑器接管（issue #107）。null = 没接管，客户端用我们自己的输入框。
   *
   * 与 custom 面板的区别：接管的是**输入框本体**（客户端在输入框位置渲染它、关掉自己的
   * 输入框），按键由客户端送回这里进组件的 `handleInput`，提交交回客户端既有发送入口。
   */
  let editorTakeover: {
    id: string;
    component: {
      render?: (width: number) => unknown;
      handleInput?: (data: string) => void;
      dispose?: () => void;
    } | null;
    lines: string[];
    images: ExtensionRenderedImage[];
    imageFallbacks: ExtensionRenderedImageFallback[];
    /** 上一次发进 SSE 帧的图片：没变就不带（base64 不能每帧重发）。 */
    publishedImages: ExtensionRenderedImage[];
    publishedFallbacks: ExtensionRenderedImageFallback[];
  } | null = null;

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
   * 交给编辑器工厂的**编辑器主题**（issue #107）。
   *
   * 不能把插件那个 `Theme` 直接传进去：TUI 交的是 `{ borderColor, selectList }`
   * （interactive-mode 的 `getEditorTheme()`，`theme/theme.js`），插件组件按这个形状取成员 ——
   * 传 Theme 的话 `theme.borderColor(...)` 是 undefined，组件一取色就抛。
   * 与 TUI 的差别：这里每次调用都读**当前**主题（视图会解析到最新那份），切主题后重渲就是新色。
   */
  const editorThemeView = {
    borderColor: (text: string) => liveThemeView.fg("borderMuted", text),
    selectList: {
      selectedPrefix: (text: string) => liveThemeView.fg("accent", text),
      selectedText: (text: string) => liveThemeView.fg("accent", text),
      description: (text: string) => liveThemeView.fg("muted", text),
      scrollInfo: (text: string) => liveThemeView.fg("muted", text),
      noMatch: (text: string) => liveThemeView.fg("muted", text),
    },
  };

  /**
   * 主题是**进程级**的：任何会话切主题，本适配器已挂的 widget / custom 面板都要重渲一帧，
   * 否则它们会保留旧主题的颜色（工厂拿到的是视图，重渲才会按新主题取色）。
   * 工具行的重渲由各 host 自己订阅（见 lib/sdk-session-host.ts）。
   */
  const unsubscribeThemeChange = onPiThemeChange(() => {
    for (const entry of [...widgetFactories.values()]) entry.requestRender();
    for (const render of [...customRenderers]) render();
    for (const kind of SLOT_KINDS) slots[kind]?.requestRender();
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

  /**
   * 把一段终端输入按 pi-tui 的顺序过一遍插件监听器，返回是否被消费与改写后的数据。
   *
   * 两条通道共用它：前端把按键交给**全局监听器**（面板收起 / 面板显示时的窄口子），
   * 以及插件编辑器接管时的输入（监听器先看，未被消费才进聚焦的编辑器组件）。
   */
  const runTerminalInputListeners = (data: string): { consumed: boolean; data?: string } => {
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
  };

  const emitTerminalInputListeners = () => {
    emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "terminalInputListeners",
      count: terminalInputListeners.size,
    });
  };

  /**
   * 插件自动补全的 provider 工厂链（`ctx.ui.addAutocompleteProvider`）。
   *
   * 与 SDK 一样**按注册顺序**依次包裹，链底是 Pidance 的等价物（见 lib/autocomplete-providers.ts）。
   * 每次注册后重建一次链（SDK 的 setupAutocompleteProvider 同样是重建设置，不是增量改）。
   */
  let completionWrappers: CompletionProviderFactory[] = [];
  let completionProvider: CompletionProvider | null = null;
  let completionTriggerCharacters: string[] = [];
  /**
   * **有效**的工厂数：抛错或返回非对象的工厂不算（`buildCompletionChain` 会跳过它们）。
   *
   * 门槛用的是这个而不是 `completionWrappers.length`：唯一一个工厂坏掉时，链只剩基础
   * provider（`getSuggestions` 恒 null），客户端每次输入都要白付一次往返，结果永远是
   * `none` 再回退本地 —— 不如一开始就说「没有 provider」。
   */
  let completionEffectiveCount = 0;

  const rebuildCompletionChain = () => {
    const built = buildCompletionChain(completionWrappers);
    completionProvider = built.provider;
    completionTriggerCharacters = built.triggerCharacters;
    completionEffectiveCount = completionWrappers.length - built.skipped;
  };

  /**
   * 补全能力变化的增量事件：客户端据此决定要不要为一次输入付往返。
   *
   * 与 terminalInputListeners 同一类一次性事件，所以**同时**要有状态投影里的真值
   * （页面在插件注册之后才加载时只能靠水合拿到，见 projectState）。
   */
  const emitCompletionProviders = () => {
    emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "autocompleteProviders",
      count: completionEffectiveCount,
      triggerCharacters: [...completionTriggerCharacters],
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
    // 焦点会改变插件组件的形态：让挂了工厂的 widget、custom 面板**与页头/页脚槽位**
    // 重渲一帧（读 tui.focusedComponent 的页头会随失焦停留旧帧）。
    for (const entry of [...widgetFactories.values()]) entry.requestRender();
    for (const render of [...customRenderers]) render();
    for (const entry of Object.values(slots)) entry?.requestRender();
    return true;
  };

  /**
   * 插件调用了 Web 端没有等价语义的 UI 能力。
   *
   * 现在只剩一条会走到这里：插件把终端 stdio 让出去（tui.stop()/start()，B7 判定不做）。
   * 其它能力（setEditorComponent 等）都已实现，不再提示。
   *
   * 为什么不能静默 no-op：插件作者会以为生效了（例如 external editor 启动后看不到任何东西，
   * 却以为我们已经让出终端）。也不能每次都提示，
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
   * 取接管组件当前的文本（TUI 的写法：`getExpandedText?.() ?? getText()`）。
   *
   * 返回值分两种**语义不同**的情况（issue #107 三轮审查 重要 5）：
   * - `null` = 没有组件 / 读不到 / 读抛错 —— 「我不知道内容是什么」；
   * - `""` = 组件在、内容**就是空的** —— 「我知道，是空的」。
   *
   * 旧实现把两者都压成空串，于是 `getEditorText()` 里 `if (carried)` 把「空的编辑器」
   * 当成「读不到」，回退去读 400ms 防抖的草稿镜像 —— 接管期间那份镜像是陈旧的，
   * 插件拿它判断「输入框是不是空的」（pi-subagents 的 fleet 就是）会判错。
   */
  const readEditorTakeoverText = (entry: { component: unknown }): string | null => {
    const component = entry.component as
      { getExpandedText?: () => unknown; getText?: () => unknown } | null | undefined;
    if (!component) return null;
    try {
      const expanded = component.getExpandedText?.();
      if (typeof expanded === "string") return expanded;
      const plain = component.getText?.();
      if (typeof plain === "string") return plain;
    } catch (error) {
      console.warn("[pidance] extension editor component getText failed:", error);
    }
    return null;
  };

  /**
   * 收掉当前接管并（默认）告诉客户端恢复自己的输入框。
   *
   * `silent` 给 dispose 用：那时宿主正在销毁，没必要再发一帧。
   * 组件实现了 `dispose` 就调（TUI 里换编辑器时也是这么收尾的），抛错不影响我们摘掉它。
   */
  /**
   * 当前正在处理的 editor_component_input 来自哪个标签。
   *
   * 组件的 onSubmit 是在 handleInput 里**同步**被调的，所以用一个同步标记就能把来源带出去；
   * 非客户端来源（插件自己调 onSubmit）保持 null，由正在显示接管的标签兜底执行。
   */
  let submitOriginClientId: string | null = null;

  /**
   * 各标签上报的「本页知道这个接管、是否正在显示它」（clientId → { requestId, shown, at, seq }）。
   *
   * 有上限与时效：这是个只影响「文本交给谁」的辅助表，不该随标签数量无限涨；
   * 超过 TTL 的记录当不存在（标签可以很久不动，但那时它也不该再接收回流）。
   */
  const editorTakeoverViews = new Map<string, { requestId: string; shown: boolean; at: number; seq: number }>();
  // 单调序号：同毫秒内的两次上报也要有确定的「更近」关系（否则归属者会退化成按 id 排序，
  // 与「最近跟这个接管打交道的标签」的语义不一致）。
  let editorTakeoverViewSeq = 0;
  const MAX_EDITOR_TAKEOVER_VIEWS = 64;
  const EDITOR_TAKEOVER_VIEW_TTL_MS = 5 * 60 * 1000;
  /**
   * 「这个标签最近还在心跳」的窗口（issue #107 四轮审查 阻断 1）。
   *
   * 只影响登记表，不进任何下发内容。客户端在显示接管期间每 10s 重报一次（见 ChatWindow 与
   * `startEditorTakeoverHeartbeat`），所以一个还开着的标签始终在这个窗口内（容两次丢包）；
   * 而切走 / 关掉 / 崩溃的标签最多 25s 就不再新鲜 —— 归属挑选（插件自己调 onSubmit）与交还
   * 落点只认新鲜登记，挑不到就走**持久**兜底（写会话草稿），不会把提交定向给一个已经不订阅
   * 这条流的标签后静默丢掉。
   *
   * 残留（已知）：在窗口内的那一小段里，如果恰好挑了那个刚离开、心跳还没过期的标签，这次
   * 提交仍然没有执行者 —— 要彻底消掉需要一条「执行确认」（客户端执行后再回一帧），
   * 本轮没做（见 issue #107 四轮审查报告里的说明）。窗口取 25s 是把这段尽量压小。
   *
   * 客户端的注销（切会话 / 换接管 / 卸载时发 shown=false）会立刻关掉这个窗口；心跳是第二道
   * 防线（漏掉注销时也有界）。注销之所以安全：路由对这条纯登记在**会话不 live 时直接返回**、
   * 不入库也不唤醒（`app/api/agent/[id]/route.ts`）—— 否则为了注销一条登记去 ensureLive 会
   * 唤醒旧宿主、占上写者租约，还会让侧栏把它短暂显示成运行中。
   */
  const EDITOR_TAKEOVER_VIEW_FRESH_MS = 25 * 1000;

  const recordEditorTakeoverView = (requestId: string, shown: boolean, clientId: string): void => {
    if (!requestId || !clientId) return;
    editorTakeoverViews.set(clientId, { requestId, shown, at: now(), seq: ++editorTakeoverViewSeq });
    if (editorTakeoverViews.size > MAX_EDITOR_TAKEOVER_VIEWS) {
      // 先丢最旧的（Map 保持插入序，但 at 会被刷新，所以按 at 排序取最旧）
      const oldest = [...editorTakeoverViews.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) editorTakeoverViews.delete(oldest[0]);
    }
    // 连带清掉过期的：否则一个关掉很久的标签会一直参与归属挑选。
    const cutoff = now() - EDITOR_TAKEOVER_VIEW_TTL_MS;
    for (const [id, view] of editorTakeoverViews) if (view.at < cutoff) editorTakeoverViews.delete(id);
  };

  /**
   * 本页知道这个接管、且（shown 为真时）正在显示它、**并且最近还在心跳**的标签，
   * 最近上报的排在前面。
   *
   * 排序按上报序号（不是时间戳）：同毫秒的两次上报也要有确定的先后，否则「最近跟这个
   * 接管打交道的标签」会退化成按 id 排序 —— 还是确定的，但语义不对。
   *
   * 新鲜度是**必须**的（issue #107 四轮审查 阻断 1）：不新鲜的登记说明那个标签已经不再
   * 心跳（切走 / 关掉 / 崩溃），把提交定向过去只会丢；挑不到就让调用方走持久兜底。
   */
  const editorTakeoverViewers = (requestId: string, onlyShown: boolean): string[] => {
    const freshCutoff = now() - EDITOR_TAKEOVER_VIEW_FRESH_MS;
    return [...editorTakeoverViews.entries()]
      .filter(([, view]) => view.requestId === requestId && view.at >= freshCutoff && (!onlyShown || view.shown))
      .sort((a, b) => b[1].seq - a[1].seq)
      .map(([id]) => id);
  };

  const unmountEditorTakeover = (options?: { silent?: boolean }) => {
    const entry = editorTakeover;
    if (!entry) return;
    // 组件里的文本不能随它一起消失（issue #107 审查 重要 5）：TUI 恢复默认编辑器时
    // 也会先 `currentText = this.editor.getText()` 再灌回默认编辑器。
    const carried = readEditorTakeoverText(entry);
    editorTakeover = null;
    customRenderers.delete(renderEditorTakeover);
    try {
      entry.component?.dispose?.();
    } catch (error) {
      console.warn("[pidance] extension editor component dispose failed:", error);
    }
    if (!options?.silent) {
      emit({ type: "extension_ui_request", id: entry.id, method: "editorComponent", closed: true });
      // 交还给输入框：`closed` 已经先到，客户端那时不再是「正在显示接管」，
      // 所以这条（appliedToTakeover=false）会落进可见的输入框，而不是又被送进组件。
      if (carried) {
        // **只交给刚才在显示这个接管的标签**（issue #107 三轮审查 阻断 2）：广播给所有
        // 「没在显示接管」的标签，会把一段它们从没看过的文本插进手机 / 已收起标签的输入框，
        // 还会和它们正在打的草稿拼在一起。
        const viewers = editorTakeoverViewers(entry.id, true);
        if (viewers.length === 0) {
          // 没有任何**新鲜**的「正在显示」标签：广播之外再写一份持久副本（会话草稿）。
          // 这一帧可能与客户端卸载面板 / 挂载输入框同帧，广播未必落得下去（四轮审查 次要）；
          // 草稿是唯一不依赖投递时机的落点，用户下次打开会话仍能看到这段文本。
          writeComposerDraftOption?.(carried);
          // 没有任何标签上报过（老客户端 / 刚连上还没渲染）：退回一条广播，别让文本消失。
          emit({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "set_editor_text",
            text: carried,
            appliedToTakeover: false,
          });
        } else {
          for (const clientId of viewers) {
            emit({
              type: "extension_ui_request",
              id: randomUUID(),
              method: "set_editor_text",
              text: carried,
              appliedToTakeover: false,
              clientId,
            });
          }
        }
      }
    }
    // 接管没了，登记一并作废（否则新接管会被旧登记误伤）。
    for (const [id, view] of editorTakeoverViews) if (view.requestId === entry.id) editorTakeoverViews.delete(id);
  };

  /**
   * 渲染接管内容并下发。
   *
   * 渲染失败 / 输出非法（组件抛错、返回垃圾）→ **收掉接管**（可见降级：客户端拿回
   * 我们自己的输入框）。不把异常文本贴进输入框：那是把插件私有内容当用户正文送出去。
   */
  const renderEditorTakeover = () => {
    const entry = editorTakeover;
    if (!entry || !entry.component) return;
    let output: { lines: string[]; images: ExtensionRenderedImage[]; fallbacks: ExtensionRenderedImageFallback[] } | null = null;
    try {
      output = renderMountedComponentOutput(entry.component, renderWidth, { allowEmpty: true });
    } catch (error) {
      console.warn("[pidance] extension editor component render failed:", error);
    }
    if (!output) {
      unmountEditorTakeover();
      return;
    }
    entry.lines = output.lines;
    entry.images = output.images;
    entry.imageFallbacks = output.fallbacks;
    const imagesChanged = !sameRenderedImages(entry.publishedImages, entry.images);
    if (imagesChanged) entry.publishedImages = entry.images;
    const fallbacksChanged = !sameImageFallbacks(entry.publishedFallbacks, entry.imageFallbacks);
    if (fallbacksChanged) entry.publishedFallbacks = entry.imageFallbacks;
    emit({
      type: "extension_ui_request",
      id: entry.id,
      method: "editorComponent",
      lines: [...entry.lines],
      // 变了就发（**即使是空数组**：那是「图没了」的显式清空）；没变才省略。
      ...(imagesChanged ? { images: entry.images } : {}),
      ...(fallbacksChanged ? { imageFallbacks: entry.imageFallbacks } : {}),
    });
  };

  /**
   * 前端在插件编辑器里的输入：先过全局监听器（pi-tui 顺序），未被消费才进组件。
   *
   * 抽成局部函数是为了 `pasteToEditor` 也能直接调它（对象字面量里的 `this` 被推断成
   * `ExtensionUIContext`，拿不到兄弟方法）。
   */
  const dispatchEditorInput = (data: string, clientId?: string): { consumed: boolean; data?: string } => {
    const dispatched = runTerminalInputListeners(data);
    if (dispatched.consumed) return dispatched;
    const next = dispatched.data ?? data;
    if (next.length === 0) return { consumed: true, data: next };
    const entry = editorTakeover;
    if (!entry?.component) return { consumed: false, data: next };
    // 组件的 onSubmit 会在 handleInput 里**同步**被调，这里把来源标签放进作用域，
    // 让随之发出的 editorComponentSubmit 只被这个标签执行（多标签不重复发送）。
    const previousOrigin = submitOriginClientId;
    submitOriginClientId = clientId ?? null;
    try {
      entry.component.handleInput?.(next);
    } catch (error) {
      console.warn("[pidance] extension editor component input failed:", error);
    } finally {
      submitOriginClientId = previousOrigin;
    }
    renderEditorTakeover();
    return { consumed: true, data: next };
  };

  /**
   * 挂上插件给的编辑器工厂（`setEditorComponent`）。
   *
   * 与 TUI 的 `setCustomEditorComponent` 对齐：工厂签名 `(tui, theme, keybindings)`，
   * 拿到组件后**覆盖**它的 `onSubmit`（TUI 也这么做：提交即发送，归应用所有），
   * 这里接成「通知客户端提交」——正文由客户端交给既有发送入口，服务端不直接提交。
   * 工厂抛错 / 返回非对象 → 视为没有接管（客户端仍用我们自己的输入框）。
   */
  const mountEditorTakeover = (factory: unknown) => {
    unmountEditorTakeover();
    if (typeof factory !== "function") return;
    const entry = {
      id: randomUUID(),
      component: null,
      lines: [] as string[],
      images: [] as ExtensionRenderedImage[],
      imageFallbacks: [] as ExtensionRenderedImageFallback[],
      publishedImages: [] as ExtensionRenderedImage[],
      publishedFallbacks: [] as ExtensionRenderedImageFallback[],
    };
    editorTakeover = entry;
    let created: unknown;
    try {
      const tui = createHeadlessCustomUiTui(
        () => renderEditorTakeover(),
        () => renderWidth,
        () => renderRows,
        { isEditorFocused, onUnsupported: notifyUnsupported },
      );
      created = (factory as (tui: unknown, theme: unknown, keybindings: unknown) => unknown)(
        tui,
        editorThemeView,
        extensionKeybindings,
      );
    } catch (error) {
      console.warn("[pidance] extension editor component factory failed:", error);
      unmountEditorTakeover();
      return;
    }
    if (!created || typeof created !== "object") {
      unmountEditorTakeover();
      return;
    }
    const component = created as NonNullable<typeof entry.component>;
    // TUI 的接法（interactive-mode 的 setCustomEditorComponent）：**宿主**把默认编辑器的
    // onSubmit / onChange 挂到组件实例上，组件自己调 `this.onSubmit(text)` / `this.onChange(text)`。
    // 所以这两个回调不该由组件提供 —— 我们负责挂上去（挂不上就只警告，不阻断接管）。
    try {
      (component as { onSubmit?: unknown }).onSubmit = (text: unknown) => {
        if (editorTakeover !== entry) return;
        const submitted = typeof text === "string" ? text : String(text ?? "");
        // 归属规则（issue #107 三轮审查 重要 3，保证「恰好一次」）：
        // ① 按键同步提交用**来源标签**（dispatchEditorComponentInput 里同步捕获的）；
        // ② 插件自己调 onSubmit（没有来源）时，交给**最近跟这个接管打过交道、且正在显示
        //    它**的标签；挑不到就退到「知道这个接管」的标签里最近的一个（手机 / 已收起
        //    的标签也有输入框，能执行）；③ 一个标签都没上报过（没人连着）时落进会话草稿
        //    —— 不静默丢，用户下次打开会话就能看到这段文本。
        const owner = submitOriginClientId
          ?? editorTakeoverViewers(entry.id, true)[0]
          ?? editorTakeoverViewers(entry.id, false)[0]
          ?? null;
        if (!owner) {
          if (submitted.trim()) options.writeComposerDraft?.(submitted);
          return;
        }
        emit({
          type: "extension_ui_request",
          id: entry.id,
          method: "editorComponentSubmit",
          text: submitted,
          clientId: owner,
        });
      };
      // onChange 在 TUI 里驱动的是应用自己的记账（默认编辑器那边是「bash 模式」判定）。
      // Web 的对应记账属于**我们自己的输入框**：接管期间它不在场，文本也归插件组件所有，
      // 所以这里挂一个空实现 —— 关键是插件组件能安全地调 `this.onChange(...)`（不撞 undefined）。
      (component as { onChange?: unknown }).onChange = () => {};
    } catch (error) {
      console.warn("[pidance] extension editor component onSubmit is not writable:", error);
    }
    // TUI：`newEditor.setText(currentText)` —— 把切换前的草稿灌进组件。
    // 草稿来源与 getEditorText() 同一份镜像（#74；有 400ms 防抖，滞后是已知取舍）。
    // 接口要求 setText 必选，但插件可能漏实现 → 用 typeof 兜住，漏了就跳过（不阻断接管）。
    // 只在**确实拿到草稿**时才灌：TUI 那次读取是同步的实时文本，我们这份是客户端 400ms 防抖
    // 镜像（#74），读不到与「用户没输入」区分不开 —— 无条件写 "" 会清掉组件自带的初始内容，
    // 还会把「不知道」当成「没有」。空草稿保持组件原状，是有意的取舍。
    try {
      const draft = options.readComposerText?.() ?? "";
      const setText = (component as { setText?: unknown }).setText;
      if (draft !== "" && typeof setText === "function") {
        (setText as (text: string) => void).call(component, draft);
      }
    } catch (error) {
      console.warn("[pidance] extension editor component setText failed:", error);
    }
    // TUI 挂完回调后还会从默认编辑器复制几样：`borderColor`、`setPaddingX`、
    // `setAutocompleteMaxVisible`、`setAutocompleteProvider`（以及 CustomEditor 的 actionHandlers）。
    // Web 这边**有意不做**：我们没有「默认编辑器的那套外观/内边距/补全下拉」可复制 ——
    // 接管面板的边框与壳是我们的（`ExtensionEditorTakeover`），而补全链在浏览器侧
    // （#101 的客户端往返），没法同步喂给跑在服务端的组件。取舍写在这里，避免下次被当成漏项。
    entry.component = component;
    customRenderers.add(renderEditorTakeover);
    renderEditorTakeover();
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
  /**
   * 把 requestRender 存进 entry，供宽度变化时统一重推一帧；`handleMouse` 只在
   * 组件真的实现了它时才存在（前端据 `interactive` 决定要不要把点击送过来）。
   */
  const widgetFactories = new Map<string, {
    dispose?: () => void;
    requestRender: () => void;
    handleMouse?: (event: Record<string, unknown>) => void;
  }>();

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
      widgetImages: [],
      widgetImageFallbacks: undefined,
      widgetPlacement: placement,
      widgetInteractive: false,
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

    const entry: {
      dispose?: () => void;
      requestRender: () => void;
      handleMouse?: (event: Record<string, unknown>) => void;
    } = { requestRender: () => {} };
    let component: unknown;
    let scheduled = false;
    let interactive = false;
    /** 上一次**推给前端**的图片：没变就不重发 base64（几百 KB × 每帧会很贵）。 */
    let publishedImages: RenderedImage[] | undefined;
    /** 降级说明同理：没变就省略；变空要显式发空数组（缺省 = 与上一帧相同）。 */
    let publishedFallbacks: RenderedImageFallback[] | undefined;

    const publish = () => {
      scheduled = false;
      // 已被替换或卸载：丢弃这帧，避免把旧 widget 写回去
      if (widgetFactories.get(key) !== entry) return;
      const output = renderMountedComponentOutput(component, renderWidth);
      if (output === null) return;
      const { lines, images, fallbacks: imageFallbacks } = output;
      // 前端只对 `interactive` 的 widget 挂点击处理：没实现 handleMouse 的组件
      // 不该为每次点击付一次往返（全局能力提示里也说的是「鼠标只在实现了才送达」）。
      widgets.set(key, { lines, images, imageFallbacks, placement, interactive });
      // 图片没变时省略字段（客户端保留上一帧的图）；变了就把新数组发过去（空数组表示「图没了」）。
      const imagesChanged = !sameRenderedImages(publishedImages, images);
      if (imagesChanged) publishedImages = images;
      const fallbacksChanged = !sameImageFallbacks(publishedFallbacks, imageFallbacks);
      if (fallbacksChanged) publishedFallbacks = imageFallbacks;
      emit({
        type: "extension_ui_request",
        id: randomUUID(),
        method: "setWidget",
        widgetKey: key,
        widgetLines: lines,
        widgetImages: imagesChanged ? images : undefined,
        widgetImageFallbacks: fallbacksChanged ? imageFallbacks : undefined,
        widgetPlacement: placement,
        widgetInteractive: interactive,
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

    const disposable = component as { dispose?: unknown; handleMouse?: unknown } | null;
    entry.dispose =
      typeof disposable?.dispose === "function"
        ? () => (component as { dispose: () => void }).dispose()
        : undefined;
    // `interactive` 决定「这个 widget 有没有鼠标能力」（前端据它决定要不要为点击付一次
    // 往返），只在挂载/替换组件时采样**一次**：setWidget 收到组件那一刻还没有 handleMouse
    // 的话，之后再挂上去不会自动变可交互，要重新 setWidget 才会重采样。
    // 真正调用时则**每次再取一次**函数字段（组件可以随时换实现），不是把函数存死。
    interactive = typeof disposable?.handleMouse === "function";
    if (interactive) {
      entry.handleMouse = (event) => {
        const handler = (component as { handleMouse?: (e: Record<string, unknown>) => unknown } | null)?.handleMouse;
        // 抛错只记日志：一次点击不该把 widget 的重渲管线带崩（与渲染失败同一口径）。
        try {
          handler?.call(component, event);
        } catch (error) {
          console.error("[pidance] widget handleMouse failed:", error);
        }
      };
    }
    widgetFactories.set(key, entry);
    publish();
  };

  /**
   * 页头 / 页脚槽位（`ctx.ui.setHeader` / `setFooter`）。
   *
   * 与 widget 共用同一条管线（工厂只调一次、组件常驻、`requestRender` 按 microtask 合并、
   * 产出走渲染桥 → 行），差别只有四点：
   *
   * 1. **一个槽位只放一个组件**：替换时先 `dispose()` 旧的（对齐 SDK —— TUI 的
   *    `setExtensionFooter` 就是先 `customFooter?.dispose()`）。插件的定时器/监听器
   *    挂在组件上，漏掉 dispose 会跟着会话跑。
   * 2. `undefined` 是**恢复内置**而不是「清一个 key」：我们这边对应显示自己的状态条
   *    （页脚）/ 什么都不显示（页头）。
   * 3. 工厂抛错或渲染不出行 → 槽位隐藏 + **每种槽位只提示一次**，且**不把异常文本贴进界面**
   *    （与「插件渲染器失败就隐藏」同一口径）。
   * 4. 页脚工厂的第三个参数（footer 数据）我们**不传**：SDK 的 `ReadonlyFooterDataProvider`
   *    是 git 分支 + 扩展状态 + 可用 provider 数 + 分支变化订阅四件套，Web 侧没有等价物
   *    （git watcher 与 provider 计数都不在会话适配器里）。塞一个只有部分成员的对象比不传更糟：
   *    插件会按类型调用缺失的成员然后抛错。不传 = 插件若真依赖它就会走到上面的「失败 → 隐藏 +
   *    一次提示」，是**可见降级**而不是静默假数据。
   */
  const SLOT_KINDS = ["header", "footer"] as const;
  type SlotKind = (typeof SLOT_KINDS)[number];

  interface SlotEntry {
    /** 最近一次成功渲染的行；null = 当前没有可显示的内容（隐藏）。 */
    lines: string[] | null;
    dispose?: () => void;
    requestRender: () => void;
    /** 组件的 `setExpanded`（TUI 的 isExpandable 页头用它跟随工具展开态）。 */
    setExpanded?: (expanded: boolean) => void;
  }

  const slots: Record<SlotKind, SlotEntry | null> = { header: null, footer: null };
  const slotFailuresReported = new Set<SlotKind>();

  /**
   * 页脚工厂的第三个参数（SDK 的 `ReadonlyFooterDataProvider` 正好是这四个成员，
   * 见 footer-data-provider.d.ts:63）。
   *
   * **不能传 undefined**：官方示例（examples/extensions/custom-footer.ts）在工厂里
   * **无条件**调用 `footerData.onBranchChange(...)`，传 undefined 会让整个页脚工厂抛错、
   * 槽位被我们隐藏 —— 连不依赖 git 的行也一起没。缺成员的假对象确实更糟，但这不是假对象：
   * 每个成员都有真值或诚实的空值。
   *
   * 两个诚实的空值（都不是「假装有数据」）：
   * - `getGitBranch` 恒 `null`：Pidance 目前没有 git 分支来源（宿主自己的状态条也不显示分支），
   *   而 SDK 的实现是带文件观察器的 provider（本模块不 import SDK，也不该起观察器）。
   *   插件拿到 `null` 会按「不在仓库里」渲染。
   * - `getAvailableProviderCount` 恒 `0`：模型目录是**异步**加载的，适配器没有同步计数来源。
   *   真接上需要新的异步通道 + 变化通知，属于新能力。
   */
  const footerData = {
    getGitBranch: () => null,
    getExtensionStatuses: () => statuses,
    getAvailableProviderCount: () => 0,
    onBranchChange: () => () => {},
  };

  const emitSlot = (kind: SlotKind, lines: string[] | null) => {
    emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: kind === "footer" ? "setFooter" : "setHeader",
      lines,
    });
  };

  /** 每种槽位只提示一次：插件可能在循环里反复挂同一个坏组件。 */
  const notifySlotFailure = (kind: SlotKind) => {
    if (slotFailuresReported.has(kind)) return;
    slotFailuresReported.add(kind);
    console.warn(`[pidance] extension UI ${kind} component could not be rendered`);
    const id = randomUUID();
    const message = `Extension UI "${kind}" component could not be rendered; the slot stays hidden.`;
    // 进能力快照（与 notifyUnsupported 同一处理）：页头通常在 session_start 就挂上，
    // 那一刻浏览器还没订阅 SSE，只 emit 的话这条警告会永久丢掉。
    recordCapabilityNotice(id, message);
    emit({
      type: "extension_ui_request",
      id,
      method: "notify",
      message,
      notifyType: "warning",
    });
  };

  const clearSlot = (kind: SlotKind) => {
    const current = slots[kind];
    if (!current) return;
    slots[kind] = null;
    try {
      current.dispose?.();
    } catch (error) {
      console.error(`[pidance] extension ${kind} dispose failed:`, error);
    }
    emitSlot(kind, null);
  };

  const mountSlot = (kind: SlotKind, factory: unknown) => {
    // 替换语义：旧的先 dispose 再挂新的（与 SDK 一致）。
    clearSlot(kind);
    if (typeof factory !== "function") return;
    // 主题没建起来（宿主还没注入 Theme 类 / 副本坏了）就不挂：渲染出来的行没有颜色，
    // 与 widget 挂载同一口径。
    if (!loadPiTheme()) return;

    const entry: SlotEntry = { lines: null, requestRender: () => {} };
    let scheduled = false;
    let component: unknown;

    const publish = () => {
      scheduled = false;
      // 已被替换或清除：丢弃这一帧，别把旧槽位写回去。
      if (slots[kind] !== entry) return;
      // allowEmpty：这一帧渲染出 0 行（插件让页脚自己藏起来）与**渲染失败**是两件事，
      // 前者只是没有内容，后者要隐藏 + 提示一次（见 isValidRenderOutput 的注释）。
      const lines = renderWidgetComponentLines(component, renderWidth, { allowEmpty: true });
      if (lines === null) {
        // 渲染失败：把槽位隐藏（不显示上一次的旧内容），但**保留** entry —— 下一帧
        // 渲染成功就能自己回来（与 widget「保留旧行」不同：槽位是替身，显示过期内容
        // 比空着更容易误导）。
        // null 的含义写清楚：没有 render 方法 / render 抛错 / 输出不是字符串数组或超限。
        console.error(
          `[pidance] extension ${kind} render failed (no render method, threw, or output invalid/over the caps)`,
        );
        entry.lines = null;
        emitSlot(kind, null);
        notifySlotFailure(kind);
        return;
      }
      if (lines.length === 0) {
        // 空帧：隐藏槽位但**不**提示（这是插件的正常状态），保留 entry 等下一帧。
        entry.lines = null;
        emitSlot(kind, null);
        return;
      }
      entry.lines = lines;
      emitSlot(kind, lines);
    };

    const tui = createHeadlessCustomUiTui(
      () => {
        if (scheduled || slots[kind] !== entry) return;
        scheduled = true;
        queueMicrotask(publish);
      },
      () => renderWidth,
      () => renderRows,
      { isEditorFocused, onUnsupported: notifyUnsupported },
    );
    entry.requestRender = tui.requestRender;

    try {
      component = kind === "footer"
        ? (factory as (tui: unknown, theme: unknown, footerData: unknown) => unknown)(tui, liveThemeView, footerData)
        : (factory as (tui: unknown, theme: unknown) => unknown)(tui, liveThemeView);
    } catch (error) {
      console.error(`[pidance] extension ${kind} factory failed:`, error);
      clearSlot(kind);
      notifySlotFailure(kind);
      return;
    }

    const disposable = component as { dispose?: unknown; setExpanded?: unknown } | null;
    entry.dispose =
      typeof disposable?.dispose === "function"
        ? () => (component as { dispose: () => void }).dispose()
        : undefined;
    // TUI 对 isExpandable 的页头会同步工具展开态（interactive-mode.js:1914-1918）。
    if (kind === "header" && typeof disposable?.setExpanded === "function") {
      const expandable = component as { setExpanded: (expanded: boolean) => void };
      entry.setExpanded = (expanded) => expandable.setExpanded(expanded);
      try {
        entry.setExpanded(toolsExpanded);
      } catch (error) {
        console.error("[pidance] extension header setExpanded failed:", error);
      }
    }
    slots[kind] = entry;
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
        "handlers only receive keys in a few narrow windows: " +
          // 窗口 ②：widget 选择态（lib/extension-panel-keys.ts 的 resolveExtensionWidgetKeyAction）
          "(1) with a widget present and the composer focused and empty, Down/Left start a selection, " +
          "after which arrows, j, k, Enter and Escape are routed while the selection lasts; " +
          // 窗口 ①：收起的面板（同文件 shouldRouteKeyToExtensionListener）
          "(2) while a collapsed extension panel exists, Escape, F1-F12, Alt+<char> and Ctrl+<char> " +
          "(browser-reserved chords and Ctrl+Space excluded) are routed; " +
          // 窗口 ③：插件界面显示中（同文件 resolveExtensionSurfaceKeyAction）
          "(3) while a plugin panel, overlay or dialog is visible, keys that no focused field or " +
          "control owns are routed to the handlers as they are (Meta chords, the browser-reserved " +
          "Ctrl chords, Ctrl+Space, the shell's Ctrl+K and Tab stay with the browser). " +
          "Ordinary typing in the composer never reaches them.",
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
        if (content == null) {
          widgets.delete(key);
          // 清除也要发一帧（`widgetLines` 缺省 = 客户端移除该 widget）——
          // 不发的话界面上的旧 widget 会一直留着。
          emit({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "setWidget",
            widgetKey: key,
            widgetLines: undefined,
            widgetPlacement: options?.placement,
            widgetInteractive: false,
          });
        } else {
          // 字符串数组也要摘图：插件可以直接塞 Kitty 序列行（不走组件），
          // 不摘的话 base64 会被当正文显示（ANSI 解析只吃掉 `ESC _` 两个字符）。
          const extracted = extractKittyImages(content);
          // 字符串数组 widget 没有组件实例，也就没有 handleMouse：显式标非交互，
          // 前端不为它挂点击。
          widgets.set(key, {
            lines: extracted.lines,
            images: extracted.images,
            imageFallbacks: extracted.fallbacks,
            placement: options?.placement,
            interactive: false,
          });
          emit({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "setWidget",
            widgetKey: key,
            widgetLines: extracted.lines,
            ...(extracted.images.length > 0 ? { widgetImages: extracted.images } : {}),
            ...(extracted.fallbacks.length > 0 ? { widgetImageFallbacks: extracted.fallbacks } : {}),
            widgetPlacement: options?.placement,
            widgetInteractive: false,
          });
        }
      }
    },
    setFooter(factory) {
      // undefined = 恢复内置页脚（我们自己的状态条）；函数 = 用插件组件替换。
      mountSlot("footer", factory);
    },
    setHeader(factory) {
      mountSlot("header", factory);
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
      // 初始焦点态对齐 pi-tui 的 showOverlay：可见且没声明 nonCapturing 就聚焦 overlay；
      // 声明了 nonCapturing 时焦点留在主编辑器（终端里就是留在输入框）。
      const nonCapturing = isNonCapturingOverlay(options);
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
        let lastImages: ExtensionRenderedImage[] = [];
        let lastImageFallbacks: ExtensionRenderedImageFallback[] = [];
        // 上一次**发进 SSE 帧**的图片：图片没变时省略字段（几百 KB 的 base64 不能每帧重发；
        // 客户端约定「缺省 = 保留上一帧」）。水合快照那份始终是全量 —— 刷新时必须拿得到图。
        let publishedImages: ExtensionRenderedImage[] = [];
        let publishedFallbacks: ExtensionRenderedImageFallback[] = [];
        let hidden = false;
        /** 焦点三态（见 CustomPanelFocus）：默认面板持有。 */
        let focusState: CustomPanelFocus = nonCapturing ? "editor" : "panel";
        /** 客户端上报的几何；null = 还没上报过（此时 getBounds 返回 undefined）。 */
        let bounds: CustomPanelBounds | null = null;
        /** pi-tui 的 `isFocused`：可见 + 未被摘除 + 焦点确实在面板上。 */
        const currentlyFocused = () => !removed && !hidden && focusState === "panel";
        // hide() 之后面板被永久移除（pi-tui 语义）：后续渲染一律不再下发，
        // 否则插件一次 invalidate 就把「已摘掉」的面板又画回来。
        let removed = false;
        const emitCustom = () => {
          if (removed) return;
          // 图片没变就不带（`undefined` = 客户端保留上一帧）：`emitCustom` 会被
          // requestRender / focus / unfocus / setHidden 反复触发，每帧重发整段 base64
          // 会把消息体积放大几个数量级。
          const imagesChanged = !sameRenderedImages(publishedImages, lastImages);
          if (imagesChanged) publishedImages = lastImages;
          const fallbacksChanged = !sameImageFallbacks(publishedFallbacks, lastImageFallbacks);
          if (fallbacksChanged) publishedFallbacks = lastImageFallbacks;
          emit({
            type: "extension_ui_request",
            id,
            method: "custom",
            lines: lastLines,
            // 变了就发（**即使是空数组**：那是「图没了」的显式清空）；没变才省略。
            ...(imagesChanged ? { images: lastImages } : {}),
            ...(fallbacksChanged ? { imageFallbacks: lastImageFallbacks } : {}),
            focus: focusState,
            ...(hidden ? { hidden } : {}),
            ...(layout ? { layout } : {}),
          });
          // 同时保存快照：刷新/切回后由 get_state 恢复面板内容与输入入口。
          // 只保留最新一个（面板同时只应有一个活动 custom）。
          customSnapshot = {
            id,
            lines: [...lastLines],
            ...(lastImages.length > 0 ? { images: lastImages } : {}),
            ...(lastImageFallbacks.length > 0 ? { imageFallbacks: lastImageFallbacks } : {}),
            focus: focusState,
            ...(hidden ? { hidden } : {}),
            ...(layout ? { layout } : {}),
          };
        };
        const emitLines = () => {
          if (doneCalled) return;
          // 走渲染桥的 output 版本：面板组件里的 pi-tui Image 会编码成 Kitty 序列，
          // 必须先摘成结构化图片再下发（同一次渲染的文本上限只作用于文本，见 issue #104）。
          let lines: string[] = [];
          let images: ExtensionRenderedImage[] = [];
          let imageFallbacks: ExtensionRenderedImageFallback[] = [];
          try {
            const output = component ? renderMountedComponentOutput(component, renderWidth) : null;
            if (output) {
              lines = output.lines;
              images = output.images;
              imageFallbacks = output.fallbacks;
            }
          } catch (error) {
            console.error("[pidance] custom UI render failed:", error);
          }
          lastLines = lines;
          lastImages = images;
          lastImageFallbacks = imageFallbacks;
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
          /**
           * 把键盘焦点交给面板 —— 对齐 pi-tui：**不可见/已摘除时什么都不做**
           * （那时 focus 只是 no-op，而不是把藏在后面的面板叫醒）。
           * Web 上「提到最前」没有第二层，实际效果是前端把 DOM 焦点移回面板 keytrap。
           */
          focus() {
            if (removed || hidden) return;
            if (focusState === "panel") return;
            focusState = "panel";
            emitCustom();
          },
          /**
           * 释放焦点 —— 对齐 pi-tui：**当前没聚焦就直接返回**（不去扰动用户已经移走的焦点）。
           *
           * 落点三态：`{ target: null }` → 谁也不聚焦；未给 options → 交回主编辑器
           * （终端里是「打开 overlay 之前的焦点」，Web 上就是输入框）；给了具体组件 →
           * Web 无法聚焦任意组件，按「交回编辑器」处理（唯一另一个可聚焦面）。
           */
          unfocus(options?: { target?: unknown }) {
            if (!currentlyFocused()) return;
            focusState = options && options.target === null ? "none" : "editor";
            emitCustom();
          },
          isFocused: () => currentlyFocused(),
          /**
           * 最后一次上报的几何（同步读，pi-tui 同）：面板不可见 / 已摘除 / 还没上报过 → undefined。
           * 返回**副本**：插件改写它不会污染内部状态。
           */
          getBounds: () => (removed || hidden || bounds === null ? undefined : { ...bounds }),
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
        /**
         * 存客户端上报的几何；返回是否变化（同值不重发，避免观察者回调刷屏）。
         * 面板已经结束/被摘除时不再收：那时的坐标没有意义。
         */
        const setBounds = (next: CustomPanelBounds): boolean => {
          if (removed || doneCalled) return false;
          if (
            bounds &&
            bounds.row === next.row &&
            bounds.col === next.col &&
            bounds.width === next.width &&
            bounds.height === next.height
          ) {
            return false;
          }
          bounds = next;
          return true;
        };
        customSessions.set(id, { handleInput, handleMouse, done, setBounds });
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
      // TUI 把两者分开（interactive-mode）：`pasteToEditor` 是把带括号粘贴标记的文本喂进
      // **当前编辑器**的 `handleInput`，只有 `setEditorText` 才是 `setText`。
      // 接管期间「当前编辑器」就是插件组件 → 走 handleInput，否则会把整段文本当成
      // 「替换全部内容」覆盖掉组件里的内容，而不是插进光标处。
      if (editorTakeover?.component) {
        dispatchEditorInput(asBracketedPaste(text));
        return;
      }
      this.setEditorText(text);
    },
    setEditorText(text) {
      // 接管期间输入框就是插件组件：TUI 的 `ctx.ui.setEditorText` 也是写给**当前编辑器**
      // （`editor.setText`），所以直接落进组件并重渲一帧，而不是往客户端的输入框发（那时它不存在、会被静默丢掉）。
      // 组件漏实现 setText 时退回客户端路径（前端按粘贴送进接管面板），仍然不是静默丢。
      const takeoverComponent = editorTakeover?.component as { setText?: unknown } | null | undefined;
      const setText = takeoverComponent?.setText;
      let applied = false;
      if (takeoverComponent && typeof setText === "function") {
        try {
          (setText as (value: string) => void).call(takeoverComponent, text);
          renderEditorTakeover();
          applied = true;
        } catch (error) {
          console.warn("[pidance] extension editor component setText failed:", error);
        }
      }
      // **一律广播**（issue #107 审查 重要 4）：显示接管的标签靠 appliedToTakeover 知道
      // 组件已经拿到了（不该再当粘贴送一遍），而**没在显示**接管的标签（手机、设置关掉、
      // 用户点过「返回输入框」）本来就看不到组件里的字，必须落进它们可见的输入框 ——
      // 否则「组件实现了 setText」就等于把这些用户变成收不到字的人。
      emit({
        type: "extension_ui_request",
        id: randomUUID(),
        method: "set_editor_text",
        text,
        appliedToTakeover: applied,
      });
    },
    getEditorText() {
      // 接管期间「core input editor」就是**插件组件**：与 TUI 一致（`editor.getExpandedText?.() ?? editor.getText()`）
      // 回传它的文本 —— 否则 pi-subagents 一类插件会拿旧草稿去判断「输入框是否为空」，判断错人。
      const takeoverEntry = editorTakeover;
      if (takeoverEntry) {
        // 组件在就**以它为准**，哪怕内容是空的（"" ≠ "读不到"）：接管期间那份草稿镜像
        // 是陈旧的，回退过去会让插件把「空编辑器」判成有字（issue #107 三轮审查 重要 5）。
        const carried = readEditorTakeoverText(takeoverEntry);
        if (carried !== null) return carried;
      }
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
    addAutocompleteProvider(factory) {
      // 对齐 SDK：push 进链后重建 provider（不是增量改），并重新下发布尔门槛。
      if (typeof factory !== "function") return;
      completionWrappers = [...completionWrappers, factory as CompletionProviderFactory];
      rebuildCompletionChain();
      emitCompletionProviders();
    },
    setEditorComponent(factory) {
      // undefined = 恢复默认（SDK 类型：EditorFactory | undefined）→ 接管结束。
      editorComponentFactory = factory;
      // 值要存下来（「包裹上一个编辑器」的写法依赖 getEditorComponent 读回它），
      // 同时真的把组件挂成输入框位置的接管面板（issue #107）。
      mountEditorTakeover(factory);
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
      // isExpandable 的页头读的是这个状态（TUI 同）：先交给组件再重渲一帧。
      const headerEntry = slots.header;
      if (headerEntry?.setExpanded) {
        try {
          headerEntry.setExpanded(toolsExpanded);
        } catch (error) {
          console.error("[pidance] extension header setExpanded failed:", error);
        }
        headerEntry.requestRender();
      }
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
    /**
     * 页头 / 页脚槽位当前渲染的行（只读拷贝）；null = 没有插件槽位。
     *
     * 宿主的 get_state 投影用它水合：插件通常在加载时设一次就不再调用，
     * 页面稍后加载只能靠快照补回来（与 widget / 能力提示同一个坑）。
     */
    get headerLines(): string[] | null {
      const entry = slots.header;
      return entry?.lines ? [...entry.lines] : null;
    },
    get footerLines(): string[] | null {
      const entry = slots.footer;
      return entry?.lines ? [...entry.lines] : null;
    },
    /**
     * 忘掉「这种槽位已经提示过失败」的记录。
     *
     * 宿主在插件 reload 前调用：重载后拿到的是**新组件**，如果它还是渲染失败，
     * 应该能再提示一次（不重置的话用户只会看到第一次，之后静默）。
     */
    resetSlotFailures() {
      slotFailuresReported.clear();
    },
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
    /** 已注册的自动补全 provider 工厂数量（只读）：客户端据此决定要不要发补全请求。 */
    get autocompleteProviderCount() {
      return completionEffectiveCount;
    },
    /** 链最终 provider 声明的触发字符（并集）。 */
    get autocompleteTriggerCharacters() {
      return [...completionTriggerCharacters];
    },
    /**
     * 问插件补全链要候选。
     *
     * 链未注册 → `no-provider`（理论上客户端不会问，这里再挡一次）。
     * `getSuggestions` 抛错 → `error`：调用方回退到自己的文件补全（插件坏了不该让输入框变哑）。
     * 返回空数组（`{ items: [] }`）→ `empty`：**明确没有候选**，调用方不回退。
     */
    async suggestCompletions(input) {
      const provider = completionProvider;
      if (!provider || completionEffectiveCount === 0) return { kind: "no-provider" } as const;
      try {
        const result = await provider.getSuggestions(
          input.lines,
          input.cursorLine,
          input.cursorCol,
          { signal: input.signal, force: input.force },
        );
        return classifyCompletionSuggestions(result);
      } catch {
        return { kind: "error" } as const;
      }
    },
    /**
     * 应用候选：替换区间交给插件链（`applyCompletion`），返回归一化后的结果。
     *
     * 链未注册或结果形状不对 → null（调用方保持文本不变，不做「猜一个插入位置」这种兜底）。
     */
    applyCompletion(input) {
      const provider = completionProvider;
      if (!provider || completionEffectiveCount === 0) return null;
      try {
        return normalizeAppliedCompletion(
          provider.applyCompletion(input.lines, input.cursorLine, input.cursorCol, input.item, input.prefix),
        );
      } catch {
        return null;
      }
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
    setCustomBounds(id, value) {
      const bounds = normalizeCustomBounds(value);
      if (!bounds) return false;
      return customSessions.get(id)?.setBounds(bounds) ?? false;
    },

    inputWidgetMouse(key, event) {
      const entry = widgetFactories.get(key);
      if (!entry?.handleMouse) return false;
      entry.handleMouse(event);
      return true;
    },

    /**
     * 接管内容快照（只读，拷贝）：宿主的 /state 投影用它把接管补回给后加载的页面。
     * 返回拷贝：调用方只该读，改动内部数组会让快照与已下发的事件不一致。
     */
    get editorTakeoverSnapshot() {
      const entry = editorTakeover;
      if (!entry) return null;
      return {
        id: entry.id,
        lines: [...entry.lines],
        ...(entry.images.length > 0 ? { images: entry.images } : {}),
        ...(entry.imageFallbacks.length > 0 ? { imageFallbacks: entry.imageFallbacks } : {}),
      };
    },

    /**
     * 前端在插件编辑器里的输入：先过全局监听器（pi-tui 顺序），未被消费才进组件。
     *
     * 组件的 `handleInput` 抛错不往上抛（一个坏组件不该让整个按键通道炸掉），
     * 但会重渲一帧——插件可能已经在自己内部改过状态。
     */
    dispatchEditorComponentInput(data, clientId) {
      return dispatchEditorInput(data, clientId);
    },

    recordEditorTakeoverView(requestId, shown, clientId) {
      recordEditorTakeoverView(requestId, shown, clientId);
    },

    /**
     * 把文本放回当前接管组件（提交失败回填 / 重新进入时灌草稿）。
     * 请求 id 不匹配（接管已经换过）或组件没有 setText → false，调用方据此决定兜底。
     */
    applyEditorTakeoverText(requestId, text) {
      const entry = editorTakeover;
      if (!entry || entry.id !== requestId) return false;
      const setText = (entry.component as { setText?: unknown } | null | undefined)?.setText;
      if (typeof setText !== "function") return false;
      try {
        (setText as (value: string) => void).call(entry.component, text);
        renderEditorTakeover();
        return true;
      } catch (error) {
        console.warn("[pidance] extension editor component setText failed:", error);
        return false;
      }
    },

    /**
     * 「返回输入框」：把组件里的文本交还给发起标签的输入框（clientId 定向）。
     *
     * 为什么不广播：其它标签还显示着接管面板，给它们插进输入框既没用（它们看不到），
     * 又会在它们下次收起时冒出一份不该有的文本。
     */
    dismissEditorTakeover(requestId, clientId) {
      const entry = editorTakeover;
      if (!entry || entry.id !== requestId) return false;
      const carried = readEditorTakeoverText(entry);
      if (!carried) return false;
      emit({
        type: "extension_ui_request",
        id: randomUUID(),
        method: "set_editor_text",
        text: carried,
        appliedToTakeover: false,
        ...(clientId ? { clientId } : {}),
      });
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
      for (const kind of SLOT_KINDS) slots[kind]?.requestRender();
      return true;
    },
    dispatchTerminalInput(data) {
      return runTerminalInputListeners(data);
    },
    setEditorFocus,
    dispose() {
      unsubscribeThemeChange();
      editorFocusClients.clear();
      editorComponentFactory = undefined;
      // 宿主正在销毁：不发「接管结束」那一帧（没有订阅者，也没人恢复输入框）。
      unmountEditorTakeover({ silent: true });
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
      for (const kind of SLOT_KINDS) clearSlot(kind);
      statuses.clear();
      widgets.clear();
    },
  };
}
