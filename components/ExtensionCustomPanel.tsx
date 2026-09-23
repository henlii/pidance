"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { normalizeCustomPanelLines, parseAnsiLine, stripAnsi } from "@/lib/ansi";
import { shouldCaptureCustomPanelKey } from "@/lib/extension-panel-keys";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { useI18n } from "@/lib/i18n";
import type { ExtensionUiCustomRequest } from "@/lib/extension-ui-bridge";
import { ExtensionPanelChrome } from "./ExtensionPanelChrome";

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
}: {
  request: ExtensionUiCustomRequest;
  onInput: (request: ExtensionUiCustomRequest, data: string) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const [copied, setCopied] = useState(false);
  const displayLines = normalizeCustomPanelLines(request.lines);
  const plainText = displayLines.map((line) => stripAnsi(line)).join("\n");

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

  return (
    <div className="extension-panel-overlay">
      <ExtensionPanelChrome
        overlay
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
        <pre className="extension-panel-ansi">
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
