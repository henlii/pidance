"use client";

import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredOverlay } from "@/hooks/useAnchoredOverlay";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useSubagentActivity } from "@/hooks/useSubagentActivity";
import type { SubagentActivityEntry } from "@/lib/subagent-activity";
import { useI18n } from "@/lib/i18n";
import type { SessionCatalogStore } from "@/lib/session-catalog-store";
import {
  buildLineageIndex,
  collectLineageDescendants,
  lineagePath,
  shortSessionTitle,
  visibleLineageNodes,
} from "@/lib/session-lineage";
import type { SessionInfo } from "@/lib/types";

/**
 * 顶栏子会话谱系：`主会话 / 子会话 / N 个子会话 ▾`。
 *
 * 侧栏刻意隐藏子代理会话（session-tree 的展示过滤），主会话页头因此是它们的
 * 导航入口：面包屑每段可点（回到上层），斜线后的触发器打开该谱系的后代目录。
 * 只读——切换会话复用 handleSelectSession，不在这里提供任何写入动作。
 */

const TREE_ROW_SELECTOR = '[role="treeitem"]';

type Props = {
  catalogStore: SessionCatalogStore;
  /** 当前会话（谱系焦点，由 AppShell 持有） */
  session: SessionInfo;
  /** 切换会话：AppShell.handleSelectSession */
  onSelectSession: (session: SessionInfo) => void;
};

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

function formatDuration(startedAt?: number, endedAt?: number): string | null {
  if (!startedAt || !endedAt || endedAt < startedAt) return null;
  const seconds = Math.round((endedAt - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function treeRows(panel: HTMLElement | null): HTMLElement[] {
  if (!panel) return [];
  return Array.from(panel.querySelectorAll<HTMLElement>(TREE_ROW_SELECTOR));
}

function focusTreeRow(panel: HTMLElement | null, index: number): void {
  const rows = treeRows(panel);
  if (rows.length === 0) return;
  rows[Math.max(0, Math.min(rows.length - 1, index))]?.focus();
}

function focusTreeRowById(panel: HTMLElement | null, sessionId: string): void {
  const rows = treeRows(panel);
  const index = rows.findIndex((row) => row.dataset.sessionId === sessionId);
  if (index >= 0) rows[index].focus();
}

export function SessionLineage({ catalogStore, session, onSelectSession }: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const activity = useSubagentActivity();
  const [catalogTick, setCatalogTick] = useState(0);
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pendingFocusRef = useRef<string | null>(null);
  const treeId = useId();

  // Catalog 订阅：会话列表（含 subagent 子会话）变化时同步重算谱系。
  useEffect(() => catalogStore.subscribe(() => setCatalogTick((tick) => tick + 1)), [catalogStore]);

  const sessions = useMemo(
    () => catalogStore.getSnapshot(session.id).sessions,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalogStore, catalogTick, session.id],
  );

  const index = useMemo(() => buildLineageIndex(sessions), [sessions]);
  const crumbs = useMemo(() => {
    const path = lineagePath(sessions, session.id);
    return path.length > 0 ? path : [session];
  }, [sessions, session]);
  const root = crumbs[0];
  // 目录始终挂在谱系根上：从任意深度都能一步跳到兄弟子会话，计数也稳定。
  const directory = useMemo(() => collectLineageDescendants(index, root.id), [index, root.id]);
  const rows = useMemo(() => visibleLineageNodes(index, root.id, collapsed), [index, root.id, collapsed]);

  const runningIds = activity.runningChildIds;
  const runningCount = useMemo(
    () => directory.filter((node) => runningIds.has(node.session.id)).length,
    [directory, runningIds],
  );
  const selfRunning = runningIds.has(session.id);

  const overlay = useAnchoredOverlay({
    open,
    anchorRef: triggerRef,
    overlayRef: panelRef,
    preferredPlacement: "below",
    gap: 4,
    margin: 8,
    minHeight: 120,
    maxHeight: 420,
    minWidth: isMobile ? undefined : 280,
    maxWidth: 420,
    width: isMobile ? "max" : undefined,
    align: "start",
  });

  // 换会话即收起下拉并重置展开态（避免把上一个谱系的折叠状态带过来）。
  useEffect(() => {
    setOpen(false);
    setCollapsed(new Set<string>());
  }, [session.id]);

  const closePanel = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      closePanel(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open, closePanel]);

  useEffect(() => {
    if (!open) return;
    const onDocKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      closePanel(true);
    };
    document.addEventListener("keydown", onDocKeyDown);
    return () => document.removeEventListener("keydown", onDocKeyDown);
  }, [open, closePanel]);

  // 打开时把焦点放到当前会话那一行（找不到就第一行），与首页菜单同一套
  // 真实焦点移动（而非 aria-activedescendant），屏幕阅读器能直接读到 treeitem。
  useEffect(() => {
    if (!open) return;
    if (rows.length === 0) {
      setOpen(false);
      return;
    }
    const currentIndex = rows.findIndex((row) => row.session.id === session.id);
    focusTreeRow(panelRef.current, currentIndex >= 0 ? currentIndex : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 折叠/展开后把焦点还给被操作的那一行（它自身仍在列表里）。
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending || !open) return;
    pendingFocusRef.current = null;
    focusTreeRowById(panelRef.current, pending);
  }, [collapsed, open]);

  const toggleCollapsed = useCallback((sessionId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  const pickSession = useCallback(
    (target: SessionInfo) => {
      closePanel(true);
      if (target.id === session.id) return;
      onSelectSession(target);
    },
    [closePanel, onSelectSession, session.id],
  );

  const onPanelKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const focused = document.activeElement as HTMLElement | null;
      const rowsEls = treeRows(panelRef.current);
      const focusedIndex = focused ? rowsEls.indexOf(focused) : -1;
      const node = focusedIndex >= 0 ? rows[focusedIndex] : undefined;
      const hasChildren = node ? (index.get(node.session.id)?.length ?? 0) > 0 : false;
      const isCollapsed = node ? collapsed.has(node.session.id) : false;

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          focusTreeRow(panelRef.current, focusedIndex + 1);
          return;
        case "ArrowUp":
          event.preventDefault();
          focusTreeRow(panelRef.current, focusedIndex - 1);
          return;
        case "Home":
          event.preventDefault();
          focusTreeRow(panelRef.current, 0);
          return;
        case "End":
          event.preventDefault();
          focusTreeRow(panelRef.current, rowsEls.length - 1);
          return;
        case "ArrowRight":
          if (!node) return;
          event.preventDefault();
          if (hasChildren && isCollapsed) {
            pendingFocusRef.current = node.session.id;
            toggleCollapsed(node.session.id);
          } else {
            focusTreeRow(panelRef.current, focusedIndex + 1);
          }
          return;
        case "ArrowLeft": {
          if (!node) return;
          event.preventDefault();
          if (hasChildren && !isCollapsed) {
            pendingFocusRef.current = node.session.id;
            toggleCollapsed(node.session.id);
            return;
          }
          // 回到父节点：向上找第一个层级更小的可见行。
          for (let i = focusedIndex - 1; i >= 0; i -= 1) {
            if (rows[i].depth < node.depth) {
              focusTreeRow(panelRef.current, i);
              return;
            }
          }
          return;
        }
        case "Enter":
        case " ":
          if (!node) return;
          event.preventDefault();
          pickSession(node.session);
          return;
        default:
      }
    },
    [collapsed, index, pickSession, rows, toggleCollapsed],
  );

  const rowTitle = useCallback(
    (target: SessionInfo): string => {
      const entry = activity.bySessionId.get(target.id);
      const label = entry?.step.label?.trim() || entry?.step.agent || target.subagent?.agent;
      return label || shortSessionTitle(target, 48);
    },
    [activity.bySessionId],
  );

  const rowMeta = useCallback((entry: SubagentActivityEntry | undefined): string | null => {
    if (!entry) return null;
    const parts: string[] = [];
    if (entry.active) {
      if (entry.step.currentTool) parts.push(entry.step.currentTool);
    } else {
      const duration = formatDuration(entry.step.startedAt, entry.step.endedAt);
      if (duration) parts.push(duration);
    }
    const total = entry.step.tokens?.total;
    if (typeof total === "number" && total > 0) parts.push(formatTokens(total));
    return parts.length > 0 ? parts.join(" · ") : null;
  }, []);

  const shownCrumbs: Array<SessionInfo | "gap"> = isMobile && crumbs.length > 2
    ? [crumbs[0], "gap", crumbs[crumbs.length - 1]]
    : crumbs;

  return (
    <div className="session-lineage">
      <nav className="session-lineage-crumbs" aria-label={t("lineage_listLabel")}>
        {shownCrumbs.map((entry, i) => (
          <Fragment key={entry === "gap" ? "gap" : entry.id}>
            {i > 0 && <span className="session-lineage-sep" aria-hidden="true">/</span>}
            {entry === "gap" ? (
              <span className="session-lineage-gap" aria-hidden="true">…</span>
            ) : entry.id === session.id ? (
              <span className="session-lineage-current" aria-current="page" title={t("lineage_current")}>
                {selfRunning && <span className="session-lineage-dot" aria-hidden="true" />}
                {shortSessionTitle(entry, isMobile ? 16 : 30)}
              </span>
            ) : (
              <button
                type="button"
                className="session-lineage-crumb instant-tooltip"
                data-tooltip={t("lineage_switchTo", { title: shortSessionTitle(entry, 48) })}
                onClick={() => onSelectSession(entry)}
              >
                {shortSessionTitle(entry, isMobile ? 16 : 30)}
              </button>
            )}
          </Fragment>
        ))}
      </nav>

      {directory.length > 0 && (
        <>
          <span className="session-lineage-sep" aria-hidden="true">/</span>
          <button
            ref={triggerRef}
            type="button"
            className="session-lineage-trigger instant-tooltip"
            aria-haspopup="tree"
            aria-expanded={open}
            aria-controls={open ? treeId : undefined}
            data-tooltip={t("lineage_listLabel")}
            onClick={() => (open ? closePanel(true) : setOpen(true))}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && !open) {
                event.preventDefault();
                setOpen(true);
              }
            }}
          >
            {(runningCount > 0 || selfRunning) && <span className="session-lineage-dot" aria-hidden="true" />}
            <span className="session-lineage-trigger-label">
              {t("lineage_subagentCount", { count: directory.length })}
            </span>
            {runningCount > 0 && (
              <span className="session-lineage-trigger-running">
                {t("lineage_runningCount", { count: runningCount })}
              </span>
            )}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </>
      )}

      {open && createPortal(
        <div
          ref={panelRef}
          id={treeId}
          role="tree"
          aria-label={t("lineage_listLabel")}
          className="session-lineage-panel"
          onKeyDown={onPanelKeyDown}
          style={{
            ...overlay.style,
            zIndex: 500,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 6px 18px rgba(0,0,0,0.12)",
            overflowY: "auto",
          }}
        >
          {activity.stale && <div className="session-lineage-note">{t("lineage_stale")}</div>}
          {rows.map((node) => {
            const entry = activity.bySessionId.get(node.session.id);
            const childCount = index.get(node.session.id)?.length ?? 0;
            const isCollapsed = collapsed.has(node.session.id);
            const isCurrent = node.session.id === session.id;
            const isRunning = runningIds.has(node.session.id);
            const needsAttention = entry?.step.activityState === "needs_attention";
            const meta = rowMeta(entry);
            const label = rowTitle(node.session);
            return (
              <div
                key={node.session.id}
                role="treeitem"
                tabIndex={-1}
                aria-level={node.depth}
                aria-expanded={childCount > 0 ? !isCollapsed : undefined}
                aria-selected={isCurrent}
                data-session-id={node.session.id}
                className={`session-lineage-row${isCurrent ? " is-current" : ""}${needsAttention ? " needs-attention" : ""}`}
                style={{ paddingLeft: 8 + (node.depth - 1) * 14 }}
                title={[
                  isCurrent ? t("lineage_current") : t("lineage_switchTo", { title: label }),
                  t("sidebar_subagentReadOnly"),
                  // run-0 布局（旧版 pi-subagents / official-subagent）不显示次数
                  ...(node.session.subagent && node.session.subagent.runIndex > 0
                    ? [t("sidebar_runCount", { count: node.session.subagent.runIndex })]
                    : []),
                ].join(" · ")}
                onClick={() => pickSession(node.session)}
              >
                {childCount > 0 ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    className="session-lineage-row-toggle"
                    aria-label={isCollapsed ? t("sidebar_expandChild") : t("sidebar_collapseChild")}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleCollapsed(node.session.id);
                    }}
                  >
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: isCollapsed ? "rotate(-90deg)" : "none" }}>
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                ) : (
                  <span className="session-lineage-row-toggle" aria-hidden="true" />
                )}
                {isRunning && <span className="session-lineage-dot" aria-hidden="true" />}
                <span className="session-lineage-row-label">{label}</span>
                {entry?.mode && entry.mode !== "single" && (
                  <span className="session-lineage-row-tag">{entry.mode}</span>
                )}
                {needsAttention && (
                  <span className="session-lineage-row-attention">{t("lineage_needsAttention")}</span>
                )}
                {meta && <span className="session-lineage-row-meta">{meta}</span>}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
