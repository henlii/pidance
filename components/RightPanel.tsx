"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { GitStatusResponse } from "@/lib/git-types";
import { RIGHT_PANEL_WIDTH_DEFAULT, RIGHT_PANEL_WIDTH_MAX, RIGHT_PANEL_WIDTH_MIN } from "@/lib/ui-preferences";
import { useI18n } from "@/lib/i18n";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { GitPanel } from "./GitPanel";
import type { Tab } from "./TabBar";
import { FileDiff, FileText, SquareTerminal } from "lucide-react";

interface Props {
  /** 桌面控制内容面板显隐；移动端控制整组抽屉显隐。 */
  open: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  cwd: string | null;
  isMobile: boolean;
  mobileReady: boolean;
  /** 仅包含一级右栏图标导航；文件 tab 属于二级右栏。 */
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  sessionInfoContent: ReactNode;
  branchContent: ReactNode;
  terminalContent: ReactNode;
  fileRefreshKey?: number;
  gitRefreshKey?: number;
  onOpenFile: (filePath: string, fileName: string, mode?: "content" | "diff") => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
}

function NavigationIcon({ kind }: { kind: Tab["kind"] }) {
  const props = { width: 17, height: 17, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (kind === "info") return <FileText size={17} strokeWidth={1.8} aria-hidden="true" />;
  if (kind === "files") return <svg {...props}><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>;
  if (kind === "git") return <FileDiff size={17} strokeWidth={1.8} aria-hidden="true" />;
  if (kind === "terminal") return <SquareTerminal size={17} strokeWidth={1.8} aria-hidden="true" />;
  return <svg {...props}><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>;
}

const NAVIGATION_RAIL_WIDTH = 44;

/** OpenChamber 式右栏：内容面板在左，固定图标轨道常驻窗口最右缘。 */
export function RightPanel({ open, width, onWidthChange, onClose, cwd, isMobile, mobileReady, tabs, activeTabId, onSelectTab, sessionInfoContent, branchContent, terminalContent, fileRefreshKey, gitRefreshKey, onOpenFile, onAtMention, onAtMentions }: Props) {
  const { t } = useI18n();
  const fileExplorerRef = useRef<FileExplorerHandle>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [filesRefreshTick, setFilesRefreshTick] = useState(0);
  const [gitStatus, setGitStatus] = useState<GitStatusResponse | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [everOpened, setEverOpened] = useState(open);
  useEffect(() => { if (open) setEverOpened(true); }, [open]);

  const fetchGitStatus = useCallback(async () => {
    if (!cwd) { setGitStatus(null); setGitError(null); return; }
    setGitLoading(true);
    try {
      const res = await fetch(`/api/git/status?${new URLSearchParams({ cwd }).toString()}`);
      const data = await res.json().catch(() => ({})) as GitStatusResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? t("workspace_gitStatusLoadFailed", { status: res.status }));
      setGitStatus(data); setGitError(null);
    } catch (error) {
      setGitError(error instanceof Error ? error.message : String(error)); setGitStatus(null);
    } finally { setGitLoading(false); }
  }, [cwd, t]);

  useEffect(() => { if (open) void fetchGitStatus(); }, [open, fetchGitStatus, gitRefreshKey]);
  const previousUploadBusy = useRef(false);
  useEffect(() => {
    const wasBusy = previousUploadBusy.current;
    previousUploadBusy.current = uploadBusy;
    if (wasBusy && !uploadBusy) void fetchGitStatus();
  }, [uploadBusy, fetchGitStatus]);

  const handleResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (isMobile) return;
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: width };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [isMobile, width]);
  const handleResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const viewportMax = Math.max(RIGHT_PANEL_WIDTH_MIN, Math.min(RIGHT_PANEL_WIDTH_MAX, window.innerWidth * 0.42));
    onWidthChange(Math.min(viewportMax, Math.max(RIGHT_PANEL_WIDTH_MIN, drag.startWidth + drag.startX - event.clientX)));
  }, [onWidthChange]);
  const handleResizeEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null; setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const navigationTabs = tabs.filter((tab) => tab.kind && tab.kind !== "file" && tab.kind !== "chat");
  // 一级右栏 activeTabId 恒为导航 id（文件 tab 选中已由 AppShell 侧 activeFileTabId 解耦）。
  const activeNavigationId = activeTabId;
  const changeCount = gitStatus?.isGitRepository ? gitStatus.files.length : 0;
  const desktopTotalWidth = NAVIGATION_RAIL_WIDTH + (open ? width : 0);
  const contentWidth = isMobile ? `calc(100% - ${NAVIGATION_RAIL_WIDTH}px)` : open ? width : 0;

  return (
    <div className={`workspace-container${open ? " workspace-open" : " workspace-closed"}${dragging ? " workspace-dragging" : ""}${mobileReady ? "" : " workspace-mobile-pending"}`} style={{ width: desktopTotalWidth, minWidth: desktopTotalWidth, display: "flex", borderLeft: open ? "1px solid var(--border)" : "none", background: "var(--bg-panel)", position: "relative", flexShrink: 0, zIndex: 200 }} role="complementary" aria-label={t("panel_ariaLabel")} onKeyDownCapture={(event) => { if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
      {open && <div className={`workspace-resize-handle${dragging ? " dragging" : ""}`} onPointerDown={handleResizeStart} onPointerMove={handleResizeMove} onPointerUp={handleResizeEnd} onPointerCancel={handleResizeEnd} onDoubleClick={() => onWidthChange(RIGHT_PANEL_WIDTH_DEFAULT)} title={t("workspace_resizeHandle")} aria-hidden="true" />}
      <div className="workspace-inner" style={{ width: desktopTotalWidth, minWidth: desktopTotalWidth, height: "100%", display: "flex" }}>
        <div aria-hidden={!open} inert={!open} style={{ width: contentWidth, minWidth: contentWidth, overflow: "hidden", height: "100%", display: "flex", flexDirection: "column", opacity: open ? 1 : 0, transition: dragging ? "none" : "width 0.2s ease, min-width 0.2s ease, opacity 0.12s ease" }}>
          <div style={{ flex: 1, overflow: "hidden", position: "relative", background: "var(--bg-panel)" }}>
            {!everOpened ? null : activeTabId === "terminal" ? <div style={{ height: "100%", overflow: "hidden" }}>{terminalContent}</div> : !cwd ? <div style={{ padding: "16px 12px", fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.6 }}>{t("workspace_selectProject")}</div> : <>
              <div style={{ display: activeTabId === "files" ? "flex" : "none", height: "100%", flexDirection: "column" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
                  <button type="button" onClick={() => fileExplorerRef.current?.openUploadPicker()} disabled={uploadBusy || !cwd} data-tooltip={t("workspace_upload")} aria-label={t("workspace_upload")} className="sidebar-icon-btn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/></svg></button>
                  <button type="button" onClick={() => fileExplorerRef.current?.startCreateFile()} disabled={!cwd} data-tooltip={t("files_newFile")} aria-label={t("files_newFile")} className="sidebar-icon-btn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9 15h6"/></svg></button>
                  <button type="button" onClick={() => fileExplorerRef.current?.startCreateDir()} disabled={!cwd} data-tooltip={t("files_newFolder")} aria-label={t("files_newFolder")} className="sidebar-icon-btn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 8 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 11v6"/><path d="M9 14h6"/></svg></button>
                  <button type="button" onClick={() => setFilesRefreshTick((tick) => tick + 1)} data-tooltip={t("workspace_refreshFiles")} aria-label={t("workspace_refreshFiles")} className="sidebar-icon-btn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg></button>
                </div>
                <div style={{ flex: 1, minHeight: 0 }}><FileExplorer ref={fileExplorerRef} cwd={cwd} onOpenFile={(filePath, fileName) => onOpenFile(filePath, fileName, "content")} refreshKey={(fileRefreshKey ?? 0) + filesRefreshTick} onAtMention={onAtMention} onAtMentions={onAtMentions} onUploadBusyChange={setUploadBusy}/></div>
              </div>
              <div style={{ display: activeTabId === "git" ? "flex" : "none", height: "100%", flexDirection: "column" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
                  <button type="button" onClick={() => void fetchGitStatus()} disabled={!cwd} data-tooltip={t("workspace_refreshGitStatus")} aria-label={t("workspace_refreshGitStatus")} className="sidebar-icon-btn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg></button>
                </div>
                <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}><GitPanel cwd={cwd} status={gitStatus} loading={gitLoading} error={gitError} onOpenFile={(filePath, fileName) => onOpenFile(filePath, fileName, "diff")}/></div>
              </div>
              {activeTabId === "branch" && <div style={{ height: "100%", overflow: "hidden" }}>{branchContent}</div>}
              {activeTabId === "info" && <div style={{ height: "100%", overflow: "hidden" }}>{sessionInfoContent}</div>}
            </>}
          </div>
        </div>
        <nav className="workspace-navigation-rail" aria-label={t("panel_ariaLabel")} style={{ width: NAVIGATION_RAIL_WIDTH, flex: `0 0 ${NAVIGATION_RAIL_WIDTH}px` }}>
          {navigationTabs.map((tab) => {
            const active = open && tab.id === activeNavigationId;
            const label = tab.kind === "git" && changeCount > 0 ? `${tab.label} (${changeCount > 99 ? "99+" : changeCount})` : tab.label;
            return <button key={tab.id} type="button" className="sidebar-icon-btn" aria-label={label} title={label} data-tooltip={label} aria-pressed={active} onClick={() => onSelectTab(tab.id)} style={{ width: 34, height: 34, color: active ? "var(--accent)" : "var(--text-muted)", background: active ? "var(--bg-selected)" : "transparent", border: active ? "1px solid color-mix(in srgb, var(--accent) 30%, var(--border))" : "1px solid transparent", position: "relative" }}><NavigationIcon kind={tab.kind}/>{tab.kind === "git" && changeCount > 0 && <span aria-hidden="true" style={{ position: "absolute", right: 3, top: 3, width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 0 2px var(--bg)" }}/>}</button>;
          })}
        </nav>
      </div>
    </div>
  );
}
