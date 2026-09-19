"use client";

import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredOverlay } from "@/hooks/useAnchoredOverlay";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useSubagentActivity } from "@/hooks/useSubagentActivity";
import type { SubagentActivityEntry } from "@/lib/subagent-activity";
import { useI18n } from "@/lib/i18n";
// 弹窗里的运行状态与会话列表共用同一套指示器（旋转圆环 + 实时耗时 + 等待黄点）。
import {
  RunningDurationText,
  RunningSessionIndicator,
  WaitingSessionIndicator,
} from "@/components/session-sidebar/display";
import type { SessionCatalogStore } from "@/lib/session-catalog-store";
import {
  buildLineageIndex,
  collectLineageDescendants,
  lineagePath,
  shortSessionTitle,
  truncateTitle,
  visibleCrumbEntries,
  visibleLineageNodes,
} from "@/lib/session-lineage";
import type { SessionInfo } from "@/lib/types";

/**
 * 顶栏子会话谱系。对齐 dsh 的 `conversation.session.header.lineage` 槽位语义：
 * 面包屑的其它层级由宿主渲染，槽位只替换「当前会话那一段标题」。
 *
 * 主会话页：`主会话标题 / [N 个子会话 ▾]`（面包屑 + 数量触发器）。
 * 子会话页：`父标题 / [子标题 ▾]`——末段标题与展开按钮合成一个按钮（dsh 的
 * switcher 形态），前面的父层标题可点返回；子会话自己还有后代时，后面再接一个
 * `/ [N ▾]` 数量触发器。
 *
 * 侧栏刻意隐藏子代理会话（session-tree 的展示过滤），页头因此是它们的导航入口。
 * 面板每行按会话列表同一套语言显示运行状态：运行中 = 旋转圆环 + 实时耗时，
 * 需要关注 = 等待黄点 + 文字。
 * 只读——切换会话复用 handleSelectSession，不在这里提供任何写入动作。
 */

const TREE_ROW_SELECTOR = '[role="treeitem"]';

/** 打开的菜单：switcher = 末段标题按钮（父层作用域），directory = 数量触发器（自身作用域）。 */
type LineageMenuKind = "switcher" | "directory";

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={open ? { transform: "rotate(180deg)" } : undefined}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

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
  const [menu, setMenu] = useState<LineageMenuKind | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const menuRef = useRef<LineageMenuKind | null>(null);
  const switcherRef = useRef<HTMLButtonElement>(null);
  const directoryRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pendingFocusRef = useRef<string | null>(null);
  const treeId = useId();
  const open = menu !== null;

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
  // 标题菜单挂在父会话上（一步跳到兄弟子会话），数量菜单挂在当前会话自己身上：
  // 两个作用域各自计数、各自展开。
  const switcherScopeId = session.subagent?.parentSessionId ?? root.id;
  const rows = useMemo(
    () => visibleLineageNodes(index, menu === "switcher" ? switcherScopeId : session.id, collapsed),
    [index, menu, switcherScopeId, session.id, collapsed],
  );

  const runningIds = activity.runningChildIds;
  const directory = useMemo(() => collectLineageDescendants(index, session.id), [index, session.id]);
  const runningCount = useMemo(
    () => directory.filter((node) => runningIds.has(node.session.id)).length,
    [directory, runningIds],
  );
  const selfRunning = runningIds.has(session.id);

  // 运行时长（对齐会话列表）：面板里只要有在跑的会话就按 1Hz 走动；没有活动行时不挂表。
  const [now, setNow] = useState(() => Date.now());
  const anyRunningRow = rows.some((row) => runningIds.has(row.session.id));
  useEffect(() => {
    if (!open || !anyRunningRow) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, anyRunningRow]);

  // 两个触发器各一套定位（同一时刻只开一个），公共参数共用。
  const overlayOptions = useMemo(
    () => ({
      overlayRef: panelRef,
      preferredPlacement: "below" as const,
      gap: 4,
      margin: 8,
      minHeight: 120,
      maxHeight: 420,
      minWidth: isMobile ? undefined : 280,
      maxWidth: 420,
      width: isMobile ? ("max" as const) : undefined,
      align: "start" as const,
    }),
    [isMobile],
  );
  const switcherOverlay = useAnchoredOverlay({ open: menu === "switcher", anchorRef: switcherRef, ...overlayOptions });
  const directoryOverlay = useAnchoredOverlay({ open: menu === "directory", anchorRef: directoryRef, ...overlayOptions });
  const overlay = menu === "switcher" ? switcherOverlay : directoryOverlay;

  // 换会话即收起下拉并重置展开态（避免把上一个谱系的折叠状态带过来）。
  useEffect(() => {
    menuRef.current = null;
    setMenu(null);
    setCollapsed(new Set<string>());
  }, [session.id]);

  const openMenu = useCallback((kind: LineageMenuKind) => {
    menuRef.current = kind;
    setMenu(kind);
  }, []);

  const closePanel = useCallback((restoreFocus: boolean) => {
    const kind = menuRef.current;
    menuRef.current = null;
    setMenu(null);
    if (restoreFocus && kind) (kind === "switcher" ? switcherRef : directoryRef).current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (switcherRef.current?.contains(target) || directoryRef.current?.contains(target)) return;
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
  // 必须等 overlay.ready：定位前面板是 visibility:hidden，focus() 会被忽略。
  useEffect(() => {
    if (!open || !overlay.ready) return;
    if (rows.length === 0) {
      closePanel(false);
      return;
    }
    const currentIndex = rows.findIndex((row) => row.session.id === session.id);
    focusTreeRow(panelRef.current, currentIndex >= 0 ? currentIndex : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, overlay.ready]);

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
      const row = focusedIndex >= 0 ? rows[focusedIndex] : undefined;
      const target = row?.session;
      const hasChildren = target ? (index.get(target.id)?.length ?? 0) > 0 : false;
      const isCollapsed = target ? collapsed.has(target.id) : false;

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
          if (!row) return;
          event.preventDefault();
          if (hasChildren && isCollapsed) {
            pendingFocusRef.current = row.session.id;
            toggleCollapsed(row.session.id);
          } else {
            focusTreeRow(panelRef.current, focusedIndex + 1);
          }
          return;
        case "ArrowLeft": {
          if (!row) return;
          event.preventDefault();
          if (hasChildren && !isCollapsed) {
            pendingFocusRef.current = row.session.id;
            toggleCollapsed(row.session.id);
            return;
          }
          // 回到父节点：向上找第一个层级更小的可见行。
          for (let i = focusedIndex - 1; i >= 0; i -= 1) {
            if (rows[i].depth < row.depth) {
              focusTreeRow(panelRef.current, i);
              return;
            }
          }
          return;
        }
        case "Enter":
        case " ":
          if (!target) return;
          event.preventDefault();
          pickSession(target);
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

  const shownCrumbs = visibleCrumbEntries(crumbs, { compact: isMobile });
  // 子会话没有首条消息，页头标题取运行标签（scout 之类），再回退到会话标题（dsh 同：label ?? id）。
  const selfTitle = rowTitle(session);
  // 末段是否合并成按钮：子代理会话才有（dsh 的 lineage 槽换掉的正是这一段标题）。
  const isSubagent = Boolean(session.subagent);

  return (
    <div className="session-lineage">
      <nav className="session-lineage-crumbs" aria-label={t("lineage_listLabel")}>
        {shownCrumbs.map((entry, i) => (
          <Fragment key={entry === "gap" ? "gap" : entry.id}>
            {i > 0 && <span className="session-lineage-sep" aria-hidden="true">/</span>}
            {entry === "gap" ? (
              <span className="session-lineage-gap" aria-hidden="true">…</span>
            ) : entry.id !== session.id ? (
              <button
                type="button"
                className="session-lineage-crumb instant-tooltip"
                data-tooltip={t("lineage_switchTo", { title: rowTitle(entry) })}
                onClick={() => onSelectSession(entry)}
              >
                {truncateTitle(rowTitle(entry), isMobile ? 16 : 30)}
              </button>
            ) : isSubagent ? (
              // 末段（当前会话就是子代理）：标题与展开按钮合成一个按钮（dsh 的 switcher）
              <button
                ref={switcherRef}
                type="button"
                className="session-lineage-title instant-tooltip"
                aria-haspopup="tree"
                aria-expanded={menu === "switcher"}
                aria-controls={menu === "switcher" ? treeId : undefined}
                aria-label={t("lineage_switcherLabel", { title: selfTitle })}
                data-tooltip={t("lineage_switcherLabel", { title: selfTitle })}
                onClick={() => (menu === "switcher" ? closePanel(true) : openMenu("switcher"))}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" && menu !== "switcher") {
                    event.preventDefault();
                    openMenu("switcher");
                  }
                }}
              >
                {selfRunning && <span className="session-lineage-dot" aria-hidden="true" />}
                <span className="session-lineage-trigger-label">{truncateTitle(selfTitle, isMobile ? 20 : 36)}</span>
                <Chevron open={menu === "switcher"} />
              </button>
            ) : (
              <span className="session-lineage-current" aria-current="page" title={t("lineage_current")}>
                {selfRunning && <span className="session-lineage-dot" aria-hidden="true" />}
                {shortSessionTitle(entry, isMobile ? 16 : 30)}
              </span>
            )}
          </Fragment>
        ))}
      </nav>

      {directory.length > 0 && (
        <>
          <span className="session-lineage-sep" aria-hidden="true">/</span>
          <button
            ref={directoryRef}
            type="button"
            className="session-lineage-trigger instant-tooltip"
            aria-haspopup="tree"
            aria-expanded={menu === "directory"}
            aria-controls={menu === "directory" ? treeId : undefined}
            data-tooltip={t("lineage_listLabel")}
            onClick={() => (menu === "directory" ? closePanel(true) : openMenu("directory"))}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && menu !== "directory") {
                event.preventDefault();
                openMenu("directory");
              }
            }}
          >
            {runningCount > 0 && <span className="session-lineage-dot" aria-hidden="true" />}
            <span className="session-lineage-trigger-label">
              {t("lineage_subagentCount", { count: directory.length })}
            </span>
            {runningCount > 0 && (
              <span className="session-lineage-trigger-running">
                {t("lineage_runningCount", { count: runningCount })}
              </span>
            )}
            <Chevron open={menu === "directory"} />
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
          {rows.map((row) => {
            const target = row.session;
            const entry = activity.bySessionId.get(target.id);
            const childCount = index.get(target.id)?.length ?? 0;
            const isCollapsed = collapsed.has(target.id);
            const isCurrent = target.id === session.id;
            const isRunning = runningIds.has(target.id);
            const needsAttention = entry?.step.activityState === "needs_attention";
            const meta = rowMeta(entry);
            const label = rowTitle(target);
            return (
              <div
                key={target.id}
                role="treeitem"
                tabIndex={-1}
                aria-level={row.depth}
                aria-expanded={childCount > 0 ? !isCollapsed : undefined}
                aria-selected={isCurrent}
                data-session-id={target.id}
                className={`session-lineage-row${isCurrent ? " is-current" : ""}${needsAttention ? " needs-attention" : ""}`}
                style={{ paddingLeft: 8 + (row.depth - 1) * 14 }}
                title={[
                  isCurrent ? t("lineage_current") : t("lineage_switchTo", { title: label }),
                  t("sidebar_subagentReadOnly"),
                  // run-0 布局（旧版 pi-subagents / official-subagent）不显示次数
                  ...(target.subagent && target.subagent.runIndex > 0
                    ? [t("sidebar_runCount", { count: target.subagent.runIndex })]
                    : []),
                ].join(" · ")}
                onClick={() => pickSession(target)}
              >
                {childCount > 0 ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    className="session-lineage-row-toggle"
                    aria-label={isCollapsed ? t("sidebar_expandChild") : t("sidebar_collapseChild")}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleCollapsed(target.id);
                    }}
                  >
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: isCollapsed ? "rotate(-90deg)" : "none" }}>
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                ) : (
                  <span className="session-lineage-row-toggle" aria-hidden="true" />
                )}
                {needsAttention ? (
                  <WaitingSessionIndicator size={12} />
                ) : isRunning ? (
                  <RunningSessionIndicator size={12} />
                ) : null}
                <span className="session-lineage-row-label">{label}</span>
                {entry?.mode && entry.mode !== "single" && (
                  <span className="session-lineage-row-tag">{entry.mode}</span>
                )}
                {needsAttention && (
                  <span className="session-lineage-row-attention">{t("lineage_needsAttention")}</span>
                )}
                {meta && <span className="session-lineage-row-meta">{meta}</span>}
                {isRunning && !needsAttention && (
                  <RunningDurationText startedAt={entry?.step.startedAt} now={now} running />
                )}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
