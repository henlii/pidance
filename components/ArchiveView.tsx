"use client";

import { useCallback, useEffect, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { displayCwd } from "@/lib/project-context";
import { DialogButton, formatRelativeTime, TrashIcon, XIcon } from "./session-sidebar/display";
import { ViewportDialog } from "./ui/ViewportDialog";
import {
  archiveFailureKind,
  archiveRowTitle,
  deleteSessionPermanently,
  restoreSession,
  sortArchivedSessions,
  type ArchiveActionResult,
} from "@/lib/session-archive-client";

/**
 * 归档视图（侧栏内视图）：
 * - 归档会话列表按 archivedAt 降序，行含标题 / 项目 / 归档日期；
 * - 「恢复」与「永久删除」（弹窗二次确认）动作；
 * - 动作成功后统一回调 onRefresh 重新拉 /api/sessions（含 archivedSessions/archivedCount）；
 * - 打开归档会话只读浏览：后续版本（首版仅列表 + 恢复 + 删除）。
 */
export function ArchiveView({
  sessions,
  count,
  homeDir,
  loading,
  onRefresh,
  onBack,
}: {
  sessions: readonly SessionInfo[];
  count: number;
  homeDir: string;
  loading: boolean;
  onRefresh: () => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<{ sessionId: string | null }>({ sessionId: null });
  const [error, setError] = useState<string | null>(null);

  // 进入视图即刷新一次，保证数据与磁盘一致（badge 计数同步更新）。
  useEffect(() => {
    onRefresh();
  }, [onRefresh]);

  const failureLabel = useCallback((result: ArchiveActionResult): string => {
    const kind = archiveFailureKind(result);
    if (kind === "running") return t("archive_runningConflict");
    if (kind === "readOnly") return t("archive_readOnlyForbidden");
    if (kind === "network") return t("archive_networkError");
    return result.error ?? t("archive_unknownError");
  }, [t]);

  const handleRestore = useCallback(async (session: SessionInfo) => {
    if (busyId !== null) return;
    setBusyId(session.id);
    setError(null);
    try {
      const result = await restoreSession(session.id);
      if (!result.ok) {
        setError(t("archive_restoreFailed", { error: failureLabel(result) }));
        return;
      }
      onRefresh();
    } catch (e) {
      setError(t("archive_restoreFailed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusyId(null);
    }
  }, [busyId, onRefresh, t, failureLabel]);

  const handleDelete = useCallback(async (session: SessionInfo) => {
    if (busyId !== null) return;
    setBusyId(session.id);
    setError(null);
    try {
      const result = await deleteSessionPermanently(session.id);
      if (!result.ok) {
        setError(t("archive_deleteFailed", { error: failureLabel(result) }));
        return;
      }
      setConfirmDeleteId({ sessionId: null });
      onRefresh();
    } catch (e) {
      setError(t("archive_deleteFailed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusyId(null);
    }
  }, [busyId, onRefresh, t, failureLabel]);

const rows = sortArchivedSessions(sessions);
  const confirmSession = confirmDeleteId.sessionId
    ? rows.find((s) => s.id === confirmDeleteId.sessionId) ?? null
    : null;
  const confirmTitle = confirmSession ? archiveRowTitle(confirmSession) : "";
  const confirmBusy = confirmSession ? busyId === confirmSession.id : false;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* 视图头：返回 + 标题 + 计数 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={onBack}
          data-tooltip={t("archive_back")}
          aria-label={t("archive_back")}
          className="sidebar-icon-btn"
          style={{ display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
        >
          <XIcon size={14} />
        </button>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t("archive_viewTitle")}
        </span>
        <span
          title={t("archive_viewCount", { count })}
          style={{
            flexShrink: 0, minWidth: 18, padding: "1px 6px", boxSizing: "border-box",
            borderRadius: 999, background: "var(--bg-selected)", color: "var(--text-muted)",
            fontSize: 10, fontWeight: 600, textAlign: "center",
          }}
        >
          {count}
        </span>
      </div>

      {error && (
        <div role="alert" style={{ padding: "6px 10px", borderBottom: "1px solid var(--border)", background: "var(--status-danger-bg)", color: "var(--status-danger)", fontSize: 11, lineHeight: 1.4, overflowWrap: "anywhere", flexShrink: 0 }}>
          {error}
        </div>
      )}

      <div style={{ flex: "1 1 auto", overflowY: "auto", padding: "4px 0", minHeight: 80 }}>
        {loading && rows.length === 0 && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>{t("sidebar_loading")}</div>
        )}
        {!loading && rows.length === 0 && (
          <div style={{ padding: "18px 14px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.7 }}>
            {t("archive_empty")}
            <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("archive_emptyHint")}</div>
          </div>
        )}
        {rows.map((session) => {
          const title = archiveRowTitle(session);
          const busy = busyId === session.id;
          return (
            <div
              key={session.id}
              data-archive-session-id={session.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                margin: "1px 6px",
                padding: "7px 8px",
                borderRadius: 6,
                background: "transparent",
                opacity: busy ? 0.5 : 1,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  title={title}
                  style={{ fontSize: 12, fontWeight: 500, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: 1.4 }}
                >
                  {title}
                </div>
                <div style={{ fontSize: 10.5, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: 1.4, marginTop: 1 }}>
                  {displayCwd(session.cwd, homeDir)} · {t("archive_archivedAt", { date: formatRelativeTime(session.archivedAt ?? session.modified, t) })}
                </div>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleRestore(session)}
                title={t("archive_restore")}
                style={{ padding: "3px 9px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", fontSize: 11, cursor: busy ? "not-allowed" : "pointer", flexShrink: 0 }}
              >
                {busy ? t("archive_restoring") : t("archive_restore")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmDeleteId({ sessionId: session.id })}
                title={t("archive_delete")}
                aria-label={t("archive_delete")}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: "none", border: "none", borderRadius: 5, color: "var(--text-dim)", cursor: busy ? "not-allowed" : "pointer", flexShrink: 0 }}
              >
                <TrashIcon size={13} />
              </button>
            </div>
          );
        })}
      </div>

      <ViewportDialog
        open={confirmSession !== null}
        onClose={() => {
          if (confirmBusy) return;
          setConfirmDeleteId({ sessionId: null });
        }}
        title={t("archive_delete")}
        description={confirmSession ? (
          <>
            <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>{confirmTitle}</div>
            <div>{t("archive_deleteConfirm")}</div>
          </>
        ) : t("archive_deleteConfirm")}
        width={400}
        closeLabel={t("dialog_close")}
        closeOnBackdrop={!confirmBusy}
        closeOnEsc={!confirmBusy}
        actions={
          <>
            <DialogButton
              disabled={confirmBusy}
              onClick={() => setConfirmDeleteId({ sessionId: null })}
            >
              {t("archive_deleteCancel")}
            </DialogButton>
            <DialogButton
              danger
              disabled={confirmBusy || !confirmSession}
              onClick={() => {
                if (confirmSession) void handleDelete(confirmSession);
              }}
            >
              {confirmBusy ? t("archive_deleting") : t("archive_deleteConfirmButton")}
            </DialogButton>
          </>
        }
      />
    </div>
  );
}
