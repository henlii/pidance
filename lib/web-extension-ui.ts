/**
 * Pi ExtensionUIContext → Pidance Web 事件适配器。
 * 对齐 RPC mode 的 request/response 协议字段，供 SdkSessionHost 注入 bindExtensions。
 */
import { randomUUID } from "node:crypto";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  createHeadlessCustomUiTui,
  DEFAULT_CUSTOM_UI_COLUMNS,
  DEFAULT_CUSTOM_UI_ROWS,
} from "./custom-ui-terminal";
import {
  loadPiTheme,
  renderWidgetFactoryLines,
} from "./tui-render-bridge";

export type ExtensionUiEmit = (event: Record<string, unknown>) => void;

export type PendingExtensionRequest = {
  resolve: (response: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

export type WebExtensionUIAdapter = {
  uiContext: ExtensionUIContext;
  pending: Map<string, PendingExtensionRequest>;
  /** 当前 status/widget 快照（get_state 重建） */
  statuses: Map<string, string>;
  widgets: Map<string, unknown>;
  pendingSnapshot: Map<string, Record<string, unknown>>;
  respond: (id: string, response: Record<string, unknown>) => boolean;
  dispose: () => void;
};

type DialogOpts = {
  signal?: AbortSignal;
  timeout?: number;
};

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

    const cleanup = () => {
      pending.delete(id);
      pendingSnapshot.delete(id);
      if (timeoutId) clearTimeout(timeoutId);
      opts?.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const onAbort = () => finish(defaultValue);

    opts?.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts?.timeout) {
      timeoutId = setTimeout(() => finish(defaultValue), opts.timeout);
    }

    pending.set(id, {
      resolve: (response) => {
        try {
          finish(parse(response));
        } catch (error) {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    });

    const event = { type: "extension_ui_request", id, ...request };
    pendingSnapshot.set(id, event);
    emit(event);
  });
}

/**
 * 创建 Web Extension UI 适配器。emit 将事件推给浏览器 SSE。
 */
export function createWebExtensionUIAdapter(emit: ExtensionUiEmit): WebExtensionUIAdapter {
  const pending = new Map<string, PendingExtensionRequest>();
  const pendingSnapshot = new Map<string, Record<string, unknown>>();
  const statuses = new Map<string, string>();
  const widgets = new Map<string, unknown>();

  const uiContext: ExtensionUIContext = {
    select: (title, options, opts) =>
      createDialogPromise(
        pending,
        pendingSnapshot,
        emit,
        opts,
        undefined,
        { method: "select", title, options, timeout: opts?.timeout },
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
        { method: "confirm", title, message, timeout: opts?.timeout },
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
        { method: "input", title, placeholder, timeout: opts?.timeout },
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
    onTerminalInput() {
      return () => {};
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
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget(key: string, content: unknown, options?: { placement?: string }) {
      // 组件工厂形式（如 pi-subagents async widget 的 buildWidgetComponent）：
      // headless 渲染为 ANSI 行后走现有 lines 通道；渲染失败静默（不设置不 emit）。
      // **snapshot-only 范围**：每次 setWidget 调用渲染一次静态行快照，工厂的
      // state/invalidate 生命周期与事件驱动重渲染不支持；输出受上限约束。
      if (typeof content === "function") {
        const lines = renderWidgetFactoryLines(content, loadPiTheme());
        if (lines === null) return;
        content = lines;
      }
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
    setFooter() {},
    setHeader() {},
    setTitle(title) {
      emit({
        type: "extension_ui_request",
        id: randomUUID(),
        method: "setTitle",
        title,
      });
    },
    async custom(factory) {
      // headless custom：提供最小 TUI 壳；多数扩展会因无真实终端降级
      const id = randomUUID();
      return new Promise((resolve) => {
        let doneCalled = false;
        const done = (result: unknown) => {
          if (doneCalled) return;
          doneCalled = true;
          emit({
            type: "extension_ui_request",
            id,
            method: "custom_close",
          });
          resolve(result as never);
        };
        const tui = createHeadlessCustomUiTui(() => {
          emit({
            type: "extension_ui_request",
            id,
            method: "custom_render",
          });
        }, DEFAULT_CUSTOM_UI_COLUMNS, DEFAULT_CUSTOM_UI_ROWS);
        void Promise.resolve(factory(tui as never, {} as never, {} as never, done)).catch(() => {
          done(undefined);
        });
        emit({
          type: "extension_ui_request",
          id,
          method: "custom",
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
      return "";
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
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent() {
      return undefined;
    },
    get theme() {
      // SDK Theme 签名：fg(name, text) / bold(text) 等。Web 无 TUI 上色，
      // 但必须返回 text 本身，否则扩展把颜色名当内容（mcp status 曾变成 "accent"）
      const passthrough = (text: string) => String(text ?? "");
      const color = (name: unknown, text?: unknown) =>
        text === undefined ? "" : String(text);
      return new Proxy(
        { fg: color, bg: color, bold: passthrough, dim: passthrough, italic: passthrough },
        {
          get(target, prop) {
            if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
            if (prop === "then") return undefined;
            return passthrough;
          },
        },
      ) as never;
    },
    getAllThemes() {
      return [];
    },
    getTheme() {
      return undefined;
    },
    setTheme() {
      return { success: false, error: "Theme switching not supported in Web mode" };
    },
    getToolsExpanded() {
      return false;
    },
    setToolsExpanded() {},
  };

  return {
    uiContext,
    pending,
    statuses,
    widgets,
    pendingSnapshot,
    respond(id, response) {
      const entry = pending.get(id);
      if (!entry) return false;
      entry.resolve(response);
      return true;
    },
    dispose() {
      for (const [id, entry] of pending) {
        pending.delete(id);
        pendingSnapshot.delete(id);
        entry.reject(new Error("Extension UI disposed"));
      }
      statuses.clear();
      widgets.clear();
    },
  };
}
