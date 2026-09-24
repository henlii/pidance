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
  let customSnapshot: { id: string; lines: string[]; layout?: ExtensionUiCustomLayout; hidden?: boolean } | null =
    null;

  /** 扩展请求的全局工具展开态（pi-subagents 跑子代理前会 setToolsExpanded(false)）。 */
  let toolsExpanded = false;

  /**
   * 当前渲染尺寸：前端按可用宽高上报，插件组件按它排版与裁切（见 setRenderSize）。
   * 两个维度必须同源 —— columns 是真值而 rows 是常量时，按行数裁切的插件会把
   * 本可以显示的行真丢掉（裁掉的行不在输出里）。
   */
  let renderWidth = RENDER_WIDTH;
  let renderRows = DEFAULT_CUSTOM_UI_ROWS;

  /** custom 面板的重渲入口（setRenderSize 用）：按当前尺寸重渲并下发。 */
  const customRenderers = new Set<() => void>();

  /** 每个能力只提示一次：插件可能反复调用同一条不支持的 API。 */
  const unsupportedNotified = new Set<string>();

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
    if (unsupportedNotified.has(feature)) return;
    unsupportedNotified.add(feature);
    console.warn(`[pidance] extension UI capability not supported on web: ${feature}`);
    emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "notify",
      message: `Extension UI "${feature}" is not supported by the Pidance web client.`,
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
    const theme = loadPiTheme();
    if (!theme) {
      clearWidget(key, placement);
      return;
    }

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
      { isEditorFocused },
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
    onTerminalInput(handler) {
      // pi-tui 的 addInputListener 是全局的，Web 没有等价的同步键盘通道：
      // 前端只在「有 custom 面板且被插件收起」时把白名单按键拿过来问
      // （见 hooks/useExtensionTerminalInput.ts）。注册数量会下发给前端，
      // 没有监听器时前端完全不介入键盘。
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
      if (label === undefined) return;
      notifyUnsupported("setHiddenThinkingLabel");
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
        const emitCustom = () => {
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
         */
        const overlayHandle = {
          hide() {
            setHidden(true);
          },
          setHidden,
          isHidden: () => hidden,
          focus() {},
          unfocus() {},
          isFocused: () => !hidden,
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
        }, () => renderWidth, () => renderRows, { isEditorFocused });
        customRenderers.add(emitLines);
        const theme = loadPiTheme() ?? uiContext.theme;
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
    addAutocompleteProvider() {
      notifyUnsupported("addAutocompleteProvider");
    },
    setEditorComponent(factory) {
      // undefined = 恢复默认
      if (factory === undefined) return;
      notifyUnsupported("setEditorComponent");
    },
    getEditorComponent() {
      return undefined;
    },
    get theme() {
      // 扩展拿到的 theme。Web 端不做终端上色（文本原样返回）。
      //
      // 两层：
      // 1. 真 Theme 的成员按**正确类型**给出：name 是字符串、getColorMode() 返回
      //    "truecolor"、getThinkingBorderColor() 返回函数。此前用 Proxy 对**所有**
      //    属性一律返回透传函数，于是 theme.name 是函数、getThinkingBorderColor("high")
      //    返回字符串 "high"，插件一调用就 TypeError（再被渲染桥的 try/catch 吞成
      //    「回退原文」）。
      // 2. 未知成员回落到可调用的透传函数，而不是 undefined：「兼容优先」比严格更
      //    重要 —— 插件会把主题对象透传给它自己的渲染辅助，返回 undefined 会让它们
      //    从「没颜色但文本还在」退化成直接抛错。
      //    （插件源码里常见的 theme.description / theme.selectedText / theme.border
      //    多是 pi-tui 各组件自己的主题对象（SelectListTheme 等），与本对象无关。）
      const passthrough = (text: unknown) => String(text ?? "");
      const color = (_name: unknown, text?: unknown) => (text === undefined ? "" : String(text));
      const known = {
        name: "pidance",
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
      return new Proxy(known, {
        get(target, prop) {
          if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
          if (prop === "then") return undefined;
          return passthrough;
        },
      }) as never;
    },
    getAllThemes() {
      // 与 setTheme 的明确错误保持一致：不用空数组假装「没有主题可选」
      notifyUnsupported("getAllThemes");
      return [];
    },
    getTheme() {
      notifyUnsupported("getTheme");
      return undefined;
    },
    setTheme() {
      return { success: false, error: "Theme switching not supported in Web mode" };
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
      editorFocusClients.clear();
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
