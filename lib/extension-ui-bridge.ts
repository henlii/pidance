import type {
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
} from "./types";

export type ExtensionUiDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
export type ExtensionUiBlockingRequest = ExtensionUiDialogRequest;
export type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
export type ExtensionUiNoticeType = "info" | "success" | "warning" | "error";

export interface ExtensionUiState {
  /** 队首投影：阻塞请求（select/confirm/input/editor）弹窗承载（对齐 TUI modal） */
  dialog: ExtensionUiDialogRequest | null;
  customUi: ExtensionUiCustomRequest | null;
  statuses: ExtensionStatusItem[];
  widgets: ExtensionWidgetItem[];
  /** 阻塞请求 FIFO 内部队列；dialog 始终由队首投影 */
  blockingQueue: ExtensionUiBlockingRequest[];
}

export function createEmptyExtensionUiState(
  partial?: Partial<Pick<ExtensionUiState, "statuses" | "widgets" | "customUi">>,
): ExtensionUiState {
  return {
    dialog: null,
    customUi: partial?.customUi ?? null,
    statuses: partial?.statuses ?? [],
    widgets: partial?.widgets ?? [],
    blockingQueue: [],
  };
}

function isBlockingMethod(method: ExtensionUiRequest["method"]): method is ExtensionUiBlockingRequest["method"] {
  return method === "select" || method === "confirm" || method === "input" || method === "editor";
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

export type ExtensionUiEffect =
  | { type: "notice"; id: string; message: string; noticeType: ExtensionUiNoticeType; activityRecord: boolean }
  | { type: "setTitle"; title: string }
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
      const item = {
        key: request.widgetKey,
        lines: request.widgetLines,
        placement: request.widgetPlacement ?? "aboveEditor",
      } as ExtensionWidgetItem;
      const current = index === -1 ? null : state.widgets[index];
      if (current && current.placement === item.placement && current.lines === item.lines) return { state, effects: [] };
      const widgets = [...state.widgets.filter((existing) => existing.key !== request.widgetKey), item];
      return { state: { ...state, widgets }, effects: [] };
    }
    case "setTitle":
      return request.title
        ? { state, effects: [{ type: "setTitle", title: request.title }] }
        : { state, effects: [] };
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
        return { state: { ...state, customUi: { ...request, lines } }, effects: [] };
      }
    default:
      return { state, effects: [] };
  }
}
