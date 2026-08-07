"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { affectedPathsMatchFile } from "@/lib/git-refresh";
import type { GitFileDiffResponse } from "@/lib/git-types";
import { useI18n } from "@/lib/i18n";
import type { Tab } from "./TabBar";
import { TabBar } from "./TabBar";
import { GitDiffView } from "./FileViewer";

interface Props {
  open: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  cwd: string | null;
  isMobile: boolean;
  mobileReady: boolean;
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onCloseAllTabs: () => void;
  pendingCloseTabLabel: string | null;
  onSaveAndClose: () => void;
  onDiscardAndClose: () => void;
  onCancelClose: () => void;
  fileViewerContent: ReactNode;
  activeMode: "content" | "diff";
  gitAffectedPaths?: string[] | null;
}

/** 二级右侧边栏：由一级文件树/Git 行打开，文件 tab 与扩展内容均挂载于此。 */
export function ChangesPanel({ open, width, onWidthChange, cwd, isMobile, mobileReady, tabs, activeTabId, onSelectTab, onCloseTab, onCloseAllTabs, pendingCloseTabLabel, onSaveAndClose, onDiscardAndClose, onCancelClose, fileViewerContent, activeMode, gitAffectedPaths }: Props) {
  const { t } = useI18n();
  const [diff, setDiff] = useState<GitFileDiffResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  const fetchDiff = useCallback(async () => {
    if (!cwd || activeMode !== "diff" || !activeTab?.filePath) {
      setDiff(null);
      return;
    }
    setDiffLoading(true);
    setDiffError(null);
    try {
      const params = new URLSearchParams({ cwd, path: activeTab.filePath });
      const response = await fetch(`/api/git/diff?${params.toString()}`);
      const next = await response.json().catch(() => ({})) as GitFileDiffResponse & { error?: string };
      if (!response.ok) throw new Error(next.error ?? t("changes_diffError", { status: response.status }));
      setDiff(next.supported && typeof next.patch === "string" ? next : null);
    } catch (error) {
      setDiff(null);
      setDiffError(error instanceof Error ? error.message : String(error));
    } finally {
      setDiffLoading(false);
    }
  }, [activeMode, activeTab?.filePath, cwd, t]);

  useEffect(() => { void fetchDiff(); }, [fetchDiff]);
  useEffect(() => {
    if (activeMode === "diff" && activeTab?.filePath && gitAffectedPaths?.some((path) => affectedPathsMatchFile(gitAffectedPaths, path))) void fetchDiff();
  }, [activeMode, activeTab?.filePath, fetchDiff, gitAffectedPaths]);

  const handleResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (isMobile) return;
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: width };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [isMobile, width]);
  const handleResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag) onWidthChange(drag.startWidth + drag.startX - event.clientX);
  }, [onWidthChange]);
  const handleResizeEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const content = !activeTab ? <div className="changes-panel-hint">{t("secondary_empty")}</div>
    : activeMode === "content" ? fileViewerContent
      : diffLoading ? <div className="changes-panel-hint">{t("changes_diffLoading")}</div>
        : diffError ? <div className="changes-panel-hint is-error">{diffError}</div>
          : diff?.patch ? <GitDiffView patch={diff.patch} />
            : <div className="changes-panel-hint">{t("changes_diffUnavailable")}</div>;

  return (
    <aside className={`changes-panel${open ? " changes-panel-open" : " changes-panel-closed"}${dragging ? " changes-panel-dragging" : ""}${mobileReady ? "" : " workspace-mobile-pending"}`} style={{ width: open ? width : 0, minWidth: open ? width : 0, height: "100%", minHeight: 0, flex: "1 1 auto", display: "flex", flexDirection: "column" }} aria-label={t("secondary_title")}>
      {open && <div className={`changes-panel-resize-handle${dragging ? " dragging" : ""}`} role="separator" aria-orientation="vertical" tabIndex={0} title={t("changes_resizeHandle")} aria-label={t("changes_resizeHandle")} onPointerDown={handleResizeStart} onPointerMove={handleResizeMove} onPointerUp={handleResizeEnd} onPointerCancel={handleResizeEnd} />}
      <div className="secondary-panel-inner">
        {tabs.length > 0 && <div className="secondary-panel-tabs" style={{ display: "flex", alignItems: "stretch", flexShrink: 0 }}>
          <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}><TabBar tabs={tabs} activeTabId={activeTabId} onSelectTab={onSelectTab} onCloseTab={onCloseTab} /></div>
          <button type="button" className="sidebar-icon-btn" onClick={onCloseAllTabs} title={t("secondary_closeAll")} aria-label={t("secondary_closeAll")} style={{ flexShrink: 0, borderRadius: 0, borderLeft: "1px solid var(--border)" }}><span aria-hidden="true">×</span></button>
        </div>}
        {pendingCloseTabLabel !== null && <div className="file-close-confirm" role="alert"><span className="file-close-confirm__message">{t("app_unsavedChangesIn", { name: pendingCloseTabLabel })}</span><button type="button" className="file-close-confirm__button" onClick={onSaveAndClose}>{t("app_saveAndClose")}</button><button type="button" className="file-close-confirm__button is-danger" onClick={onDiscardAndClose}>{t("app_discardChanges")}</button><button type="button" className="file-close-confirm__button" onClick={onCancelClose}>{t("common_cancel")}</button></div>}
        <div className="secondary-panel-body">{content}</div>
      </div>
    </aside>
  );
}
