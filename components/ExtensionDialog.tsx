"use client";

import { useRef, useState, type CSSProperties } from "react";
import type { ExtensionUiDialogRequest } from "@/lib/extension-ui-bridge";
import { useI18n } from "@/lib/i18n";
import { MarkdownBody } from "./MarkdownBody";

export type ExtensionDialogResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

export interface ExtensionDialogProps {
  request: ExtensionUiDialogRequest;
  disabled?: boolean;
  onRespond: (response: ExtensionDialogResponse) => void;
}

/** select 弹窗 request-scoped 暂存态（纯函数，便于单测） */
export type InlineSelectCardState = {
  requestId: string;
  selectedValue: string | null;
  otherSelected: boolean;
  otherDraft: string;
};

export function createInlineSelectState(requestId: string): InlineSelectCardState {
  return { requestId, selectedValue: null, otherSelected: false, otherDraft: "" };
}

/** request id 切换时重置 selection/draft */
export function resolveInlineSelectState(
  state: InlineSelectCardState,
  requestId: string,
): InlineSelectCardState {
  return state.requestId === requestId ? state : createInlineSelectState(requestId);
}

export function selectInlineOption(
  state: InlineSelectCardState,
  value: string,
): InlineSelectCardState {
  return { ...state, selectedValue: value, otherSelected: false };
}

export function selectInlineOther(state: InlineSelectCardState): InlineSelectCardState {
  return { ...state, otherSelected: true, selectedValue: null };
}

export function setInlineOtherDraft(
  state: InlineSelectCardState,
  draft: string,
): InlineSelectCardState {
  return { ...state, otherDraft: draft };
}

export function getInlineSelectSubmission(
  state: InlineSelectCardState,
): { value: string } | null {
  if (state.otherSelected) {
    const trimmed = state.otherDraft.trim();
    return trimmed ? { value: trimmed } : null;
  }
  if (state.selectedValue !== null) {
    return { value: state.selectedValue };
  }
  return null;
}

export function canSubmitInlineSelect(state: InlineSelectCardState): boolean {
  return getInlineSelectSubmission(state) !== null;
}

export function isOtherOptionLabel(label: string, localeOtherText: string): boolean {
  const normalized = label.trim().toLowerCase();
  const other = localeOtherText.trim().toLowerCase();
  // 识别 ask-user 等插件的 "N. Type something." 哨兵项（含编号前缀），避免重复附加
  return (
    normalized === other ||
    normalized === "other" ||
    normalized === "其它" ||
    normalized === "其他" ||
    normalized.includes("type something")
  );
}

export function shouldAppendOtherOption(
  options: readonly string[],
  localeOtherText: string,
): boolean {
  return !options.some((option) => isOtherOptionLabel(option, localeOtherText));
}

function requestHasExpired(request: ExtensionUiDialogRequest): boolean {
  return typeof request.expiresAt === "number"
    && Number.isFinite(request.expiresAt)
    && request.expiresAt <= Date.now();
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

const optionButtonBaseStyle: CSSProperties = {
  maxWidth: "100%",
  minHeight: 26,
  padding: "3px 9px",
  overflow: "hidden",
  border: "1px solid var(--border)",
  borderRadius: 6,
  font: "inherit",
  fontSize: 12,
  lineHeight: 1.35,
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const inputStyle: CSSProperties = {
  minWidth: 0,
  height: 28,
  flex: 1,
  padding: "0 8px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  outline: "none",
  background: "var(--bg)",
  color: "var(--text)",
  font: "inherit",
  fontSize: 12,
};

/**
 * 扩展阻塞请求弹窗（对齐 Pi TUI：select/confirm/input/editor 一律 modal 承载）。
 *
 * 覆盖层固定视口居中，遮罩点击不关闭（响应必须显式给出，避免伪造协议响应）；
 * Esc 仅在 input/editor 内处理，不冒泡关闭弹窗。
 */
export function ExtensionDialog({ request, disabled = false, onRespond }: ExtensionDialogProps) {
  const { t } = useI18n();
  const respondedRequestRef = useRef<string | null>(null);
  const [respondedRequestId, setRespondedRequestId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ requestId: string; value: string }>({
    requestId: request.id,
    value: "",
  });
  const [selectState, setSelectState] = useState<InlineSelectCardState>(() =>
    createInlineSelectState(request.id),
  );
  /** editor 长文本草稿（prefill 初始值）。 */
  const [editorDraft, setEditorDraft] = useState<{ requestId: string; value: string }>({
    requestId: request.id,
    value: request.method === "editor" ? request.prefill ?? "" : "",
  });
  const editorValue = editorDraft.requestId === request.id ? editorDraft.value : "";

  const value = draft.requestId === request.id ? draft.value : "";
  const scopedSelect = resolveInlineSelectState(selectState, request.id);
  const expired = requestHasExpired(request);
  const responded = respondedRequestId === request.id;
  const inert = disabled || expired || responded;

  // 闭包绑定本轮 request：旧 handler 只能响应当次渲染的 id
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

  const patchSelect = (next: InlineSelectCardState) => {
    setSelectState(next.requestId === request.id ? next : createInlineSelectState(request.id));
  };

  const otherLabel = t("extension_other");
  const appendOther = request.method === "select"
    && shouldAppendOtherOption(request.options, otherLabel);
  // ask-user 等场景：存在 Other/Type something 选项时只保留手动输入项
  // （用户直接输入回答，不再显示冗余预设选项）；其余 select 原样展示。
  // 选项完整展示（预设选项 + Other/Type something 手动输入项）；
  // 选中 Other 后显示输入框，提交内容经哨兵+自动 input 响应回到 agent（#28）
  const selectOptions = request.method === "select"
    ? (appendOther ? [...request.options, otherLabel] : request.options)
    : [];
  const selectSubmission = getInlineSelectSubmission(scopedSelect);
  const selectCanSubmit = selectSubmission !== null;

  const statusMessage = expired
    ? t("extension_expired")
    : disabled
      ? t("extension_waitingEnded")
      : responded
        ? t("extension_responseSent")
        : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${t("extension_extension")}: ${request.title}`}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "color-mix(in srgb, var(--bg) 55%, transparent)",
        backdropFilter: "blur(2px)",
      }}
    >
      <section
        aria-label={`${t("extension_extension")}: ${request.title}`}
        style={{
          width: "min(560px, 100%)",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          border: "1px solid color-mix(in srgb, var(--accent) 20%, var(--border))",
          borderRadius: 10,
          background: "var(--bg-panel)",
          boxShadow: "0 12px 40px color-mix(in srgb, var(--bg) 70%, transparent)",
        }}
      >
        <div
          style={{
            display: "flex",
            minHeight: 32,
            alignItems: "center",
            gap: 8,
            padding: "6px 10px 6px 12px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 6,
              height: 6,
              flexShrink: 0,
              borderRadius: "50%",
              background: inert ? "var(--text-dim)" : "var(--accent)",
            }}
          />
          <div
            title={request.title}
            style={{
              minWidth: 0,
              flex: 1,
              overflow: "hidden",
              color: "var(--text)",
              fontSize: 13,
              fontWeight: 650,
            }}
          >
            <MarkdownBody className="markdown-body--extension">{request.title}</MarkdownBody>
          </div>
          <span
            style={{
              flexShrink: 0,
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              fontSize: 9,
              letterSpacing: 0.35,
              textTransform: "uppercase",
            }}
          >
            {t("extension_extension")} · {request.method}
          </span>
        </div>

        <div style={{ padding: "10px 12px", overflowY: "auto" }}>
          {request.method === "confirm" && (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
              <div
                style={{
                  minWidth: 0,
                  flex: 1,
                  color: "var(--text-muted)",
                  fontSize: 12,
                  lineHeight: 1.5,
                  overflowWrap: "anywhere",
                }}
              >
                <MarkdownBody className="markdown-body--extension">{request.message}</MarkdownBody>
              </div>
              <div style={{ display: "flex", flexShrink: 0, alignItems: "center", gap: 5 }}>
                <button
                  type="button"
                  className="sidebar-icon-btn sidebar-icon-btn--danger"
                  disabled={inert}
                  title={t("extension_cancel")}
                  aria-label={t("extension_cancel")}
                  onClick={() => respondOnce({ cancelled: true })}
                >
                  <CloseIcon />
                </button>
                <button
                  type="button"
                  className="sidebar-icon-btn"
                  disabled={inert}
                  title={t("extension_confirm")}
                  aria-label={t("extension_confirm")}
                  onClick={() => respondOnce({ confirmed: true })}
                  style={{ color: "var(--accent)" }}
                >
                  <CheckIcon />
                </button>
              </div>
            </div>
          )}

          {request.method === "input" && (
            <div style={{ display: "flex", minWidth: 0, alignItems: "center", gap: 5 }}>
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

              <button
                type="button"
                className="sidebar-icon-btn"
                disabled={inert}
                title={t("extension_submit")}
                aria-label={t("extension_submit")}
                onClick={() => respondOnce({ value })}
                style={{ color: "var(--accent)" }}
              >
                <CheckIcon />
              </button>
              <button
                type="button"
                className="sidebar-icon-btn sidebar-icon-btn--danger"
                disabled={inert}
                title={t("extension_cancel")}
                aria-label={t("extension_cancel")}
                onClick={() => respondOnce({ cancelled: true })}
              >
                <CloseIcon />
              </button>
            </div>
          )}

          {request.method === "editor" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
                style={{
                  minWidth: 0,
                  minHeight: 110,
                  maxHeight: 320,
                  padding: "8px 10px",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  outline: "none",
                  background: "var(--bg)",
                  color: "var(--text)",
                  font: "inherit",
                  fontSize: 12,
                  lineHeight: 1.55,
                  fontFamily: "var(--font-mono)",
                  resize: "vertical",
                  overflowY: "auto",
                }}
              />
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 5 }}>
                <button
                  type="button"
                  className="extension-card-btn"
                  disabled={inert}
                  title={t("extension_submit")}
                  aria-label={t("extension_submit")}
                  onClick={() => respondOnce({ value: editorValue })}
                  style={{ color: "var(--accent)", borderColor: "var(--accent)" }}
                >
                  {t("extension_submit")}
                </button>
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
                <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-dim)" }}>{t("extension_ctrlEnterHint")}</span>
              </div>
            </div>
          )}
          {request.method === "select" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div
                role="group"
                aria-label={t("extension_selectAnOption")}
                style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
              >
                {selectOptions.map((option, index) => {
                  const isOther = isOtherOptionLabel(option, otherLabel);
                  const isPressed = isOther
                    ? scopedSelect.otherSelected
                    : !scopedSelect.otherSelected && scopedSelect.selectedValue === option;
                  return (
                    <button
                      key={`${index}-${option}`}
                      type="button"
                      disabled={inert}
                      title={option}
                      aria-pressed={isPressed}
                      onClick={() => {
                        if (isOther) patchSelect(selectInlineOther(scopedSelect));
                        else patchSelect(selectInlineOption(scopedSelect, option));
                      }}
                      onMouseEnter={(event) => {
                        if (!inert && !isPressed) {
                          event.currentTarget.style.background = "var(--bg-hover)";
                        }
                      }}
                      onMouseLeave={(event) => {
                        event.currentTarget.style.background = isPressed
                          ? "var(--bg-selected)"
                          : "var(--bg)";
                      }}
                      style={{
                        ...optionButtonBaseStyle,
                        background: isPressed ? "var(--bg-selected)" : "var(--bg)",
                        color: inert ? "var(--text-dim)" : "var(--text)",
                        cursor: inert ? "not-allowed" : "pointer",
                      }}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>

              {scopedSelect.otherSelected && (
                <div style={{ display: "flex", flexDirection: "column", minWidth: 0, gap: 5 }}>
                  <textarea
                    value={scopedSelect.otherDraft}
                    disabled={inert}
                    placeholder={t("extension_otherPlaceholder")}
                    aria-label={t("extension_other")}
                    autoComplete="off"
                    autoFocus
                    rows={1}
                    onChange={(event) => {
                      patchSelect(setInlineOtherDraft(scopedSelect, event.target.value));
                      // 自动高度（最多 4 行）。
                      const el = event.currentTarget;
                      el.style.height = "auto";
                      el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
                    }}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        const submission = getInlineSelectSubmission(
                          setInlineOtherDraft(scopedSelect, event.currentTarget.value),
                        );
                        if (submission) respondOnce(submission);
                        return;
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        if (scopedSelect.otherDraft.length > 0) {
                          patchSelect(setInlineOtherDraft(scopedSelect, ""));
                        } else {
                          event.currentTarget.blur();
                        }
                      }
                    }}
                    style={{
                      minWidth: 0,
                      width: "100%",
                      minHeight: 28,
                      maxHeight: 96,
                      padding: "6px 8px",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      outline: "none",
                      background: "var(--bg)",
                      color: "var(--text)",
                      font: "inherit",
                      fontSize: 12,
                      lineHeight: 1.5,
                      resize: "none",
                      overflowY: "auto",
                      boxSizing: "border-box",
                    }}
                  />
                </div>
              )}

              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 5 }}>
                <button
                  type="button"
                  className="extension-card-btn"
                  disabled={inert || !selectCanSubmit}
                  title={selectCanSubmit ? t("extension_submit") : t("extension_selectAnOption")}
                  aria-label={t("extension_submit")}
                  onClick={() => {
                    const submission = getInlineSelectSubmission(scopedSelect);
                    if (submission) respondOnce(submission);
                  }}
                  style={{ color: "var(--accent)", borderColor: "var(--accent)", opacity: selectCanSubmit ? 1 : 0.45 }}
                >
                  <CheckIcon />
                  {t("extension_submit")}
                </button>
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
              </div>
            </div>
          )}
        </div>

        {statusMessage && (
          <div
            role="status"
            aria-live="polite"
            style={{
              padding: "5px 10px",
              borderTop: "1px solid var(--border)",
              background: "var(--bg-subtle)",
              color: expired ? "var(--status-warning)" : "var(--text-dim)",
              fontSize: 10,
              lineHeight: 1.4,
            }}
          >
            {statusMessage}
          </div>
        )}
      </section>
    </div>
  );
}
