"use client";

import { useRef, useState, type CSSProperties } from "react";
import type { ExtensionUiDialogRequest } from "@/lib/extension-ui-bridge";
import { useI18n } from "@/lib/i18n";
import { MarkdownBody } from "./MarkdownBody";
import { ExtensionPanelChrome } from "./ExtensionPanelChrome";

export type ExtensionDialogResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

export interface ExtensionDialogProps {
  request: ExtensionUiDialogRequest;
  disabled?: boolean;
  onRespond: (response: ExtensionDialogResponse) => void;
}

function requestHasExpired(request: ExtensionUiDialogRequest): boolean {
  return typeof request.expiresAt === "number"
    && Number.isFinite(request.expiresAt)
    && request.expiresAt <= Date.now();
}

const inputStyle: CSSProperties = {
  minWidth: 0,
  width: "100%",
  minHeight: 40,
  padding: "8px 12px",
  border: "1px solid var(--border)",
  borderRadius: 8,
  outline: "none",
  background: "var(--bg)",
  color: "var(--text)",
  font: "inherit",
  fontSize: 14,
  boxSizing: "border-box",
};

/**
 * 扩展阻塞请求面板（select/confirm/input/editor）。
 * GUI 外壳 + 原生控件；响应必须显式给出。Esc 仅在 input/editor 内处理。
 */
export function ExtensionDialog({ request, disabled = false, onRespond }: ExtensionDialogProps) {
  const { t } = useI18n();
  const respondedRequestRef = useRef<string | null>(null);
  const [respondedRequestId, setRespondedRequestId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ requestId: string; value: string }>({
    requestId: request.id,
    value: "",
  });
  const [editorDraft, setEditorDraft] = useState<{ requestId: string; value: string }>({
    requestId: request.id,
    value: request.method === "editor" ? request.prefill ?? "" : "",
  });
  const editorValue = editorDraft.requestId === request.id ? editorDraft.value : "";
  const value = draft.requestId === request.id ? draft.value : "";
  const expired = requestHasExpired(request);
  const responded = respondedRequestId === request.id;
  const inert = disabled || expired || responded;
  const boundRequestId = request.id;

  const respondOnce = (response: ExtensionDialogResponse) => {
    if (disabled || respondedRequestRef.current === boundRequestId || requestHasExpired(request)) {
      return;
    }
    respondedRequestRef.current = boundRequestId;
    setRespondedRequestId(boundRequestId);
    onRespond(response);
  };

  const setValue = (nextValue: string) => {
    setDraft({ requestId: request.id, value: nextValue });
  };

  const selectOptions = request.method === "select" ? request.options : [];
  const statusMessage = expired
    ? t("extension_expired")
    : disabled
      ? t("extension_waitingEnded")
      : responded
        ? t("extension_responseSent")
        : null;

  const cancelButton = (
    <button
      type="button"
      className="extension-card-btn"
      disabled={inert}
      title={t("extension_cancel")}
      aria-label={t("extension_cancel")}
      onClick={() => respondOnce({ cancelled: true })}
    >
      {t("extension_cancel")}
    </button>
  );

  const footer = request.method === "confirm" ? (
    <>
      {cancelButton}
      <button
        type="button"
        className="extension-card-btn extension-card-btn--primary"
        disabled={inert}
        title={t("extension_confirm")}
        aria-label={t("extension_confirm")}
        onClick={() => respondOnce({ confirmed: true })}
      >
        {t("extension_confirm")}
      </button>
    </>
  ) : request.method === "input" || request.method === "editor" ? (
    <>
      {cancelButton}
      <button
        type="button"
        className="extension-card-btn extension-card-btn--primary"
        disabled={inert}
        title={t("extension_submit")}
        aria-label={t("extension_submit")}
        onClick={() => respondOnce({ value: request.method === "editor" ? editorValue : value })}
      >
        {t("extension_submit")}
      </button>
      {request.method === "editor" ? (
        <span className="extension-panel-hint">{t("extension_ctrlEnterHint")}</span>
      ) : null}
    </>
  ) : (
    cancelButton
  );

  return (
    <div className="extension-panel-inline">
      <ExtensionPanelChrome
        title={<MarkdownBody className="markdown-body--extension">{request.title}</MarkdownBody>}
        accessibilityLabel={request.title}
        footer={(
          <>
            {footer}
            {statusMessage ? (
              <span className="extension-panel-status" role="status" aria-live="polite">{statusMessage}</span>
            ) : null}
          </>
        )}
      >
        {request.method === "confirm" && (
          <div className="extension-panel-copy">
            <MarkdownBody className="markdown-body--extension">{request.message}</MarkdownBody>
          </div>
        )}

        {request.method === "input" && (
          <input
            value={value}
            disabled={inert}
            placeholder={request.placeholder}
            aria-label={request.title}
            autoComplete="off"
            autoFocus
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                respondOnce({ value });
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (value.length > 0) setValue("");
                else event.currentTarget.blur();
              }
            }}
            style={inputStyle}
          />
        )}

        {request.method === "editor" && (
          <textarea
            value={editorValue}
            disabled={inert}
            placeholder={request.prefill ?? ""}
            aria-label={request.title}
            autoComplete="off"
            autoFocus
            onChange={(event) => setEditorDraft({ requestId: request.id, value: event.target.value })}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                respondOnce({ value: editorValue });
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                respondOnce({ cancelled: true });
              }
            }}
            className="extension-panel-editor"
          />
        )}

        {request.method === "select" && (
          <div role="group" aria-label={t("extension_selectAnOption")} className="extension-option-list">
            {selectOptions.map((option, index) => (
              <button
                key={`${index}-${option}`}
                type="button"
                className="extension-option-btn"
                disabled={inert}
                title={option}
                onClick={() => respondOnce({ value: option })}
              >
                {option}
              </button>
            ))}
          </div>
        )}
      </ExtensionPanelChrome>
    </div>
  );
}

