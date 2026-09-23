/**
 * Pi ExtensionUIContext → Pidance Web 事件适配器。
 * 对齐 RPC mode 的 request/response 协议字段，供 SdkSessionHost 注入 bindExtensions。
 */
import { randomUUID } from "node:crypto";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import {
  createHeadlessCustomUiTui,
  DEFAULT_CUSTOM_UI_COLUMNS,
  DEFAULT_CUSTOM_UI_ROWS,
} from "./custom-ui-terminal";
import {
  loadPiTheme,
  RENDER_WIDTH,
  renderWidgetComponentLines,
} from "./tui-render-bridge";
import type { ExtensionUiCustomLayout } from "./types";

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

type CustomUiSession = {
  handleInput: (data: string) => void;
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
  customSnapshot: { id: string; lines: string[]; layout?: ExtensionUiCustomLayout } | null;
  respond: (id: string, response: Record<string, unknown>) => boolean;
  inputCustom: (id: string, data: string) => boolean;
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
  const customSessions = new Map<string, CustomUiSession>();
  let customSnapshot: { id: string; lines: string[]; layout?: ExtensionUiCustomLayout } | null = null;

  /**
   * 工厂形式的 widget（如 pi-subagents 的 async widget）：工厂只调用一次、组件实例
   * 常驻，`tui.requestRender()` 触发重新渲染并按 microtask 合并，产出走与字符串数组
   * 相同的 setWidget 通道。渲染失败保留上一次的行（不推空帧）；替换或卸载时调
   * 组件的 `dispose?.()`。
   */
  const widgetFactories = new Map<string, { dispose?: () => void }>();

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
    const theme = loadPiTheme();
    if (!theme) {
      clearWidget(key, placement);
      return;
    }

    const entry: { dispose?: () => void } = {};
    let component: unknown;
    let scheduled = false;

    const publish = () => {
      scheduled = false;
      // 已被替换或卸载：丢弃这帧，避免把旧 widget 写回去
      if (widgetFactories.get(key) !== entry) return;
      const lines = renderWidgetComponentLines(component);
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
      RENDER_WIDTH,
      DEFAULT_CUSTOM_UI_ROWS,
    );

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
    async custom(factory, options) {
      // headless custom：调用 Component.render(width) 得到 ANSI 行，再投影到 Web 面板。
      // /btw 等 overlay 扩展依赖 theme.fg/bg 与 requestRender；缺 lines 会让 React 崩页面。
      // options 决定面板是浮层（按插件给的尺寸/锚点）还是全屏模态。
      const id = randomUUID();
      const columns = DEFAULT_CUSTOM_UI_COLUMNS;
      const rows = DEFAULT_CUSTOM_UI_ROWS;
      const layout = normalizeCustomOverlayLayout(options);
      return new Promise((resolve) => {
        let doneCalled = false;
        let component: { render?: (width: number) => unknown; handleInput?: (data: string) => void } | undefined;
        const done = (result: unknown) => {
          if (doneCalled) return;
          doneCalled = true;
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
        const emitLines = () => {
          if (doneCalled) return;
          let lines: string[] = [];
          try {
            const rendered = component?.render?.(columns);
            if (Array.isArray(rendered)) {
              lines = rendered.filter((line): line is string => typeof line === "string");
            }
          } catch (error) {
            console.error("[pidance] custom UI render failed:", error);
          }
          emit({
            type: "extension_ui_request",
            id,
            method: "custom",
            lines,
            ...(layout ? { layout } : {}),
          });
          // 同时保存快照：刷新/切回后由 get_state 恢复面板内容与输入入口。
          // 只保留最新一个（面板同时只应有一个活动 custom）。
          customSnapshot = { id, lines: [...lines], ...(layout ? { layout } : {}) };
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
        customSessions.set(id, { handleInput, done });
        const tui = createHeadlessCustomUiTui(() => {
          emitLines();
        }, columns, rows);
        const theme = loadPiTheme() ?? uiContext.theme;
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
    get customSnapshot() {
      return customSnapshot;
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
    dispose() {
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
      for (const key of [...widgetFactories.keys()]) unmountWidgetFactory(key);
      statuses.clear();
      widgets.clear();
    },
  };
}
