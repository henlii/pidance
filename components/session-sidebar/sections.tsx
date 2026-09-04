"use client";

/**
 * 会话侧栏渲染段（#17 D5：SessionSidebar row/menu/actions 拆分）。
 * ProjectSection / WorktreeGroupSection / SessionTreeItem / SessionItem
 * 从 SessionSidebar.tsx 迁出；props 契约保持不变，纯渲染无状态逻辑。
 */

import { useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { RunningTimeContext } from "./running-time";
import { ViewportDialog } from "../ui/ViewportDialog";
import { useI18n } from "@/lib/i18n";
import type { SessionInfo } from "@/lib/types";
import type { SidebarDisplayMode, ProjectAliases } from "@/lib/ui-preferences";
import { displayCwd, projectDisplayName } from "@/lib/project-context";
import { getSessionCapabilities, canArchiveSession } from "../session-capabilities";
import { archiveSession, archiveFailureKind } from "@/lib/session-archive-client";
import {
  AnimatedDropdown,
  ArchiveIcon,
  BranchIcon,
  BranchPlusIcon,
  ChatPlusIcon,
  CheckIcon,
  ChevronButton,
  DialogButton,
  DisplayMenuItem,
  FolderIcon,
  FolderPlusIcon,
  formatRelativeTime,
  GroupPagination,
  HistoryIcon,
  HomeIcon,
  PathLabel,
  PiWebTitle,
  RefreshIcon,
  RunningDurationText,
  RunningSessionIndicator,
  SearchIcon,
  SidebarIconButton,
  SlidersIcon,
  TrashIcon,
  UnreadSessionIndicator,
  WorktreeActions,
  XIcon,
} from "@/components/session-sidebar/display";
import { ProjectRowMenu, SessionRowMenu } from "@/components/session-sidebar/menus";
import {
  isSessionNodeEffectivelyCollapsed,
  type SessionDisplayNode,
  type SessionRelationKind,
} from "../session-tree";
import {
  type SidebarProjectNode,
  type SidebarWorktreeGroup,
} from "../session-sidebar-model";
import {
  getGroupVisibleCount,
  getVisibleTopLevelNodes,
  bumpGroupVisibleCount,
  resetGroupVisibleCount,
} from "../session-sidebar-state";

// 侧栏树几何（与 SessionSidebar 主文件同源复制；改动须两处同步或上移到 display）。
const SIDEBAR_GUTTER = 6;
const SIDEBAR_INDICATOR_SLOT = 20;
const SIDEBAR_INDICATOR_GAP = 6;
const SIDEBAR_DEPTH_STEP = 14;
const SIDEBAR_BASE_LEFT = SIDEBAR_GUTTER + SIDEBAR_INDICATOR_SLOT + SIDEBAR_INDICATOR_GAP;
const sidebarRowPaddingLeft = (depth: number) => SIDEBAR_BASE_LEFT + depth * SIDEBAR_DEPTH_STEP;
const sidebarIndicatorLeft = (depth: number) => SIDEBAR_GUTTER + depth * SIDEBAR_DEPTH_STEP;

export { ProjectSection, WorktreeGroupSection, SessionTreeItem, SessionItem };
function ProjectSection({
  project,
  homeDir,
  displayMode,
  projectAliases,
  selectedSessionId,
  runningSessionIds,
  subagentRunningIds,
  unreadSessionIds,
  collapsedProjectRoots,
  collapsedWorktreePaths,
  collapsedSessionIds,
  searchActive,
  onToggleProject,
  onToggleWorktree,
  onNewSession,
  onSelectSession,
  menuOpen,
  onMenuOpenChange,
  onEditProject,
  onCloseProject,
  onRenamed,
  onSessionDeleted,
  onToggleCollapse,
  groupVisibleCounts,
  onShowMore,
  onShowFewer,
  worktreeActions,
  wtNewOpen,
  wtNewBranch,
  wtError,
  wtConfirmRemove,
  wtNewInputRef,
  onStartCreateWorktree,
  onWtNewBranchChange,
  onSubmitCreateWorktree,
  onCancelCreateWorktree,
  onRequestRemoveWorktree,
  onConfirmRemoveWorktree,
  onCancelRemoveWorktree,
  onSessionArchive,
  isSessionPinned,
  onTogglePin,
  onProjectDrop,
}: {
  project: SidebarProjectNode;
  homeDir: string;
  displayMode: SidebarDisplayMode;
  projectAliases: ProjectAliases;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  subagentRunningIds: Set<string>;
  unreadSessionIds: Set<string>;
  collapsedProjectRoots: ReadonlySet<string>;
  collapsedWorktreePaths: ReadonlySet<string>;
  collapsedSessionIds: ReadonlySet<string>;
  searchActive: boolean;
  onToggleProject: (root: string) => void;
  onToggleWorktree: (path: string) => void;
  onNewSession: (cwd: string) => void;
  onSelectSession: (s: SessionInfo) => void;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onEditProject: () => void;
  onCloseProject: () => void;
  /** 项目根与各 worktree path → 信任状态；缺失则不显示徽章 */
  onRenamed: () => void;
  onSessionDeleted: (id: string) => void;
  onToggleCollapse: (sessionId: string) => void;
  groupVisibleCounts: Readonly<Record<string, number>>;
  onShowMore: (groupKey: string) => void;
  onShowFewer: (groupKey: string) => void;
  worktreeActions: WorktreeActions | null;
  wtNewOpen: boolean;
  wtNewBranch: string;
  wtError: string | null;
  wtConfirmRemove: string | null;
  wtNewInputRef: React.RefObject<HTMLInputElement | null>;
  onStartCreateWorktree: () => void;
  onWtNewBranchChange: (value: string) => void;
  onSubmitCreateWorktree: () => void;
  onCancelCreateWorktree: () => void;
  onRequestRemoveWorktree: (path: string) => void;
  onConfirmRemoveWorktree: (path: string) => void;
  onCancelRemoveWorktree: () => void;
  onSessionArchive: (sessionId: string) => void;
  /** 会话是否置顶（id → bool）；不传则不显示置顶菜单。 */
  isSessionPinned?: (id: string) => boolean;
  /** 置顶/取消置顶动作；不传则不显示置顶菜单。 */
  onTogglePin?: (id: string) => void;
  /** 项目行拖放到另一项目时回调；缺省则不可拖。 */
  onProjectDrop?: (fromRoot: string, toRoot: string) => void;
}) {
  const { t } = useI18n();
  const collapsed = isSessionNodeEffectivelyCollapsed(collapsedProjectRoots, project.root, searchActive);
  const hasSessions = project.mainTree.length > 0 || project.worktrees.some((group) => group.tree.length > 0);
  // 显示名优先 alias；title 仍保留真实 root 路径（见行 title 属性）。
  const projectName = projectAliases[project.root] ?? projectDisplayName(project.root);
  const collapseLabel = collapsed
    ? t("sidebar_expandProjectNamed", { project: projectName })
    : t("sidebar_collapseProjectNamed", { project: projectName });
  // 项目行运行中标记已移除（会话行各自显示运行圆点）

  return (
    <div>
      {/* 项目行仅控制折叠；cwd 由会话行或新建会话入口切换。 */}
      <div
        className="sidebar-row"
        data-sidebar-depth={0}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-label={collapseLabel}
        draggable={Boolean(onProjectDrop)}
        onDragStart={(event) => {
          if (!onProjectDrop) return;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/pidance-project", project.root);
          event.dataTransfer.setData("text/plain", project.root);
        }}
        onDragOver={(event) => {
          if (!onProjectDrop) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => {
          if (!onProjectDrop) return;
          event.preventDefault();
          event.stopPropagation();
          const from = event.dataTransfer.getData("text/pidance-project") || event.dataTransfer.getData("text/plain");
          if (from) onProjectDrop(from, project.root);
        }}
        onClick={() => onToggleProject(project.root)}
        onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          onToggleProject(project.root);
        }}
        title={project.root}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: 32,
          margin: "1px 6px",
          position: "relative",
          paddingLeft: sidebarRowPaddingLeft(0),
          paddingRight: 8,
          borderRadius: 6,
          cursor: "pointer",
          background: "transparent",
          color: "var(--text-muted)",
        }}
      >
        <ChevronButton
          collapsed={collapsed}
          label={collapseLabel}
          left={sidebarIndicatorLeft(0)}
          onClick={(e) => {
            e.stopPropagation();
            onToggleProject(project.root);
          }}
        />
        <span aria-hidden="true" className="sidebar-indicator-icon" style={{ position: "absolute", left: sidebarIndicatorLeft(0), top: "50%", display: "flex", width: SIDEBAR_INDICATOR_SLOT, height: 20, alignItems: "center", justifyContent: "center", transform: "translateY(-50%)", color: "var(--text-dim)" }}>
          <FolderIcon size={13} />
        </span>
        {/* 项目行不显示运行中标记（会话行各自显示运行圆点） */}
        <PathLabel
          text={projectName}
          style={{
            flex: 1,
            fontSize: 12.5,
            fontWeight: 600,
            fontFamily: "var(--font-mono)",
          }}
        />
        <SidebarIconButton
          label={t("sidebar_newSessionIn", { project: projectName })}
          hoverReveal
          onClick={(event) => {
            event.stopPropagation();
            onNewSession(project.root);
          }}
        >
          <ChatPlusIcon size={14} />
        </SidebarIconButton>
        {worktreeActions && (
          <SidebarIconButton
            label={worktreeActions.createHint}
            disabled={!worktreeActions.canManage || worktreeActions.busy}
            hoverReveal
            onClick={(e) => {
              e.stopPropagation();
              onStartCreateWorktree();
            }}
          >
            <BranchPlusIcon size={14} />
          </SidebarIconButton>
        )}
        {/* 三点菜单：worktree 按钮的 flex 邻居，互不遮挡 */}
        <ProjectRowMenu
          open={menuOpen}
          onOpenChange={onMenuOpenChange}
          projectName={projectName}
          onEdit={onEditProject}
          onClose={onCloseProject}
        />
      </div>

      {!collapsed && (
        <div>
          {/* 主仓会话：主 worktree 隐式，直接列在项目下 */}
          <div>
            {getVisibleTopLevelNodes(
              project.mainTree,
              getGroupVisibleCount(groupVisibleCounts, `main:${project.root}`),
              searchActive,
            ).map((node) => (
              <SessionTreeItem
                key={node.session.id}
                node={node}
                selectedSessionId={selectedSessionId}
                runningSessionIds={runningSessionIds}
                subagentRunningIds={subagentRunningIds}
                unreadSessionIds={unreadSessionIds}
                onSelectSession={onSelectSession}
                onRenamed={onRenamed}
                onSessionDeleted={onSessionDeleted}
                onSessionArchive={onSessionArchive}
                isSessionPinned={isSessionPinned}
                onTogglePin={onTogglePin}
                depth={0}
                collapsedSessionIds={collapsedSessionIds}
                searchActive={searchActive}
                onToggleCollapse={onToggleCollapse}
                displayMode={displayMode}
              />
            ))}
            <GroupPagination
              groupKey={`main:${project.root}`}
              total={project.mainTree.length}
              visibleCount={getGroupVisibleCount(groupVisibleCounts, `main:${project.root}`)}
              searchActive={searchActive}
              onShowMore={onShowMore}
              onShowFewer={onShowFewer}
            />
          </div>

          {/* 非主 worktree 分组 */}
          {project.worktrees.map((group) => (
            <WorktreeGroupSection
              key={group.path}
              group={group}
              homeDir={homeDir}
              displayMode={displayMode}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              subagentRunningIds={subagentRunningIds}
              unreadSessionIds={unreadSessionIds}
              collapsedWorktreePaths={collapsedWorktreePaths}
              collapsedSessionIds={collapsedSessionIds}
              searchActive={searchActive}
              onToggleWorktree={(path) => onToggleWorktree(path)}
              onNewSession={() => onNewSession(group.path)}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              onToggleCollapse={onToggleCollapse}
              visibleCount={getGroupVisibleCount(groupVisibleCounts, `worktree:${group.path}`)}
              onShowMore={() => onShowMore(`worktree:${group.path}`)}
              onShowFewer={() => onShowFewer(`worktree:${group.path}`)}
              worktreeActions={worktreeActions}
              confirmRemove={wtConfirmRemove === group.path}
              onRequestRemove={() => onRequestRemoveWorktree(group.path)}
              onConfirmRemove={() => onConfirmRemoveWorktree(group.path)}
              onCancelRemove={onCancelRemoveWorktree}
              onSessionArchive={onSessionArchive}
              isSessionPinned={isSessionPinned}
              onTogglePin={onTogglePin}
            />
          ))}

          {/* 新建 worktree 输入行（仅当前项目可发起） */}
          {wtNewOpen && worktreeActions?.canManage && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px 4px 30px" }}>
              <span style={{ display: "flex", color: "var(--text-dim)", flexShrink: 0 }}><BranchIcon size={11} /></span>
              <input
                ref={wtNewInputRef}
                value={wtNewBranch}
                onChange={(e) => onWtNewBranchChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onSubmitCreateWorktree();
                  }
                  if (e.key === "Escape") onCancelCreateWorktree();
                }}
                placeholder={t("sidebar_branchName")}
                aria-label={t("sidebar_branchName")}
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: 26,
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  padding: "0 8px",
                  border: "1px solid var(--accent)",
                  borderRadius: 5,
                  outline: "none",
                  background: "var(--bg)",
                  color: "var(--text)",
                  boxSizing: "border-box",
                }}
              />
              <SidebarIconButton
                label={worktreeActions.busy ? t("sidebar_creating") : t("sidebar_createWorktreeAction")}
                disabled={worktreeActions.busy || !wtNewBranch.trim()}
                onClick={onSubmitCreateWorktree}
              >
                <CheckIcon size={14} />
              </SidebarIconButton>
              <SidebarIconButton label={t("sidebar_cancel")} onClick={onCancelCreateWorktree}>
                <XIcon size={13} />
              </SidebarIconButton>
            </div>
          )}
          {wtError && worktreeActions && (
            <div style={{
              padding: "3px 10px 6px 30px",
              color: "var(--status-danger)",
              fontSize: 11,
              lineHeight: 1.35,
              overflowWrap: "anywhere",
            }}>
              {wtError}
            </div>
          )}

          {!hasSessions && project.worktrees.length === 0 && (
            <div style={{ padding: "2px 10px 6px 31px", color: "var(--text-dim)", fontSize: 11 }}>
              {t("sidebar_noSessionsYet")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 非主 worktree 分组 ─────────────────────────────────────────────────────

function WorktreeGroupSection({
  group,
  homeDir,
  displayMode,
  selectedSessionId,
  runningSessionIds,
  subagentRunningIds,
  unreadSessionIds,
  collapsedWorktreePaths,
  collapsedSessionIds,
  searchActive,
  onToggleWorktree,
  onNewSession,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  onToggleCollapse,
  visibleCount,
  onShowMore,
  onShowFewer,
  worktreeActions,
  confirmRemove,
  onRequestRemove,
  onConfirmRemove,
  onCancelRemove,
  onSessionArchive,
  isSessionPinned,
  onTogglePin,
}: {
  group: SidebarWorktreeGroup;
  homeDir: string;
  displayMode: SidebarDisplayMode;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  subagentRunningIds: Set<string>;
  unreadSessionIds: Set<string>;
  collapsedWorktreePaths: ReadonlySet<string>;
  collapsedSessionIds: ReadonlySet<string>;
  searchActive: boolean;
  onToggleWorktree: (path: string) => void;
  onNewSession: () => void;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed: () => void;
  onSessionDeleted: (id: string) => void;
  onToggleCollapse: (sessionId: string) => void;
  visibleCount: number;
  onShowMore: () => void;
  onShowFewer: () => void;
  worktreeActions: WorktreeActions | null;
  confirmRemove: boolean;
  onRequestRemove: () => void;
  onConfirmRemove: () => void;
  onCancelRemove: () => void;
  onSessionArchive: (sessionId: string) => void;
  isSessionPinned?: (id: string) => boolean;
  onTogglePin?: (id: string) => void;
}) {
  const { t } = useI18n();
  const collapsed = isSessionNodeEffectivelyCollapsed(collapsedWorktreePaths, group.path, searchActive);
  const label = group.branch ?? displayCwd(group.path, homeDir);
  const collapseLabel = collapsed
    ? t("sidebar_expandWorktreeNamed", { name: label })
    : t("sidebar_collapseWorktreeNamed", { name: label });
  // 聚合运行圆点：组内任一会话运行中即显示；不显示单个时长。
  const groupHasRunning = useMemo(() => {
    const running = new Set([...runningSessionIds, ...subagentRunningIds]);
    const anyRunning = (nodes: SessionDisplayNode[]): boolean =>
      nodes.some((node) => running.has(node.session.id) || anyRunning(node.children));
    return anyRunning(group.tree);
  }, [group, runningSessionIds, subagentRunningIds]);

  return (
    <div>
      {/* 工作树行仅控制折叠；cwd 由会话行或新建会话入口切换。 */}
      <div
        className="sidebar-row"
        data-sidebar-depth={0}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-label={collapseLabel}
        onClick={() => onToggleWorktree(group.path)}
        onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          onToggleWorktree(group.path);
        }}
        title={group.path}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: 30,
          margin: "1px 6px",
          position: "relative",
          paddingLeft: sidebarRowPaddingLeft(0),
          paddingRight: 8,
          borderRadius: 6,
          cursor: "pointer",
          background: "transparent",
          color: "var(--text-muted)",
        }}
      >
        <ChevronButton
          collapsed={collapsed}
          label={collapseLabel}
          left={sidebarIndicatorLeft(0)}
          onClick={(e) => {
            e.stopPropagation();
            onToggleWorktree(group.path);
          }}
        />
        <span aria-hidden="true" className="sidebar-indicator-icon" style={{ position: "absolute", left: sidebarIndicatorLeft(0), top: "50%", display: "flex", width: SIDEBAR_INDICATOR_SLOT, height: 20, alignItems: "center", justifyContent: "center", transform: "translateY(-50%)", color: "var(--text-dim)" }}>
          <BranchIcon size={11} />
        </span>
        {groupHasRunning && (
          <span aria-hidden="true" style={{ position: "absolute", left: sidebarIndicatorLeft(0), top: "50%", display: "flex", width: SIDEBAR_INDICATOR_SLOT, height: 20, alignItems: "center", justifyContent: "center", transform: "translateY(-50%)", pointerEvents: "none" }}>
            <RunningSessionIndicator size={18} />
          </span>
        )}
        <PathLabel
          text={label}
          style={{
            flex: 1,
            fontSize: 12,
            fontWeight: 400,
            fontFamily: "var(--font-mono)",
          }}
        />
        {groupHasRunning && <RunningSessionIndicator size={10} />}
        <SidebarIconButton
          label={t("sidebar_newSessionIn", { project: label })}
          hoverReveal
          onClick={(event) => {
            event.stopPropagation();
            onNewSession();
          }}
        >
          <ChatPlusIcon size={13} />
        </SidebarIconButton>
        {worktreeActions?.canManage && !confirmRemove && (
          <SidebarIconButton
             label={t("sidebar_removeWorktreeAt", { path: group.path })}
            danger
            hoverReveal
            disabled={worktreeActions.busy}
            onClick={(e) => {
              e.stopPropagation();
              onRequestRemove();
            }}
          >
            <TrashIcon size={13} />
          </SidebarIconButton>
        )}
      </div>

      {/* 脏删除确认：行内展示，Force/Cancel 文字按钮保证破坏性操作明确 */}
      {confirmRemove && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px 5px 30px", background: "var(--status-danger-bg)" }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("sidebar_dirtyWorktreeConfirm")}
          </span>
          <button
            type="button"
            onClick={onConfirmRemove}
            disabled={worktreeActions?.busy}
            style={{ padding: "3px 9px", background: "var(--status-danger)", border: "none", borderRadius: 5, color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
          >
            {t("sidebar_forceRemove")}
          </button>
          <button
            type="button"
            onClick={onCancelRemove}
            style={{ padding: "3px 9px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", fontSize: 11, cursor: "pointer", flexShrink: 0 }}
          >
            {t("sidebar_cancel")}
          </button>
        </div>
      )}

      {!collapsed && (
        <div>
          {getVisibleTopLevelNodes(group.tree, visibleCount, searchActive).map((node) => (
            <SessionTreeItem
              key={node.session.id}
              node={node}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              subagentRunningIds={subagentRunningIds}
              unreadSessionIds={unreadSessionIds}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              onSessionArchive={onSessionArchive}
              isSessionPinned={isSessionPinned}
              onTogglePin={onTogglePin}
              depth={0}
              collapsedSessionIds={collapsedSessionIds}
              searchActive={searchActive}
              onToggleCollapse={onToggleCollapse}
              displayMode={displayMode}
            />
          ))}
          <GroupPagination
            groupKey={group.path}
            total={group.tree.length}
            visibleCount={visibleCount}
            searchActive={searchActive}
            onShowMore={onShowMore}
            onShowFewer={onShowFewer}
          />
          {group.tree.length === 0 && (
            <div style={{ padding: "2px 10px 5px 28px", color: "var(--text-dim)", fontSize: 11 }}>
              {t("sidebar_noSessions")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 会话树（fork/subagent child 递归，语义由 session-tree 保证） ─────────────

function SessionTreeItem({
  node,
  selectedSessionId,
  runningSessionIds,
  subagentRunningIds,
  unreadSessionIds,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  onSessionArchive,
  isSessionPinned,
  onTogglePin,
  depth,
  collapsedSessionIds,
  searchActive,
  onToggleCollapse,
  displayMode,
}: {
  node: SessionDisplayNode;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  subagentRunningIds: Set<string>;
  unreadSessionIds: Set<string>;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  onSessionArchive?: (id: string) => void;
  isSessionPinned?: (id: string) => boolean;
  onTogglePin?: (id: string) => void;
  depth: number;
  collapsedSessionIds: ReadonlySet<string>;
  searchActive: boolean;
  onToggleCollapse: (sessionId: string) => void;
  displayMode: SidebarDisplayMode;
}) {
  const hasChildren = node.children.length > 0;
  const collapsed = isSessionNodeEffectivelyCollapsed(collapsedSessionIds, node.session.id, searchActive);

  return (
    <div>
      <div data-session-id={node.session.id} style={{ position: "relative" }}>
        <SessionItem
          session={node.session}
          relation={node.relation}
          isSelected={node.session.id === selectedSessionId}
          isRunning={runningSessionIds.has(node.session.id) || subagentRunningIds.has(node.session.id)}
          // subagent 子会话不参与未读（用户需求：子会话无未读状态）
          isUnread={!node.session.subagent && unreadSessionIds.has(node.session.id)}
          onClick={() => onSelectSession(node.session)}
          onRenamed={onRenamed}
          onDeleted={(id) => onSessionDeleted?.(id)}
          onArchive={(id) => onSessionArchive?.(id)}
          isPinned={isSessionPinned?.(node.session.id)}
          onTogglePin={() => onTogglePin?.(node.session.id)}
          depth={depth}
          hasChildren={hasChildren}
          collapsed={collapsed}
          onToggleCollapse={() => onToggleCollapse(node.session.id)}
          displayMode={displayMode}
        />
      </div>
      {hasChildren && !collapsed && (
        <div>
          {node.children.map((child) => (
            <SessionTreeItem
              key={child.session.id}
              node={child}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              subagentRunningIds={subagentRunningIds}
              unreadSessionIds={unreadSessionIds}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              onSessionArchive={onSessionArchive}
              isSessionPinned={isSessionPinned}
              onTogglePin={onTogglePin}
              depth={depth + 1}
              collapsedSessionIds={collapsedSessionIds}
              searchActive={searchActive}
              onToggleCollapse={onToggleCollapse}
              displayMode={displayMode}
            />
          ))}
        </div>
      )}
    </div>
  );
}


function SessionItem({
  session,
  relation = null,
  isSelected,
  isRunning,
  isUnread,
  onClick,
  onRenamed,
  onDeleted,
  onArchive,
  isPinned,
  onTogglePin,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
  displayMode,
}: {
  session: SessionInfo;
  /** 与父会话的关系；根项为 null。fork 与 subagent 图标/语义分开呈现。 */
  relation?: SessionRelationKind | null;
  isSelected: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  onArchive?: (id: string) => void;
  isPinned?: boolean;
  onTogglePin?: () => void;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  displayMode: SidebarDisplayMode;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const capabilities = getSessionCapabilities(session);
  // 归档能力：running 或只读 subagent 禁用（后端 409/403 的 UI 先行拦截 + 原因说明）。
  const isRunningNow = isRunning === true;
  const archiveCanUse = canArchiveSession(session, isRunningNow);
  const archiveDisabledReason = !archiveCanUse
    ? isRunningNow
      ? t("archive_rowDisabledRunning")
      : t("archive_rowDisabledReadOnly")
    : null;
  // P1-5：共享运行计时上下文（first-seen startedAt + 1Hz now）；刷新后无记录 → undefined。
  const runningTime = useContext(RunningTimeContext);
  const runningStartedAt = session.id ? runningTime.startedAt.get(session.id) : undefined;
  // 折叠的父会话（聚合节点）只显示圆点，不显示单个时长。
  const showRunningDuration = isRunning === true && !(hasChildren && collapsed);
  // 尚未展开索引的 subagent 会话首消息为占位符，才用 agent/run 兜底；
  // 已有真实首消息时沿用内容标题，agent/run 由下方徽章补充，避免信息重复。
  const firstMessage = session.firstMessage.trim();
  const subagentFallback = session.subagent && (!firstMessage || firstMessage === "(no messages)")
     ? `${session.subagent.agent ? `${session.subagent.agent} · ` : ""}${t("sidebar_runCount", { count: session.subagent.runIndex })}`
    : "";
  const firstMessageLabel = firstMessage === "(no messages)" ? t("sidebar_noMessages") : session.firstMessage;
  const title = session.name
    || subagentFallback
    || firstMessageLabel.slice(0, 50)
    || session.id.slice(0, 12);

  const startRename = useCallback(() => {
    // 只读会话不允许改名（UI 层 guard；后端仍是权威防线）。
    if (!capabilities.canRename) return;
    setRenameValue(title);
    setRenaming(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [title, capabilities.canRename]);

  const commitRename = useCallback(async () => {
    // 即使输入框因竞态仍处于打开状态，只读会话也不能发 PATCH。
    if (!capabilities.canRename) {
      setRenaming(false);
      return;
    }
    const name = renameValue.trim();
    setRenaming(false);
    if (name === (session.name ?? "")) return;
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      onRenamed?.();
    } catch {
      // ignore
    }
  }, [renameValue, session.id, session.name, onRenamed, capabilities.canRename]);

  const handleDeleteClick = useCallback(() => {
    // 只读会话不允许删除（UI 层 guard；后端仍是权威防线）。
    if (!capabilities.canDelete) return;
    setConfirmDelete(true);
  }, [capabilities.canDelete]);

const handleDeleteConfirm = useCallback(async () => {
    // 确认态期间能力若变化，仍不得发 DELETE。
    if (!capabilities.canDelete) {
      setConfirmDelete(false);
      return;
    }
    setConfirmDelete(false);
    setDeleting(true);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      if (!response.ok) {
        setDeleting(false);
        return;
      }
      onDeleted?.(session.id);
    } catch {
      setDeleting(false);
    }
  }, [session.id, onDeleted, capabilities.canDelete]);

  const handleDeleteCancel = useCallback(() => {
    setConfirmDelete(false);
  }, []);

// Fixed-height outer wrapper — content swaps in place so the list never reflows
  const compact = displayMode === "compact";
  const ITEM_HEIGHT = compact ? 30 : 40;

  return (
    <>
    <div
      className="sidebar-row"
      data-sidebar-depth={depth}
      onClick={renaming ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      style={{
        height: ITEM_HEIGHT,
        display: "flex",
        alignItems: "center",
        width: "calc(100% - 12px)",
        margin: "1px 6px",
        position: "relative",
        paddingLeft: sidebarRowPaddingLeft(depth),
        paddingRight: 8,
        borderRadius: 6,
        cursor: renaming ? "default" : "pointer",
        background: isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        borderLeft: isSelected ? "2px solid var(--accent)" : "2px solid transparent",
        transition: "background 0.15s ease, color 0.15s ease",
        opacity: deleting ? 0.5 : 1,
        gap: 6,
        overflow: "hidden",
      }}
    >
      {renaming ? (
        /* ── Rename: input fills the same row ── */
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          aria-label={t("sidebar_renameSession")}
          style={{
            flex: 1,
            fontSize: compact ? 11 : 12,
            padding: "0 8px",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
            height: compact ? 20 : 28,
          }}
        />
      ) : (
        /* ── Normal view ── */
        <>
          {/* 行首 gutter：child 折叠 chevron 位于 relation/状态/标题之前；
              槽位常驻（无 child 留空）保证各行标题对齐。搜索期由
              isSessionNodeEffectivelyCollapsed 强制展开；原生 button 支持
              Enter/Space；粗指针命中区由 globals.css 媒体查询扩大。 */}
          {hasChildren ? (
            <button
              type="button"
              className="sidebar-chevron-btn sidebar-indent-indicator sidebar-chevron-always"
              onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
              title={collapsed ? t("sidebar_expandChild") : t("sidebar_collapseChild")}
              data-tooltip={collapsed ? t("sidebar_expandChild") : t("sidebar_collapseChild")}
              aria-label={collapsed ? t("sidebar_expandChild") : t("sidebar_collapseChild")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                position: "absolute", left: sidebarIndicatorLeft(depth), top: "50%",
                width: SIDEBAR_INDICATOR_SLOT, height: 20, padding: 0,
                background: "none", border: "none", borderRadius: 5,
                color: "var(--text-dim)", cursor: "pointer",
                transform: `translateY(-50%)${collapsed ? " rotate(-90deg)" : ""}`,
                transition: "transform 0.15s",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          ) : (
            <span
              className="sidebar-indent-placeholder"
              aria-hidden="true"
              style={{ position: "absolute", left: sidebarIndicatorLeft(depth), top: "50%", width: SIDEBAR_INDICATOR_SLOT, height: 20, transform: "translateY(-50%)" }}
            />
          )}
          {/* 运行中：圆环套在图标列（与折叠/项目图标同槽位，居中，旋转动画）。 */}
          {isRunning && (
            <span aria-hidden="true" style={{ position: "absolute", left: sidebarIndicatorLeft(depth), top: "50%", display: "flex", width: SIDEBAR_INDICATOR_SLOT, height: 20, alignItems: "center", justifyContent: "center", transform: "translateY(-50%)", pointerEvents: "none" }}>
              <RunningSessionIndicator size={18} />
            </span>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                minWidth: 0,
                fontSize: compact ? 11.5 : 12,
                fontWeight: 400,
                lineHeight: 1.4,
                color: isSelected ? "var(--accent-hover)" : "var(--text)",
              }}
              title={title}
            >
              {/* 状态指示置前：未读显示在标题之前（OpenChamber 风格）；运行中已上移到图标列。 */}
              {!isRunning && isUnread && <UnreadSessionIndicator size={10} />}
              {/* Compact：运行时长内联在圆点后（行右侧信息区）；折叠父组只留圆点 */}
              {showRunningDuration && compact && (
                <RunningDurationText startedAt={runningStartedAt} now={runningTime.now} running />
              )}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {title}
              </span>
              {/* Compact：subagent 徽章内联在标题后 */}
              {compact && session.subagent && (
                <span
                  title={`${t("sidebar_subagentReadOnly")}${session.subagent.agent ? ` · ${session.subagent.agent}` : ""} · ${t("sidebar_runCount", { count: session.subagent.runIndex })}`}
                  style={{ display: "inline-flex", alignItems: "center", flexShrink: 0, padding: "0 5px", border: "1px solid color-mix(in srgb, var(--status-success) 42%, var(--border))", borderRadius: 999, color: "var(--status-success)", fontSize: 9, lineHeight: 1.55 }}
                >
                  {t("sidebar_subagentBadge")}
                </span>
              )}
            </div>
            {!compact && (
              <div style={{ marginTop: 1, display: "flex", alignItems: "center", gap: 8, color: "var(--text-dim)", fontSize: 10.5, minWidth: 0 }}>
              {/* P1-5 运行时长：展开行 secondary 信息区右侧（modified 前）；折叠父组只留圆点 */}
              {showRunningDuration && (
                <RunningDurationText startedAt={runningStartedAt} now={runningTime.now} running />
              )}
              <span title={session.modified}>{formatRelativeTime(session.modified, t)}</span>
              <span>{t("sidebar_messagesCount", { count: session.messageCount })}</span>
              {/* 子代理徽章：文字先表达类型，agent 名与 run 次序补充上下文。 */}
              {session.subagent && (
                <span
                  title={`${t("sidebar_subagentReadOnly")}${session.subagent.agent ? ` · ${session.subagent.agent}` : ""} · ${t("sidebar_runCount", { count: session.subagent.runIndex })}`}
                  style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text-muted)", minWidth: 0, overflow: "hidden" }}
                >
                  <span style={{ flexShrink: 0, fontSize: 9, padding: "0 5px", borderRadius: 999, border: "1px solid color-mix(in srgb, var(--status-success) 42%, var(--border))", color: "var(--status-success)", lineHeight: 1.55 }}>
                    {t("sidebar_subagentBadge")}
                  </span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 10 }}>
                    {session.subagent.agent ? `${session.subagent.agent} · ` : ""}{t("sidebar_runCount", { count: session.subagent.runIndex })}
                  </span>
                </span>
              )}
              {session.worktreeBranch && (
                <span
                  title={t("sidebar_worktreeTooltip", { path: session.cwd })}
                  style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--accent)", minWidth: 0, overflow: "hidden" }}
                >
                  <BranchIcon size={9} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.worktreeBranch}</span>
                </span>
              )}
            </div>
          )}
        </div>

          {/* 写操作与导出统一收口；只读会话仍可复制 ID 和导出。 */}
          <SessionRowMenu session={session} title={title} canRename={capabilities.canRename} canDelete={capabilities.canDelete} canArchive={archiveCanUse} archiveDisabledReason={archiveDisabledReason} isPinned={isPinned} onTogglePin={onTogglePin} onRename={startRename} onDelete={handleDeleteClick} onArchive={() => onArchive?.(session.id)}/>
        </>
      )}
    </div>
    <ViewportDialog
      open={confirmDelete}
      onClose={handleDeleteCancel}
      title={t("sidebar_deleteSession")}
      description={t("sidebar_deleteConfirm", { name: title })}
      width={400}
      closeLabel={t("dialog_close")}
      actions={
        <>
          <DialogButton disabled={deleting} onClick={handleDeleteCancel}>{t("sidebar_cancel")}</DialogButton>
          <DialogButton danger disabled={deleting} onClick={() => void handleDeleteConfirm()}>
            {t("sidebar_deleteSession")}
          </DialogButton>
        </>
      }
    />
    </>
  );
}
