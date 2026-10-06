"use client";

import { useMemo, useEffect, useRef, useState, type ReactNode } from "react";
import { normalizeCustomPanelLinesWithIndex, parseAnsiLine, stripAnsi } from "@/lib/ansi";
import { RenderedLineBlocks } from "./RenderedLines";
import { collectImageLineIndexes, remapImageLineIndexes, imageFallbackReasonKey } from "@/lib/kitty-image";
import { shouldCaptureCustomPanelKey } from "@/lib/extension-panel-keys";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { buildExtensionOverlayStyle } from "@/lib/extension-overlay-layout";
import { customPanelBoundsFromRects, shouldReportCustomPanelBounds } from "@/lib/custom-panel-bounds";
import { measureCharWidth, measureLineHeight } from "@/lib/render-width";
import { useI18n } from "@/lib/i18n";
import type { ExtensionUiCustomRequest } from "@/lib/extension-ui-bridge";
import type { CustomPanelBounds } from "@/lib/types";
import { ExtensionPanelWebView } from "./ExtensionPanelWebView";
import { buildPanelView, shouldRenderPanelWebView } from "@/lib/extension-panel-view";
import { ExtensionPanelChrome } from "./ExtensionPanelChrome";

/**
 * DOM 点击坐标 → 面板内的字符行列（pi-tui 的 TuiMouseEvent 用字符坐标）。
 * 行按实际行高算；列按等宽字符宽算（同 measureCharWidth）。滚动位置一并计入。
 *
 * `measureCharWidth` 量不到时（元素尚未布局）返回 null，调用方**不转发这次点击**：
 * 字符宽编不出来就换不出正确的格位，宁可这一次点击不生效，也不要给插件送去错坐标。
 */
function toPanelMouseEvent(
  event: React.MouseEvent<HTMLPreElement>,
): Record<string, unknown> | null {
  const el = event.currentTarget;
  const rect = el.getBoundingClientRect();
  const styles = window.getComputedStyle(el);
  const fontSize = Number.parseFloat(styles.fontSize) || 12;
  const lineHeight = Number.parseFloat(styles.lineHeight) || fontSize * 1.5;
  const charWidth = measureCharWidth(el);
  if (charWidth === null) return null;
  const x = Math.max(0, Math.floor((event.clientX - rect.left + el.scrollLeft) / charWidth));
  const y = Math.max(0, Math.floor((event.clientY - rect.top + el.scrollTop) / lineHeight));
  return {
    type: "click",
    button: event.button === 0 ? "left" : event.button === 1 ? "middle" : "right",
    x,
    y,
    screenX: x,
    screenY: y,
    width: Math.max(1, Math.floor(rect.width / charWidth)),
    height: Math.max(1, Math.floor(rect.height / lineHeight)),
    shift: event.shiftKey,
    alt: event.altKey,
    ctrl: event.ctrlKey,
    clickCount: event.detail,
  };
}

function renderAnsiLine(line: string, keyPrefix: string) {
  return parseAnsiLine(line).map((segment, index) => (
    segment.style
      ? <span key={`${keyPrefix}-${index}`} style={segment.style}>{segment.text}</span>
      : segment.text
  ));
}

export function ExtensionCustomPanel({
  request,
  onInput,
  onMouse,
  rawMode,
  onToggleRawMode,
  onSelectOption,
  onInputValue,
  isMobile,
  bottomInset = 0,
  onBounds,
  expanded,
  onExpandedChange,
  keyBar,
}: {
  request: ExtensionUiCustomRequest;
  onInput: (request: ExtensionUiCustomRequest, data: string) => void;
  onMouse?: (request: ExtensionUiCustomRequest, event: Record<string, unknown>) => void;
  /**
   * 面板几何（字符单元格）上报出口。面板的 `getBounds()` 是**同步**接口，所以只能
   * 由这里量出来推给服务端存下（口径与理由见 lib/custom-panel-bounds.ts）。
   */
  /** 用户点了「切回原样」：这一页按原始渲染（issue #114 的可退回开关）。 */
  rawMode?: boolean;
  /** 「切回原样」的能力：按钮暂时隐藏（见 footerActions 处的注释），开关本身保留。 */
  onToggleRawMode?: () => void;
  /** 点了网页化选项行：由调用方合成按键（发键前会自校验，见 ChatWindow）。 */
  onSelectOption?: (optionIndex: number) => void;
  /** 面板里的 Input 原语：把文本写回组件；confirm = 回车确认（issue #116 呈现那半）。 */
  onInputValue?: (request: ExtensionUiCustomRequest, value: string, confirm: boolean) => void;
  /**
   * 窄视口（useIsMobile）：手机上没有物理键盘，插件面板的键盘捕获元素不该弹软键盘 ——
   * 方向键/回车由屏幕按键条送（issue #113），所以这里让 keytrap 只读并停用焦点守卫。
   */
  isMobile?: boolean;
  /** 屏幕按键条遮住的高度（px）：面板容器底部让出同样的空间，别把正文压在按键条下面。 */
  bottomInset?: number;
  onBounds?: (request: ExtensionUiCustomRequest, bounds: CustomPanelBounds) => void;
  /**
   * 展开态：展开时面板会替代会话区（全屏）或挤占它一半高度（半屏），
   * 所以状态由持有布局的 ChatWindow 控制；不传则退回外壳内部 state。
   */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** 方向键/回车/Esc 那排控制键（内联按键条）：放底栏最左，与右侧的取消同一排。 */
  keyBar?: ReactNode;
}) {
  const { t } = useI18n();
  // 网页化与网页输入框停用后，这几项暂时没有渲染出口（能力保留，恢复时直接用）：
  // 显式消费一次，免得被当成死代码删掉。
  void onToggleRawMode;
  void rawMode;
  void onInputValue;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** 画 ANSI 的那块：几何与鼠标坐标都以此为准（两处必须同源）。 */
  const bodyRef = useRef<HTMLPreElement>(null);
  const composingRef = useRef(false);
  const [copied, setCopied] = useState(false);
  /** 上次**上报过**的几何：同值不重发（ResizeObserver 会为无关变化反复回调）。 */
  const lastBoundsRef = useRef<CustomPanelBounds | null>(null);
  /**
   * 上面那份几何属于哪个请求 id。
   *
   * 为什么必须分开记：同一个组件实例会被复用给**下一个** custom 请求（插件关一个再开一个），
   * 而新面板的几何往往与旧面板一模一样（同宽、同锚点）。只比几何的话「没变化」会把新请求
   * 整条跳过，服务端于是永远没有这个 id 的几何，插件读 `getBounds()` 拿到 undefined。
   */
  const lastBoundsIdRef = useRef<string | null>(null);
  /**
   * 观察者与滚动监听只挂一次，靠 ref 读最新的 request —— 插件每重渲一帧就换一个
   * request 对象，直接进依赖数组会让观察者每帧重建。
   */
  const requestRef = useRef(request);
  requestRef.current = request;
  /**
   * 图片与降级说明是按**原文行号**标注的，而归一化会删框线、裁掉首尾空白行；
   * 锚点（摘图后是空行）被丢掉就等于图静默消失，删行还会让后续图片错位、
   * 甚至把正文行当占位行吞掉（issue #104 审查 P0-3）。所以：先保护锚点行、
   * 拿到行号映射，再把图片重排到归一化后的行号上。
   */
  const imageLineIndexes = collectImageLineIndexes(request.images, request.imageFallbacks);
  const normalizedLines = normalizeCustomPanelLinesWithIndex(request.lines, { keep: imageLineIndexes });
  const displayLines = normalizedLines.lines;
  const displayImages = remapImageLineIndexes(request.images, normalizedLines.sourceIndex).items;
  const displayImageFallbacks = remapImageLineIndexes(
    request.imageFallbacks,
    normalizedLines.sourceIndex,
  ).items;
  const plainText = displayLines.map((line) => stripAnsi(line)).join("\n");

  // overlay 插件给的定位/尺寸：容器按 anchor 对齐、按 margin 留边，面板本体按
  // width/minWidth/maxHeight 定尺寸。没有 layout（非 overlay）时按默认宽度铺满内容列 ——
  // 插槽位置对两种 custom 是一样的（见 ChatWindow 的插槽注释）。
  // issue #114：行级语义识别 → 网页化视图；识别不到或被用户切回原样就按原样渲染。
  // 面板含 pi-tui 的可选列表原语时（request.selectList），连带启用「光标列列表」识别 ——
  // 这时点击是直接设置选中项，不模拟按键，所以放宽识别没有点错项的风险。
  const panelView = useMemo(
    () => buildPanelView(displayLines, { allowCursorList: request.selectList === true }),
    [displayLines, request.selectList],
  );
  // 面板内部**按插件自己画的 ANSI 行原样渲染**（用户口径 2026-10-01：网页化先停用，
  // 内容与输入都由插件自己控制）。`ExtensionPanelWebView` 与行级语义识别（issue #114）
  // 的实现都留着，恢复只需把这个常量改回 `!rawMode && shouldRenderPanelWebView(panelView)`。
  const webViewEnabled = false;
  void shouldRenderPanelWebView;
  /**
   * 标题栏文案：优先用插件自己画的标题行，识别不到才退回通用名。
   *
   * 为什么要把插件画的标题再写一遍到外壳标题栏：标题栏是**唯一跨面板稳定**的那一行 ——
   * 面板正文按插件原文渲染，而同一段流程里可能连着开好几个面板（/advisor-models 先选
   * Executor 模型、再选 Advisor 模型，正文长得几乎一样），标题栏不写清楚就分不出自己
   * 正在回答哪一个问题（用户口径 2026-10-06）。
   *
   * 识别口径复用 pi-tui 的观感：加粗且短的那一行 = 标题（见 lib/extension-panel-view.ts
   * 的 isHeadingRow）；识别不到不猜，退回通用文案。
   */
  const panelTitle = useMemo(() => {
    const heading = panelView.blocks.find((block) => block.kind === "heading");
    const text = heading?.plainLines.join(" ").trim();
    return text ? text : t("chat_extensionPanel");
  }, [panelView, t]);

  const overlayStyles = buildExtensionOverlayStyle(request.layout);
  // 面板里 Input 原语的文本 —— 网页输入框停用后这里不再渲染，保留供恢复时使用。
  const [panelInputValue, setPanelInputValue] = useState(request.inputValue ?? "");
  void panelInputValue;
  const inputValueTimer = useRef<number | null>(null);
  useEffect(() => {
    // 换了面板或服务端初值变了就重置；打字期间不覆盖本地（否则光标会跳）
    setPanelInputValue(request.inputValue ?? "");
  }, [request.id]);
  useEffect(() => () => { if (inputValueTimer.current !== null) window.clearTimeout(inputValueTimer.current); }, []);

  /**
   * 键盘焦点由**服务端**驱动（overlay 句柄的 focus/unfocus → request.focus）：
   *
   * - `panel` 或缺省：面板 keytrap 持有焦点（默认，与之前一致）；
   * - `editor` / `none`：让出焦点（前者由 useEffect 之外的 `focusEditor` 副作用把焦点
   *   交给输入框；后者谁也不聚焦）。
   *
   * 依赖是**具体字段**（不是每帧）：只有面板身份/焦点归属/可见性变化时才动 DOM，
   * 用户自己点到面板内的输入框不会被抢回去。
   */
  useEffect(() => {
    if (request.hidden) return;
    const input = inputRef.current;
    if (!input) return;
    // 手机端不抢焦点：一聚焦软键盘就顶上来盖住面板（方向键走屏幕按键条）。
    if (isMobile) { input.blur(); return; }
    // editor / none：服务端要求把键盘让给编辑器或谁也不给。
    if (request.focus === "editor" || request.focus === "none") { input.blur(); return; }
    // panel（或缺省）：**焦点必须落在 keytrap**。这里以前两个分支都 blur，于是焦点留在
    // body —— 方向键与回车到不了插件组件的 handleInput，面板看着「按不动、选不了」，
    // ask-user 的「Type something.」正是靠 ↓ + ⏎ 选出来的（2026-10-01 实测定位）。
    input.focus({ preventScroll: true });
  }, [request.focus, request.hidden, request.id, isMobile]);

  /**
   * 上报几何：挂载时一次、尺寸变化时、窗口缩放/滚动时、以及**恢复可见**时。
   *
   * 后台标签不上报（见 shouldReportCustomPanelBounds）：那时布局不可信，报上去会把
   * 插件刚拿到的正确值覆盖掉。量不出（字体探针失败 / 未布局）同样不报。
   */
  useEffect(() => {
    if (request.hidden || !onBounds) return;
    const report = () => {
      const body = bodyRef.current;
      const scroller = body?.closest('[data-chat-scroller="true"]') ?? null;
      const bounds = body
        ? customPanelBoundsFromRects({
            bodyRect: body.getBoundingClientRect(),
            containerRect: (scroller ?? document.documentElement).getBoundingClientRect(),
            charWidth: measureCharWidth(body),
            lineHeight: measureLineHeight(body),
          })
        : null;
      const visible = document.visibilityState === "visible";
      const requestIds = { previous: lastBoundsIdRef.current, next: request.id };
      if (!shouldReportCustomPanelBounds(lastBoundsRef.current, bounds, visible, requestIds)) return;
      lastBoundsRef.current = bounds;
      lastBoundsIdRef.current = request.id;
      if (bounds) onBounds(requestRef.current, bounds);
    };
    report();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(report);
    if (observer && bodyRef.current) observer.observe(bodyRef.current);
    window.addEventListener("resize", report);
    // 捕获阶段：滚动事件不冒泡，而滚动区滚动会让面板相对滚动区的坐标变。
    window.addEventListener("scroll", report, true);
    document.addEventListener("visibilitychange", report);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", report);
      window.removeEventListener("scroll", report, true);
      document.removeEventListener("visibilitychange", report);
    };
  }, [onBounds, request.hidden, request.id]);

  const copyBody = async () => {
    try {
      await navigator.clipboard.writeText(plainText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  const selectedText = () => (typeof window === "undefined" ? "" : window.getSelection()?.toString() ?? "");

  /**
   * 面板可见期间**保住键盘**：焦点一旦落到面板之外就收回面板的输入区。
   * 不这样做的话，用户点一下别处（焦点落到 body）之后按键会走窗口 ③，
   * 只到插件的全局 onTerminalInput，而面板组件的 handleInput 收不到 ——
   * 用户看到的就是「面板里的选项无法控制」。TUI 里 overlay 拿到键盘后也是这个语义。
   */
  useEffect(() => {
    if (request.hidden) return undefined;
    // 手机端不挂焦点守卫：守卫会把焦点塞给 keytrap（textarea），一点面板软键盘就顶上来。
    // 手机上方向键/回车走屏幕按键条（issue #113），不依赖焦点。
    if (isMobile) return undefined;
    const refocus = () => {
      const input = inputRef.current;
      const rootEl = document.querySelector('[data-extension-panel="true"]');
      if (!input || !rootEl) return;
      const active = document.activeElement;
      if (active && rootEl.contains(active)) return; // 焦点还在面板里（含面板内的按钮）→ 不抢
      input.focus();
    };
    // focusout：焦点离开面板时补回来；click：用户点到页面别处时补回来
    document.addEventListener("focusout", refocus, true);
    document.addEventListener("click", refocus, true);
    return () => {
      document.removeEventListener("focusout", refocus, true);
      document.removeEventListener("click", refocus, true);
    };
  }, [request.hidden, request.id, isMobile]);

  if (request.hidden) return null;

  return (
    <div
      data-extension-panel="true"
      className="extension-panel-custom"
      style={bottomInset > 0 ? { paddingBottom: `calc(${bottomInset}px + env(safe-area-inset-bottom))` } : undefined}
    >
      <ExtensionPanelChrome
        overlay={Boolean(request.layout)}
        panelStyle={overlayStyles?.panelStyle}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
        title={panelTitle}
        // 中断入口放在底栏（与问答块的「取消」同一位置/同一语义）：标题行只有折叠，
        // 而这类面板是扩展自绘的 TUI 界面，没有底栏就等于没有鼠标退出口
        // （键盘 Esc/Ctrl+C 由 keytrap 转发，手机上没有键盘）。
        footer={(
          <button
            type="button"
            className="extension-card-btn"
            title={t("extension_cancel")}
            aria-label={t("extension_cancel")}
            onClick={() => onInput(request, "\x03")}
          >
            {t("extension_cancel")}
          </button>
        )}
        footerActions={(
          <>
            {keyBar}
            {/*
              「切回原样」暂时隐藏（用户要求）：行级语义识别对多数插件面板看不出差别
              （只有制表边框换成 CSS 细线、识别出的选项变可点按钮这两处会变），按钮摆在那里
              只让人以为没生效。能力仍在 —— rawMode / onToggleRawMode 两个 prop 保留，
              恢复只需把这里那个按钮放回来。
            */}
          <button
            type="button"
            className="extension-card-btn"
            onClick={() => { void copyBody(); }}
            aria-label={copied ? t("extension_copied") : t("extension_copy")}
          >
            {copied ? t("extension_copied") : t("extension_copy")}
          </button>
          {/*
            「输入法」只在手机显示：面板正文是插件画的终端行，里面的搜索框/输入原语要打字，
            而手机端**平时不让 keytrap 拿焦点**（一聚焦软键盘就顶上来盖住面板，方向键走屏幕
            按键条，见上面的焦点 effect）。需要打字时由这个按钮把焦点交过去一次 —— 必须是
            用户手势，浏览器才允许弹软键盘。桌面有物理键盘，keytrap 一直聚焦着，不需要它。
          */}
          {isMobile ? (
            <button
              type="button"
              className="extension-card-btn"
              onClick={() => { inputRef.current?.focus({ preventScroll: true }); }}
              aria-label={t("extension_showKeyboard")}
              title={t("extension_showKeyboard")}
            >
              {t("extension_showKeyboard")}
            </button>
          ) : null}
          </>
        )}
      >
        {/*
          keytrap **可编辑**、也没有 inputMode="none"：手机端靠底栏「输入法」按钮聚焦它来弹
          软键盘（readOnly 的输入框 focus() 也弹不出系统键盘）。它 1px、透明、
          pointer-events:none，点不到、只能被程序化聚焦 —— 所以平时不会自己冒出键盘。
          （手机上打字＝每个字符一次往返，重排整块面板；与桌面走的是同一条通道。）
        */}
        <textarea
          ref={inputRef}
          data-extension-keytrap="true"
          aria-label={t("chat_extensionPanel")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            if (!shouldCaptureCustomPanelKey(event, selectedText())) return;
            const data = toTerminalKeyData(event);
            if (!data) return;
            event.preventDefault();
            event.stopPropagation();
            onInput(request, data);
          }}
          onInput={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = "";
            if (text) onInput(request, text);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const input = event.currentTarget;
            queueMicrotask(() => {
              const text = input.value;
              input.value = "";
              if (text) onInput(request, text);
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text");
            if (text) onInput(request, asBracketedPaste(text));
          }}
          className="extension-panel-keytrap"
        />
        {/*
          面板里的 pi-tui Input 原语不再由我们渲染成网页输入框（issue #116 的呈现那半
          先停用）：输入改由插件组件自己处理 —— 焦点在 keytrap 上，按键原样转发给它的
          handleInput()。要恢复时把上面那段 <input data-extension-input> 放回来，
          并接上 onInputValue。
        */}
        <pre
          style={overlayStyles?.bodyWidthCh ? { width: `${overlayStyles.bodyWidthCh}ch` } : undefined}
          ref={bodyRef}
          className="extension-panel-ansi"
          onClick={(event) => {
            // 组件树里的 MouseRegion / widget 折叠靠它；没有 onMouse 就不转发，
            // 字符宽量不出时（见 toPanelMouseEvent）也不转发。
            const mouse = toPanelMouseEvent(event);
            if (mouse) onMouse?.(request, mouse);
          }}
        >
          {webViewEnabled ? (
            <ExtensionPanelWebView
              view={panelView}
              renderLine={renderAnsiLine}
              onSelectOption={onSelectOption}
            />
          ) : (
          <RenderedLineBlocks
            lines={displayLines.length ? displayLines : [""]}
            images={displayImages}
            imageFallbacks={displayImageFallbacks}
            keyPrefix="panel-line"
            renderLine={renderAnsiLine}
            imageAlt={t("message_imageAlt")}
            fallbackLabel={(reason) => { const key = imageFallbackReasonKey(reason); return t("message_imageUnavailable", { reason: key ? t(key) : reason }); }}
          />
          )}
        </pre>
      </ExtensionPanelChrome>
    </div>
  );
}

