"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { normalizeCustomPanelLines, parseAnsiLine, stripAnsi } from "@/lib/ansi";
import { shouldCaptureCustomPanelKey } from "@/lib/extension-panel-keys";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { buildExtensionOverlayStyle } from "@/lib/extension-overlay-layout";
import { useI18n } from "@/lib/i18n";
import type { ExtensionUiCustomRequest } from "@/lib/extension-ui-bridge";
import { ExtensionPanelChrome } from "./ExtensionPanelChrome";

/** 等宽字符宽度（px）：`ch` 就是等宽字体的字符宽，用探针量一次后缓存。 */
let cachedCharWidth: number | null = null;
function measureCharWidth(host: HTMLElement): number {
  if (cachedCharWidth !== null) return cachedCharWidth;
  const probe = document.createElement("span");
  probe.textContent = "0".repeat(100);
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
  host.appendChild(probe);
  cachedCharWidth = probe.getBoundingClientRect().width / 100 || 8;
  probe.remove();
  return cachedCharWidth;
}

/**
 * DOM 点击坐标 → 面板内的字符行列（pi-tui 的 TuiMouseEvent 用字符坐标）。
 * 行按实际行高算；列按等宽字符宽算。滚动位置一并计入。
 */
function toPanelMouseEvent(
  event: React.MouseEvent<HTMLPreElement>,
): Record<string, unknown> {
  const el = event.currentTarget;
  const rect = el.getBoundingClientRect();
  const styles = window.getComputedStyle(el);
  const fontSize = Number.parseFloat(styles.fontSize) || 12;
  const lineHeight = Number.parseFloat(styles.lineHeight) || fontSize * 1.5;
  const charWidth = measureCharWidth(el);
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
}: {
  request: ExtensionUiCustomRequest;
  onInput: (request: ExtensionUiCustomRequest, data: string) => void;
  onMouse?: (request: ExtensionUiCustomRequest, event: Record<string, unknown>) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const [copied, setCopied] = useState(false);
  const displayLines = normalizeCustomPanelLines(request.lines);
  const plainText = displayLines.map((line) => stripAnsi(line)).join("\n");

  // overlay 插件给的定位/尺寸：容器按 anchor 对齐、按 margin 留边，面板本体按
  // width/minWidth/maxHeight 定尺寸。没有 layout（非 overlay）时保持全屏模态。
  const overlayStyles = buildExtensionOverlayStyle(request.layout);

  useEffect(() => {
    inputRef.current?.focus();
  }, [request.id]);

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
          className="extension-panel-ansi"
          onClick={(event) => {
            // 组件树里的 MouseRegion / widget 折叠靠它；没有 onMouse 就不转发
            onMouse?.(request, toPanelMouseEvent(event));
          }}
        >
          {(displayLines.length ? displayLines : [""]).map((line, index, allLines) => (
            <Fragment key={index}>
              {renderAnsiLine(line, `line-${index}`)}
              {index < allLines.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </pre>
      </ExtensionPanelChrome>
    </div>
  );
}

