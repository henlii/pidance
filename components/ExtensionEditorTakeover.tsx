"use client";

import { useEffect, useRef } from "react";
import { normalizeCustomPanelLinesWithIndex, parseAnsiLine } from "@/lib/ansi";
import { collectImageLineIndexes, remapImageLineIndexes, imageFallbackReasonKey } from "@/lib/kitty-image";
import { shouldCaptureCustomPanelKey } from "@/lib/extension-panel-keys";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { useI18n } from "@/lib/i18n";
import type { ExtensionUiEditorComponentRequest } from "@/lib/extension-ui-bridge";
import { RenderedLineBlocks } from "./RenderedLines";

function renderAnsiLine(line: string, keyPrefix: string) {
  return parseAnsiLine(line).map((segment, index) => (
    segment.style
      ? <span key={`${keyPrefix}-${index}`} style={segment.style}>{segment.text}</span>
      : segment.text
  ));
}

/**
 * 插件自定义编辑器的接管面板（`ctx.ui.setEditorComponent`，issue #107）。
 *
 * 与 TUI 的关系：终端里插件工厂返回的 `EditorComponent` **就是**编辑器本体
 * （聚焦组件，按键先过全局监听器再进它，`onSubmit(text)` 由应用接到发送）。
 * Web 上编辑器是我们自己的 React 输入框，所以接管表现为**在输入框位置**渲染插件组件，
 * 并把按键原样送回服务端（适配器的 `dispatchEditorComponentInput`）。
 *
 * 两个方向都走既有机制，不复刻一套：
 * - 渲染：服务端用渲染桥（`renderMountedComponentOutput`）出 ANSI 行 + 图片，
 *   这里按 custom 面板同一套「归一化 + 图片按行号摆回」显示；
 * - 提交：组件调 `onSubmit` → 服务端只发一条 `editorComponentSubmit` 事件 →
 *   `useAgentSession` 交给**既有发送入口**（队列 / 写者所有权 / 只读判定都在那边）。
 *
 * 退出：壳外一个显式按钮（**不用 Esc** —— 插件组件（Vim 之类）自己要用 Esc 回到普通模式，
 * 拿它当退出键会打断插件内部状态）。退出只是这一页不再显示接管，插件那边一切照旧。
 */
export function ExtensionEditorTakeover({
  request,
  onInput,
  onExit,
  autoFocus = true,
}: {
  request: ExtensionUiEditorComponentRequest;
  onInput: (request: ExtensionUiEditorComponentRequest, data: string) => void;
  /** 「返回输入框」：本页收起接管（下次刷新/插件重设仍会回来）。 */
  onExit: () => void;
  /**
   * 是否把键盘交给接管面板。
   *
   * 正在显示的插件浮层 / 扩展对话框要拿键盘（TUI 里 overlay 会把焦点从编辑器拿走），
   * 那时接管面板照旧显示（它仍是输入区）但**不**抢焦点，否则按键会进错地方。
   */
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  /**
   * 观察者与按键处理只挂一次，靠 ref 读最新 request —— 插件每敲一个键就重渲一帧、
   * 换一个 request 对象，直接进依赖数组会让 keytrap 每帧重建（也会丢焦点）。
   */
  const requestRef = useRef(request);
  requestRef.current = request;
  /** 图片与降级说明按**原文行号**标注；归一化会删框线、裁首尾空行，锚点必须保留。 */
  const imageLineIndexes = collectImageLineIndexes(request.images, request.imageFallbacks);
  const normalized = normalizeCustomPanelLinesWithIndex(request.lines ?? [], { keep: imageLineIndexes });
  const displayLines = normalized.lines;
  const displayImages = remapImageLineIndexes(request.images, normalized.sourceIndex).items;
  const displayImageFallbacks = remapImageLineIndexes(request.imageFallbacks, normalized.sourceIndex).items;

  // 接管就该拿键盘：挂载/换接管（以及浮层让出键盘）时把焦点交给 keytrap
  //（只在值变化时动 DOM，用户点别处不会被反复抢）。
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [request.id, autoFocus]);

  const send = (data: string) => {
    if (data) onInput(requestRef.current, data);
  };

  return (
    <div
      style={{ flexShrink: 0, padding: "0 12px 8px" }}
      data-extension-editor-takeover={request.id}
    >
      <section
        role="group"
        aria-label={t("chat_editorTakeover")}
        className="extension-panel-shell extension-panel-shell--expanded"
        style={{ margin: "0 auto" }}
      >
        <header
          className="extension-panel-header"
          style={{ display: "flex", alignItems: "center", gap: 8, cursor: "default" }}
        >
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("chat_editorTakeover")}
          </span>
          {/*
            退出按钮必须一直可见：接管期间我们的输入框不渲染，没有它用户可能被困在
            插件编辑器里（键盘 Esc 是插件的，不是我们的）。
          */}
          <button
            type="button"
            className="extension-card-btn"
            onClick={onExit}
            aria-label={t("chat_editorTakeoverExit")}
            title={t("chat_editorTakeoverExit")}
          >
            {t("chat_editorTakeoverExit")}
          </button>
        </header>
        <textarea
          ref={inputRef}
          aria-label={t("chat_editorTakeover")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="extension-panel-keytrap"
          onKeyDown={(event) => {
            // 合成中不路由：合成提交那一下会先来一个 Enter/Esc，
            // 当成插件按键会让插件把半截拼音吃进去。
            if (composingRef.current || event.nativeEvent.isComposing) return;
            if (!shouldCaptureCustomPanelKey(event, window.getSelection()?.toString() ?? "")) return;
            const data = toTerminalKeyData(event);
            if (!data) return;
            // 插件编辑器就是聚焦组件：这个键归它，页面不再响应（方向键滚页之类）。
            event.preventDefault();
            event.stopPropagation();
            send(data);
          }}
          onInput={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = "";
            if (text) send(text);
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
              if (text) send(text);
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text");
            if (text) send(asBracketedPaste(text));
          }}
        />
        <pre className="extension-panel-ansi" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          <RenderedLineBlocks
            lines={displayLines.length ? displayLines : [""]}
            images={displayImages}
            imageFallbacks={displayImageFallbacks}
            keyPrefix="editor-line"
            renderLine={renderAnsiLine}
            imageAlt={t("message_imageAlt")}
            fallbackLabel={(reason) => {
              const key = imageFallbackReasonKey(reason);
              return t("message_imageUnavailable", { reason: key ? t(key) : reason });
            }}
          />
        </pre>
        <div style={{ fontSize: 11, color: "var(--text-dim)", padding: "4px 10px 0" }}>
          {t("chat_editorTakeoverHint")}
        </div>
      </section>
    </div>
  );
}

/**
 * 收起后的细条：告知插件编辑器还在，并给出「回到插件编辑器」的入口。
 *
 * 为什么不是「退出即永久消失」：插件仍认为自己拥有编辑器，用户可能只是想用一会儿
 * 我们自己的输入框（附件、@ 引用、多行）。没有这个入口的话，重新拿到它只能刷新页面。
 */
export function ExtensionEditorTakeoverBar({ onReenter }: { onReenter: () => void }) {
  const { t } = useI18n();
  return (
    <div style={{ flexShrink: 0, padding: "0 12px 6px" }}>
      <div
        role="status"
        style={{
          display: "flex", alignItems: "center", gap: 8, maxWidth: 900, margin: "0 auto",
          fontSize: 12, color: "var(--text-dim)",
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>{t("chat_editorTakeoverCollapsed")}</span>
        <button
          type="button"
          className="extension-card-btn"
          onClick={onReenter}
          aria-label={t("chat_editorTakeoverReenter")}
          title={t("chat_editorTakeoverReenter")}
        >
          {t("chat_editorTakeoverReenter")}
        </button>
      </div>
    </div>
  );
}
