import type {
  ExtensionStatusItem,
  ExtensionUiCustomLayout,
  ExtensionUiRequest,
  ExtensionWidgetItem,
} from "./types";

export type ExtensionUiDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
export type ExtensionUiBlockingRequest = ExtensionUiDialogRequest;
export type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
export type ExtensionUiNoticeType = "info" | "success" | "warning" | "error";

import type { ExtensionShortcutEntry } from "./extension-shortcuts";

export interface ExtensionUiState {
  /** 队首投影：阻塞请求（select/confirm/input/editor）弹窗承载（对齐 TUI modal） */
  dialog: ExtensionUiDialogRequest | null;
  customUi: ExtensionUiCustomRequest | null;
  statuses: ExtensionStatusItem[];
  widgets: ExtensionWidgetItem[];
  /**
   * 插件页头槽位的渲染行（`setHeader`）；null = 没有插件页头（不显示这一块）。
   * 空数组与 null 等价：槽位是**替换**语义（见 lib/types.ts 的 setHeader/setFooter 注释）。
   */
  header: string[] | null;
  /** 插件页脚槽位的渲染行（`setFooter`）；null = 用我们自己的状态条。 */
  footer: string[] | null;
  /** 注册了全局按键监听的插件监听器数量（>0 时前端才需要把按键拿去问）。 */
  terminalInputListenerCount: number;
  /**
   * 插件快捷键（`pi.registerShortcut`）的解析结果与 **Web 可用性**（issue #105）。
   *
   * 空数组 = 没有插件注册快捷键。不可用的键也在里面（带 reason），设置里要如实列出来 ——
   * 静默丢弃会让插件作者以为是自己写错了键。
   */
  shortcuts: ExtensionShortcutEntry[];
  /**
   * 插件自动补全的 provider 数量（>0 时前端才需要为一次输入付往返）。
   *
   * 与 terminalInputListenerCount 同一类：既有瞬时事件（autocompleteProviders），
   * 也有状态投影水合（extensionAutocompleteProviderCount）。
   */
  autocompleteProviderCount: number;
  /** 补全链声明的触发字符（并集）；前端据此决定何时请求。 */
  autocompleteTriggerCharacters: string[];
  /** 扩展定制的运行提示：文案（setWorkingMessage）。 */
  workingMessage: string | null;
  /** 扩展是否允许显示运行提示行（setWorkingVisible，默认 true）。 */
  workingVisible: boolean;
  /** 扩展自定义的运行指示动画帧（setWorkingIndicator）；frames 为空数组 = 隐藏指示器。 */
  workingIndicator: { frames: string[]; intervalMs: number } | null;
  /**
   * 插件自定义的折叠思考标签（setHiddenThinkingLabel）：折叠态思考块那一行的文案。
   * null = 用我们自己的 i18n 文案（未设置 / 被插件恢复默认）。
   */
  hiddenThinkingLabel: string | null;
  /**
   * 扩展请求的全局工具展开态（`setToolsExpanded`）。
   *
   * null = 扩展从未请求过（客户端保持每块的用户选择）；布尔值 = 最近一次请求的值。
   * 与 TUI 同语义：false 把所有工具块收起来，true 全部展开。已装插件（pi-subagents 三处）
   * **都是 set(false)**，展开态只为语义完整。
   */
  toolsExpanded: boolean | null;
  /**
   * 请求序号：同一个值被连续请求两次也必须让客户端再执行一次
   * （每块有自己的折叠状态，靠「值相同」判重会漏掉用户中途手动展开的那块）。
   */
  toolsExpandedRevision: number;
  /** 阻塞请求 FIFO 内部队列；dialog 始终由队首投影 */
  blockingQueue: ExtensionUiBlockingRequest[];
}

export function createEmptyExtensionUiState(  partial?: Partial<Pick<ExtensionUiState, "statuses" | "widgets" | "customUi" | "terminalInputListenerCount" | "shortcuts">>,
): ExtensionUiState {
  return {
    dialog: null,
    customUi: partial?.customUi ?? null,
    statuses: partial?.statuses ?? [],
    widgets: partial?.widgets ?? [],
    header: null,
    footer: null,
    terminalInputListenerCount: partial?.terminalInputListenerCount ?? 0,
    shortcuts: partial?.shortcuts ?? [],
    autocompleteProviderCount: 0,
    autocompleteTriggerCharacters: [],
    workingMessage: null,
    workingVisible: true,
    workingIndicator: null,
    hiddenThinkingLabel: null,
    toolsExpanded: null,
    toolsExpandedRevision: 0,
    blockingQueue: [],
  };
}

function isBlockingMethod(method: ExtensionUiRequest["method"]): method is ExtensionUiBlockingRequest["method"] {
  return method === "select" || method === "confirm" || method === "input" || method === "editor";
}

/**
 * 从 host 状态里的 `pendingExtensionRequests` 挑出阻塞请求（保持 FIFO 顺序）。
 *
 * 阻塞请求只有 SSE 事件、没有重放：后台/断流期间漏掉一条，问答就永远不出现。
 * 恢复入口（热状态、切会话、reconcile、切回前台）统一用这个函数把快照转成队列。
 */
export function pickBlockingExtensionRequests(events: unknown): ExtensionUiBlockingRequest[] {
  if (!Array.isArray(events)) return [];
  return events.filter((event): event is ExtensionUiBlockingRequest => {
    const candidate = event as { type?: unknown; id?: unknown; method?: unknown } | null;
    if (!candidate || candidate.type !== "extension_ui_request") return false;
    if (typeof candidate.id !== "string" || !candidate.id) return false;
    return isBlockingMethod(candidate.method as ExtensionUiRequest["method"]);
  });
}

/**
 * 已结算 id 的记忆上限。
 *
 * 只需要盖住「在途的状态响应比结算事件晚到」这个窗口，不需要无限长：id 是一次性的
 * UUID，不会复用；超过上限就丢最旧的。
 */
export const MAX_SETTLED_REQUEST_IDS = 64;

/**
 * 从 `extension_ui_settled` 事件里取 id；形状不对（含空 id）返回 null。
 */
export function parseExtensionUiSettledId(event: unknown): string | null {
  const candidate = event as { type?: unknown; id?: unknown } | null;
  if (!candidate || candidate.type !== "extension_ui_settled") return null;
  if (typeof candidate.id !== "string" || !candidate.id) return null;
  return candidate.id;
}

/**
 * 记住一个已结算的请求 id（有界）。已存在则提到末尾（让它在淘汰顺序里最后被丢）。
 */
export function rememberSettledRequestId(
  settled: readonly string[],
  id: string,
): string[] {
  const next = settled.filter((item) => item !== id);
  next.push(id);
  return next.length > MAX_SETTLED_REQUEST_IDS
    ? next.slice(next.length - MAX_SETTLED_REQUEST_IDS)
    : next;
}

/**
 * 把已结算的请求从投影队列里滤掉。
 *
 * 为什么必须滤：状态响应可能与结算**并发**——那个响应是在宿主结算之前序列化的，
 * 里面仍有这个 id，落地后会把已经结束的面板装回来（挂到下一次投影，运行中还要 15s）。
 * 没有要滤的项时返回**原数组引用**，调用方可以据此零成本判重。
 */
export function filterSettledBlockingRequests<T extends { id: string }>(
  queue: T[],
  settled: readonly string[],
): T[] {
  if (settled.length === 0 || queue.length === 0) return queue;
  const settledSet = new Set(settled);
  const kept = queue.filter((item) => !settledSet.has(item.id));
  return kept.length === queue.length ? queue : kept;
}

/**
 * 从 host 状态里挑出**宿主自己的能力提示**（"Web 端不支持/只部分支持某能力"）。
 *
 * 与 pickBlockingExtensionRequests 同一个理由：这些提示走一次性 SSE 事件，而 host
 * 启动、扩展加载、注册监听器都发生在浏览器订阅之前 —— 那一刻没有订阅者，事件直接
 * 丢掉，这条"可见降级"提示在实践中用户永远看不到（实测：服务端日志 5 次、页面 DOM 0 次）。
 * 所以状态快照里带上它，凡是拿到状态的路径（热状态、切会话、reconcile、切回前台）
 * 都补一遍；按 id 去重由通知队列负责（同 id 到两次只显示一条）。
 *
 * 只挑宿主的能力提示：插件自己调的 `notify` 不在这个数组里（它是一次性通知，
 * 重放会让插件每次开页面都重弹）。
 */
export function pickCapabilityNotices(
  notices: unknown,
): { id: string; message: string; notifyType: "warning" }[] {
  if (!Array.isArray(notices)) return [];
  const out: { id: string; message: string; notifyType: "warning" }[] = [];
  for (const item of notices) {
    const candidate = item as { id?: unknown; message?: unknown; notifyType?: unknown } | null;
    if (!candidate || typeof candidate !== "object") continue;
    if (typeof candidate.id !== "string" || !candidate.id) continue;
    if (typeof candidate.message !== "string" || !candidate.message.trim()) continue;
    // 适配器目前只发 warning 一种能力提示；不认识的级别一律丢掉（宁可少显示，
    // 也不要把插件私有 payload 当成宿主提示重放出去）。
    if (candidate.notifyType !== "warning") continue;
    out.push({ id: candidate.id, message: candidate.message, notifyType: "warning" });
  }
  return out;
}

/**
 * 从 host 状态恢复活动 custom 面板（Issue #34）。
 *
 * custom 面板只有 SSE 事件、没有重放，刷新或切回后服务端仍在等输入但浏览器端
 * 既无内容也无输入入口。状态里的 `activeCustomUi` 是 host 保存的最后可重放投影。
 *
 * 规则：
 * - 没有活动面板，或已渲染的就是同一个 id → 原样返回（不覆盖刚由事件刷新的行）；
 * - 不同 id → 恢复它（面板内容 + 输入入口）。
 * 只恢复不清理：关闭由 `closed` 事件负责，避免与刚打开的面板竞争。
 */
export function restoreCustomUi(
  state: ExtensionUiState,
  active: { id?: unknown; lines?: unknown; images?: unknown; imageFallbacks?: unknown; layout?: unknown; hidden?: unknown } | null | undefined,
): ExtensionUiState {
  const id = typeof active?.id === "string" && active.id ? active.id : null;
  if (!id) return state;
  if (state.customUi?.id === id) return state;
  const lines = Array.isArray(active?.lines)
    ? (active!.lines as unknown[]).filter((line): line is string => typeof line === "string")
    : [];
  // overlay 布局必须跟内容一起恢复，否则刷新后浮层变回全屏模态、盖住输入区
  const layout =
    active?.layout && typeof active.layout === "object"
      ? (active.layout as ExtensionUiCustomLayout)
      : undefined;
  // 收起状态同理：刷新后不得把一个已被插件收起的面板重新弹出来
  const hidden = active?.hidden === true;
  return {
    ...state,
    customUi: {
      type: "extension_ui_request",
      id,
      method: "custom",
      lines,
      ...(Array.isArray(active?.images) && active.images.length > 0 ? { images: active.images } : {}),
      ...(Array.isArray(active?.imageFallbacks) && active.imageFallbacks.length > 0
        ? { imageFallbacks: active.imageFallbacks }
        : {}),
      ...(hidden ? { hidden } : {}),
      ...(layout ? { layout } : {}),
    } as ExtensionUiCustomRequest,
  };
}

function getBlockingQueue(state: ExtensionUiState): ExtensionUiBlockingRequest[] {
  return state.blockingQueue ?? [];
}

/** 由队列队首投影 dialog（对齐 TUI：全部阻塞请求弹窗承载）。 */
export function projectBlockingHead(queue: readonly ExtensionUiBlockingRequest[]): {
  dialog: ExtensionUiDialogRequest | null;
} {
  const head = queue[0];
  if (!head) return { dialog: null };
  return { dialog: head };
}

function withProjectedQueue(
  state: ExtensionUiState,
  queue: ExtensionUiBlockingRequest[],
): ExtensionUiState {
  const projected = projectBlockingHead(queue);
  return {
    ...state,
    blockingQueue: queue,
    dialog: projected.dialog,
  };
}

/**
 * 按 id 从阻塞队列移除一项并重新投影队首。
 * 可安全处理非队首 id；未知 id 返回原 state 引用。
 */
export function clearExtensionUiRequest(state: ExtensionUiState, requestId: string): ExtensionUiState {
  const queue = getBlockingQueue(state);
  if (queue.length === 0) {
    // 兼容无队列但投影槽仍残留的旧态
    if (state.dialog?.id === requestId) {
      return { ...state, dialog: null, blockingQueue: [] };
    }
    return state;
  }
  const index = queue.findIndex((item) => item.id === requestId);
  if (index === -1) return state;
  const nextQueue = queue.filter((item) => item.id !== requestId);
  return withProjectedQueue(state, nextQueue);
}

/** 清空全部阻塞投影与队列（会话切换 / 卸载）；不碰 custom/status/widget */
export function clearAllExtensionUiBlocking(state: ExtensionUiState): ExtensionUiState {
  const queue = getBlockingQueue(state);
  if (queue.length === 0 && !state.dialog) return state;
  return {
    ...state,
    dialog: null,
    blockingQueue: [],
  };
}

/**
 * 切会话 / 新建会话时清掉**上一个会话**的扩展 UI 投影。
 *
 * 内容类字段全清：面板（custom）、状态条、widget、页头 / 页脚、运行提示、按键监听器计数。
 * 新会话的投影随后由水合（/state 的 extensionStatuses / extensionWidgets /
 * extensionHeader / extensionFooter / activeCustomUi）填回；没水合到就保持空 —— 宁可空着，也不要把上个会话的面板
 * 留在新会话里（否则看起来像“面板跟着人跑”）。
 */
export function resetExtensionUiForSession(state: ExtensionUiState): ExtensionUiState {
  return {
    ...clearAllExtensionUiBlocking(state),
    customUi: null,
    statuses: [],
    widgets: [],
    // 页头 / 页脚是插件给**这个会话**设的：新会话不继承（它自己的水合会补回来）。
    header: null,
    footer: null,
    terminalInputListenerCount: 0,
    // 补全 provider 也是**这个会话**的宿主注册的：新会话由它自己的水合填回。
    autocompleteProviderCount: 0,
    autocompleteTriggerCharacters: [],
    workingMessage: null,
    workingVisible: true,
    workingIndicator: null,
    // 标签也归内容类字段：新会话的标签由它自己的水合填回，不继承上一个会话的。
    hiddenThinkingLabel: null,
    // 切会话要把「扩展请求的展开态」清掉：新会话不该继承上一个会话的请求。
    toolsExpanded: null,
    toolsExpandedRevision: 0,
  };
}

/**
 * 两个槽位投影是否等价。
 *
 * 按**内容**比而不是按引用：适配器每次 publish 都新建数组，引用比较永远不命中，
 * 于是每次重渲（宽度变化、主题切换、requestRender）都会写一次 state，
 * 连带整棵聊天界面重渲染。
 */
export function sameSlotLines(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

export type ExtensionUiEffect =
  | { type: "notice"; id: string; message: string; noticeType: ExtensionUiNoticeType; activityRecord: boolean }
  | { type: "setTitle"; title: string }
  | { type: "setThemeMode"; mode: "light" | "dark" }
  /**
   * 交回主输入框焦点（overlay 句柄的 `unfocus()`）。
   *
   * 为什么只有「交回编辑器」需要副作用：另外两态（`panel` / `none`）由面板组件
   * 自己读 `request.focus` 处理（它就在 DOM 上，能直接 blur/focus 自己的 keytrap），
   * 而输入框的句柄只有 useAgentSession 拿得到。
   */
  | { type: "focusEditor" }
  | { type: "insertText"; text: string };

export function applyExtensionUiRequest(
  state: ExtensionUiState,
  request: ExtensionUiRequest,
): { state: ExtensionUiState; effects: ExtensionUiEffect[] } {
  switch (request.method) {
    case "select":
    case "confirm":
    case "input":
    case "editor": {
      if (!isBlockingMethod(request.method)) return { state, effects: [] };
      const queue = getBlockingQueue(state);
      // 同 id 已在队列中：不重复入队（SSE 重放 / 重复事件）
      if (queue.some((item) => item.id === request.id)) {
        return { state, effects: [] };
      }
      const nextQueue = [...queue, request as ExtensionUiBlockingRequest];
      return { state: withProjectedQueue(state, nextQueue), effects: [] };
    }
    case "notify":
      return {
        state,
        effects: [{ type: "notice", id: request.id, message: request.message, noticeType: request.notifyType ?? "info", activityRecord: request.activityRecord === true }],
      };
    case "setStatus": {
      const index = state.statuses.findIndex((item) => item.key === request.statusKey);
      if (!request.statusText) {
        if (index === -1) return { state, effects: [] };
        return { state: { ...state, statuses: state.statuses.filter((item) => item.key !== request.statusKey) }, effects: [] };
      }
      const item = { key: request.statusKey, text: request.statusText };
      if (index !== -1 && state.statuses[index].text === item.text) return { state, effects: [] };
      const statuses = [...state.statuses.filter((current) => current.key !== request.statusKey), item];
      return { state: { ...state, statuses }, effects: [] };
    }
    case "setWidget": {
      const index = state.widgets.findIndex((item) => item.key === request.widgetKey);
      if (!request.widgetLines) {
        if (index === -1) return { state, effects: [] };
        return { state: { ...state, widgets: state.widgets.filter((item) => item.key !== request.widgetKey) }, effects: [] };
      }
      // 图片字段缺省 = 「与上一帧相同」：服务端图片没变时省略 base64（几百 KB × 每帧太贵），
      // 所以这里要保留上一帧的图；显式空数组则表示图没了，要清掉。
      const previousImages = index === -1 ? undefined : state.widgets[index]?.images;
      const previousFallbacks = index === -1 ? undefined : state.widgets[index]?.imageFallbacks;
      const images = Array.isArray(request.widgetImages)
        ? (request.widgetImages.length > 0 ? request.widgetImages : undefined)
        : previousImages;
      const imageFallbacks = Array.isArray(request.widgetImageFallbacks)
        ? (request.widgetImageFallbacks.length > 0 ? request.widgetImageFallbacks : undefined)
        : previousFallbacks;
      const item = {
        key: request.widgetKey,
        lines: request.widgetLines,
        ...(images ? { images } : {}),
        ...(imageFallbacks ? { imageFallbacks } : {}),
        placement: request.widgetPlacement ?? "aboveEditor",
        interactive: request.widgetInteractive === true,
      } as ExtensionWidgetItem;
      const current = index === -1 ? null : state.widgets[index];
      // 交互性也要比：同一份行内容从「不可点」变成「可点」时必须更新状态，
      // 否则前端永远读不到新的 interactive（第一次渲染就可能与后挂的组件错开）。
      if (
        current
        && current.placement === item.placement
        && current.lines === item.lines
        && current.images === item.images
        && current.imageFallbacks === item.imageFallbacks
        && current.interactive === item.interactive
      ) return { state, effects: [] };
      const widgets = [...state.widgets.filter((existing) => existing.key !== request.widgetKey), item];
      return { state: { ...state, widgets }, effects: [] };
    }
    case "setHeader":
    case "setFooter": {
      const key = request.method === "setHeader" ? "header" : "footer";
      // 空数组与 null 都是「没有内容」：TUI 的 setFooter(undefined) 是把内置页脚换回来。
      const lines = Array.isArray(request.lines) && request.lines.length > 0 ? request.lines : null;
      if (sameSlotLines(state[key], lines)) return { state, effects: [] };
      return { state: { ...state, [key]: lines }, effects: [] };
    }
    case "setTitle":
      return request.title
        ? { state, effects: [{ type: "setTitle", title: request.title }] }
        : { state, effects: [] };
    case "terminalInputListeners":
      return { state: { ...state, terminalInputListenerCount: request.count }, effects: [] };
    case "autocompleteProviders":
      return {
        state: {
          ...state,
          autocompleteProviderCount: request.count,
          autocompleteTriggerCharacters: Array.isArray(request.triggerCharacters)
            ? request.triggerCharacters.filter((c: unknown): c is string => typeof c === "string" && c !== "")
            : [],
        },
        effects: [],
      };
    case "setHiddenThinkingLabel":
      return state.hiddenThinkingLabel === request.label
        ? { state, effects: [] }
        : { state: { ...state, hiddenThinkingLabel: request.label }, effects: [] };
    case "setWorkingMessage":
      return state.workingMessage === request.message
        ? { state, effects: [] }
        : { state: { ...state, workingMessage: request.message }, effects: [] };
    case "setToolsExpanded":
      // 值相同也要递增序号：客户端据此把「一次请求」与「当前值」区分开。
      return {
        state: { ...state, toolsExpanded: request.toolsExpanded, toolsExpandedRevision: state.toolsExpandedRevision + 1 },
        effects: [],
      };
    case "setTheme":
      // 插件 `ctx.ui.setTheme` 的内置主题 → 壳的亮/暗。只认这两个值：服务端已经
      // 只发 dark/light，这里再归一一次，防非法载荷把壳改成未定义状态。
      return {
        state,
        effects: [{ type: "setThemeMode", mode: request.mode === "light" ? "light" : "dark" }],
      };
    case "setWorkingVisible":
      return state.workingVisible === request.visible
        ? { state, effects: [] }
        : { state: { ...state, workingVisible: request.visible }, effects: [] };
    case "setWorkingIndicator": {
      // frames 为空数组是「隐藏指示器」的有效声明，不能当成「未提供」而回退默认
      if (request.frames === null) {
        return state.workingIndicator === null
          ? { state, effects: [] }
          : { state: { ...state, workingIndicator: null }, effects: [] };
      }
      const intervalMs = request.intervalMs ?? 120;
      return {
        state: { ...state, workingIndicator: { frames: request.frames, intervalMs } },
        effects: [],
      };
    }
    case "set_editor_text":
      return { state, effects: [{ type: "insertText", text: request.text }] };
    case "custom":
      if (request.closed) {
        return request.id === state.customUi?.id
          ? { state: { ...state, customUi: null }, effects: [] }
          : { state, effects: [] };
      }
      {
        const lines = Array.isArray(request.lines)
          ? request.lines.filter((line): line is string => typeof line === "string")
          : [];
        // 焦点只在**状态变化**时下发副作用：插件每次重渲都会发一帧 custom，
        // 若每帧都发效果，用户点到输入框后会被立刻抢回面板。
        const effects: ExtensionUiEffect[] =
          request.focus === "editor" && state.customUi?.focus !== "editor"
            ? [{ type: "focusEditor" }]
            : [];
        // images / imageFallbacks 同样收口：只认数组，元素形状交给渲染层兜。
        const images = Array.isArray(request.images) ? request.images : [];
        const imageFallbacks = Array.isArray(request.imageFallbacks) ? request.imageFallbacks : [];
        return {
          state: {
            ...state,
            customUi: {
              ...request,
              lines,
              // 显式覆盖而不是「有效才补」：展开 request 会把坏形状原样带进来，
              // 这里按「有效数组 | undefined」收口，前端只认已知形状。
              images: images.length > 0 ? images : undefined,
              imageFallbacks: imageFallbacks.length > 0 ? imageFallbacks : undefined,
            },
          },
          effects,
        };
      }
    default:
      return { state, effects: [] };
  }
}
