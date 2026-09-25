"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
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

/**
 * 距离过期还剩多少秒（向上取整，最小 0）；没有绝对过期时刻时返回 null。
 *
 * 每次都用 `expiresAt - now` **重算**而不是自己递减：页面挂起、后台节流之后
 * 递减值会漂移，重算则与宿主（真正结算超时的那一侧）始终一致。
 */
export function dialogRemainingSeconds(expiresAt: unknown, now: number): number | null {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

function requestHasExpired(request: ExtensionUiDialogRequest, now: number): boolean {
  const remaining = dialogRemainingSeconds(request.expiresAt, now);
  return remaining !== null && remaining <= 0;
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
  /**
   * 用来算剩余秒数的「现在」。倒计时必须自己走：只靠状态轮询的话，到点后
   * 按钮最长会继续可点一个轮询周期（宿主已经按取消结算了）。
   */
  const [now, setNow] = useState(() => Date.now());
  const expiresAt = typeof request.expiresAt === "number" && Number.isFinite(request.expiresAt)
    ? request.expiresAt
    : null;
  useEffect(() => {
    if (expiresAt === null) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const tick = () => {
      // 隐藏标签页不重渲（多端约定：后台不轮询/不重渲），可见时由 visibilitychange 补一次。
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const at = Date.now();
      setNow(at);
      if (at >= expiresAt) stop();
    };
    tick();
    timer = setInterval(tick, 1000);
    const onVisibility = () => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [expiresAt, request.id]);
  const remainingSeconds = dialogRemainingSeconds(expiresAt, now);
  // 没有绝对过期时刻（宿主没给 timeout）→ 永不过期，行为与从前一致。
  const expired = remainingSeconds !== null && remainingSeconds <= 0;
  const responded = respondedRequestId === request.id;
  const inert = disabled || expired || responded;
  const boundRequestId = request.id;

  const respondOnce = (response: ExtensionDialogResponse) => {
    if (disabled || respondedRequestRef.current === boundRequestId || requestHasExpired(request, Date.now())) {
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
  /**
   * 倒计时与状态文案共用底栏右侧（两者都是 margin-left: auto），一次只显示一个。
   *
   * 有倒计时就显示倒计时 —— **包括本端不能回答的只读/被对端持有写权的情况**：
   * 那时更需要知道宿主什么时候会把它收走（调用方就是按这个传 disabled 的）。
   * 到点后再由状态文案说明为什么点不动。
   */
  const countdown = !responded && remainingSeconds !== null && remainingSeconds > 0
    ? t("extension_expiresIn", { seconds: String(remainingSeconds) })
    : null;
  const statusMessage = expired
    ? t("extension_expired")
    : responded
      ? t("extension_responseSent")
      : disabled && countdown === null
        ? t("extension_waitingEnded")
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
            {countdown ? (
              // aria-live="off"：每秒变化不该被读屏播报（到点的「已过期」才是要播报的状态）。
              <span className="extension-panel-hint" aria-live="off" suppressHydrationWarning>{countdown}</span>
            ) : null}
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

