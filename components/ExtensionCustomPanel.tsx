"use client";

import { useEffect, useRef, useState } from "react";
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
  onBounds,
}: {
  request: ExtensionUiCustomRequest;
  onInput: (request: ExtensionUiCustomRequest, data: string) => void;
  onMouse?: (request: ExtensionUiCustomRequest, event: Record<string, unknown>) => void;
  /**
   * 面板几何（字符单元格）上报出口。面板的 `getBounds()` 是**同步**接口，所以只能
   * 由这里量出来推给服务端存下（口径与理由见 lib/custom-panel-bounds.ts）。
   */
  onBounds?: (request: ExtensionUiCustomRequest, bounds: CustomPanelBounds) => void;
}) {
  const { t } = useI18n();
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
  // width/minWidth/maxHeight 定尺寸。没有 layout（非 overlay）时保持全屏模态。
  const overlayStyles = buildExtensionOverlayStyle(request.layout);

  /**
   * 键盘焦点由**服务端**驱动（overlay 句柄的 focus/unfocus → request.focus）：
   *
   * - `panel` 或缺省：面板 keytrap 持有焦点（默认，与之前一致）；
   * - `editor` / `none`：让出焦点（前者由 useEffect 之外的 `focusEditor` 副作用把焦点
   *   交给输入框；后者谁也不聚焦）。
   *
   * 只在**值变化**时动 DOM：每帧都 focus 会把用户刚点到输入框的焦点抢回面板。
   */
  useEffect(() => {
    if (request.hidden) return;
    const input = inputRef.current;
    if (!input) return;
    if (request.focus === undefined || request.focus === "panel") input.focus();
    else input.blur();
  }, [request.focus, request.hidden, request.id]);

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

  if (request.hidden) return null;

  return (
    <div className="extension-panel-overlay" style={overlayStyles?.containerStyle}>
      <ExtensionPanelChrome
        overlay
        panelStyle={overlayStyles?.panelStyle}
        title={t("chat_extensionPanel")}
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
        extraHeader={(
          <button
            type="button"
            className="extension-card-btn"
            onClick={() => { void copyBody(); }}
            aria-label={copied ? t("extension_copied") : t("extension_copy")}
          >
            {copied ? t("extension_copied") : t("extension_copy")}
          </button>
        )}
      >
        <textarea
          ref={inputRef}
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
        <pre
          ref={bodyRef}
          className="extension-panel-ansi"
          onClick={(event) => {
            // 组件树里的 MouseRegion / widget 折叠靠它；没有 onMouse 就不转发，
            // 字符宽量不出时（见 toPanelMouseEvent）也不转发。
            const mouse = toPanelMouseEvent(event);
            if (mouse) onMouse?.(request, mouse);
          }}
        >
          <RenderedLineBlocks
            lines={displayLines.length ? displayLines : [""]}
            images={displayImages}
            imageFallbacks={displayImageFallbacks}
            keyPrefix="panel-line"
            renderLine={renderAnsiLine}
            imageAlt={t("message_imageAlt")}
            fallbackLabel={(reason) => { const key = imageFallbackReasonKey(reason); return t("message_imageUnavailable", { reason: key ? t(key) : reason }); }}
          />
        </pre>
      </ExtensionPanelChrome>
    </div>
  );
}

