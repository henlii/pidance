"use client";

import { useState, useCallback, useMemo, useRef, useEffect, type ReactNode } from "react";
import type { SessionEntry, SessionTreeNode } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import {
  BRANCH_LABEL_MAX_LENGTH,
  canCompressChainNode,
  findBranchLabelByEntryId,
  getBranchNodeBookmark,
  treeHasBookmarks,
  type BranchActionResult,
  type BranchActions,
  type BranchSwitchChoice,
} from "@/lib/branch-bookmarks";

interface Props {
  tree: SessionTreeNode[];
  activeLeafId: string | null;
  onLeafChange: (leafId: string | null) => void;
  /** When true, renders as a compact inline button for embedding in a top bar */
  inline?: boolean;
  /** When inline, use this ref's bounding rect to size/position the dropdown */
  containerRef?: React.RefObject<HTMLElement | null>;
  /** Controlled open state for inline mode */
  open?: boolean;
  /** Called when the button is clicked in inline mode */
  onToggle?: () => void;
  /** Whether a session is currently active (used to show appropriate empty reason) */
  hasSession?: boolean;
  /** When inline, render icon-only (no text label) to save horizontal space */
  compact?: boolean;
  /**
   * D3 分支动作（带选项切换 + 书签读写）。缺省或 canWrite=false 时保持
   * 只读直跳行为：不出现摘要选项与书签写入口，点击仍走纯 GET context。
   */
  branchActions?: BranchActions | null;
  /** 常驻右栏模式：直接展示完整树与书签区，不再套折叠标题。 */
  panel?: boolean;
}

// Find the visible entry IDs on the path from root to activeLeafId.
function buildActivePath(nodes: SessionTreeNode[], targetId: string | null): Set<string> {
  if (!targetId) return new Set();
  const target = targetId;
  function search(nodes: SessionTreeNode[], path: string[]): string[] | null {
    for (const node of nodes) {
      const next = [...path, node.entry.id];
      if (node.entry.id === target || node.compressedEntryIds?.includes(target)) {
        return next;
      }
      const found = search(node.children, next);
      if (found) return found;
    }
    return null;
  }
  return new Set(search(nodes, []) ?? []);
}

// Compress a visible linear chain into the first branching/leaf node.
// Server-side compressed IDs also count as skipped nodes.
// 带书签 label 的节点保持可见，不被并入链尾（与服务端投影规则一致）。
function compress(node: SessionTreeNode, preserveRoot = false): { node: SessionTreeNode; skipped: number } {
  let current = node;
  let skipped = current.compressedEntryIds?.length ?? 0;
  while (!preserveRoot && current.children.length === 1 && canCompressChainNode(current)) {
    current = current.children[0];
    skipped += 1 + (current.compressedEntryIds?.length ?? 0);
  }
  return { node: current, skipped };
}

function getLabel(entry: SessionEntry): string {
  if (entry.type === "message" && "message" in entry) {
    const msg = entry.message as { role: string; content: unknown };
    const content = msg.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join(" ");
    }
    if (text.length > 40) text = text.slice(0, 40) + "…";
    if (text) return text;
    if (msg.role === "assistant") return "[assistant]";
  }
  return entry.type;
}

// Does the tree have any branching at all?
function hasBranch(nodes: SessionTreeNode[]): boolean {
  for (const node of nodes) {
    if (node.children.length > 1) return true;
    if (hasBranch(node.children)) return true;
  }
  return false;
}

/**
 * 当前 leaf 是否位于文件末尾（树中为叶子节点）。
 * 分叉/导航后未发送新消息时 leaf 指向有后继的节点（非末尾）——
 * 此时分支面板也要显示树，体现当前位置并可切回主分支。
 */
/** 子树内查找目标：找到返回是否文件末尾；未找到返回 null（继续其它兄弟）。 */
function leafEndForTarget(
  nodes: SessionTreeNode[],
  targetId: string,
): boolean | null {
  for (const node of nodes) {
    if (node.entry.id === targetId) return node.children.length === 0;
    if (node.compressedEntryIds?.includes(targetId)) {
      // leaf 在压缩链中 = 导航到链内位置（分叉/编辑点，未发送）；
      // 文件末尾是保留节点自身（node.entry），不在压缩链里。
      return false;
    }
    const sub = leafEndForTarget(node.children, targetId);
    if (sub !== null) return sub;
  }
  return null;
}

function isLeafAtTreeEnd(nodes: SessionTreeNode[], targetId: string): boolean {
  return leafEndForTarget(nodes, targetId) ?? true;
}

function BookmarkIcon({ size = 10 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  );
}

type I18nT = ReturnType<typeof useI18n>["t"];

interface TreeNodeProps {
  node: SessionTreeNode;
  activePathIds: Set<string>;
  activeLeafId: string | null;
  depth: number;
  isLast: boolean;
  parentLines: boolean[]; // whether ancestor at each depth has more siblings after
  onActivate: (rep: SessionTreeNode) => void;
  assistantLabel: string;
  bookmarkAria: string;
  /** 可写会话的另一叶可打开切换选择器；只读会话为 false。 */
  switchable: boolean;
  switchTargetId: string | null;
  chooserFor: (nodeId: string, indent: number) => ReactNode;
  disabled: boolean;
  preserveRoot?: boolean;
}

function TreeNodeView({ node, activePathIds, activeLeafId, depth, isLast, parentLines, onActivate, assistantLabel, bookmarkAria, switchable, switchTargetId, chooserFor, disabled, preserveRoot = false }: TreeNodeProps) {
  const { node: rep, skipped } = compress(node, preserveRoot);
  const isActive = activePathIds.has(rep.entry.id);
  const isOnPath = activePathIds.has(node.entry.id) || activePathIds.has(rep.entry.id);
  // 当前 leaf 仅在节点代表点（entry 本身或压缩链末）时才算当前；
  // 分叉未发送（leaf 在链中非末）时节点可点击 → 切到链末 = 主分支
  // 当前 leaf 仅在节点代表点（entry 本身）时才算当前；压缩链中的 leaf
  // （分叉/编辑点未发送）非当前 → 节点可点击，切到链末 = 主分支
  const isCurrentLeaf = rep.entry.id === activeLeafId;
  const bookmark = getBranchNodeBookmark(rep.label);
  const rawLabel = getLabel(rep.entry);
  const fallbackLabel = rawLabel === "[assistant]" ? assistantLabel : rawLabel;
  // 书签 label 优先，消息摘要降级为兜底。
  const label = bookmark ?? fallbackLabel;
  const role = rep.entry.type === "message" && "message" in rep.entry
    ? (rep.entry.message as { role: string }).role
    : null;

  return (
    <div>
      {/* This node row */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => onActivate(rep)}
        aria-current={isCurrentLeaf ? "true" : undefined}
        aria-expanded={switchable && !isCurrentLeaf ? switchTargetId === rep.entry.id : undefined}
        aria-label={bookmark ? `${bookmark} — ${bookmarkAria}` : undefined}
        title={bookmark ? `${bookmark} — ${fallbackLabel}` : fallbackLabel}
        style={{
          display: "flex",
          alignItems: "center",
          width: "100%",
          height: 24,
          padding: 0,
          background: "none",
          border: "none",
          font: "inherit",
          textAlign: "left",
          cursor: disabled ? "default" : "pointer",
        }}
      >
        {/* Indent guide lines */}
        {parentLines.map((hasLine, i) => (
          <div key={i} style={{ width: 16, flexShrink: 0, position: "relative", height: "100%", alignSelf: "stretch" }}>
            {hasLine && (
              <div style={{
                position: "absolute",
                left: 7,
                top: 0,
                bottom: 0,
                width: 1,
                background: "var(--border)",
              }} />
            )}
          </div>
        ))}

        {/* Branch connector */}
        <div style={{ width: 16, flexShrink: 0, position: "relative", height: "100%", alignSelf: "stretch" }}>
          {/* vertical line up (to parent) */}
          <div style={{
            position: "absolute",
            left: 7,
            top: 0,
            bottom: isLast ? "50%" : 0,
            width: 1,
            background: "var(--border)",
          }} />
          {/* horizontal line to node */}
          <div style={{
            position: "absolute",
            left: 7,
            top: "50%",
            width: 9,
            height: 1,
            background: "var(--border)",
          }} />
        </div>

        {/* Node dot */}
        <div style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          flexShrink: 0,
          background: isActive ? "var(--accent)" : isOnPath ? "var(--text-muted)" : "var(--border)",
          border: isActive ? "none" : "1px solid var(--text-dim)",
          marginRight: 6,
          transition: "background 0.12s",
        }} />

        {/* 书签节点显示书签图标（替代角色徽章），明显但克制 */}
        {bookmark ? (
          <span style={{ display: "flex", color: "var(--accent)", marginRight: 5, flexShrink: 0 }}>
            <BookmarkIcon size={9} />
          </span>
        ) : role ? (
          <span style={{
            fontSize: 9,
            fontFamily: "var(--font-mono)",
            color: role === "user" ? "var(--accent)" : "var(--text-dim)",
            background: role === "user" ? "rgba(37,99,235,0.08)" : "var(--bg-hover)",
            border: `1px solid ${role === "user" ? "rgba(37,99,235,0.2)" : "var(--border)"}`,
            borderRadius: 3,
            padding: "0 4px",
            marginRight: 5,
            flexShrink: 0,
            lineHeight: "16px",
          }}>
            {role === "user" ? "U" : "A"}
          </span>
        ) : null}

        {/* Skipped indicator */}
        {skipped > 0 && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", marginRight: 5, flexShrink: 0 }}>
            +{skipped}
          </span>
        )}

        {/* Label */}
        <span style={{
          fontSize: 11,
          color: isActive
            ? "var(--text)"
            : bookmark
              ? "var(--text)"
              : isOnPath
                ? "var(--text-muted)"
                : "var(--text-dim)",
          fontWeight: isActive ? 500 : 400,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
          minWidth: 0,
        }}>
          {label}
        </span>
      </button>

      {/* 分支切换选择器（可写会话、另一叶）：手风琴内联展开，不新增浮层 */}
      {chooserFor(rep.entry.id, (parentLines.length + 1) * 16 + 4)}

      {/* Children */}
      {rep.children.map((child, idx) => (
        <TreeNodeView
          key={child.entry.id}
          node={child}
          activePathIds={activePathIds}
          activeLeafId={activeLeafId}
          depth={depth + 1}
          isLast={idx === rep.children.length - 1}
          parentLines={[...parentLines, !isLast]}
          onActivate={onActivate}
          assistantLabel={assistantLabel}
          bookmarkAria={bookmarkAria}
          switchable={switchable}
          switchTargetId={switchTargetId}
          chooserFor={chooserFor}
          disabled={disabled}
          preserveRoot={false}
        />
      ))}
    </div>
  );
}

function ChooserOption({ title, desc, onClick }: { title: string; desc: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 1,
        width: "100%",
        minHeight: 34,
        padding: "5px 8px",
        background: "none",
        border: "none",
        borderRadius: 5,
        cursor: "pointer",
        textAlign: "left",
        font: "inherit",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
    >
      <span style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.4 }}>{title}</span>
      <span style={{ fontSize: 10, color: "var(--text-dim)", lineHeight: 1.3 }}>{desc}</span>
    </button>
  );
}

/** 切换选择器：直接 / 默认摘要 / 自定义焦点；busy 与错误反馈内联呈现。 */
function BranchSwitchChooser({ indent, mode, busy, pendingLabel, error, customFocus, onModeChange, onFocusChange, onChoose, onCancel, t }: {
  indent: number;
  mode: "options" | "custom";
  busy: boolean;
  pendingLabel: string;
  error: string | null;
  customFocus: string;
  onModeChange: (mode: "options" | "custom") => void;
  onFocusChange: (value: string) => void;
  onChoose: (choice: BranchSwitchChoice) => void;
  onCancel: () => void;
  t: I18nT;
}) {
  return (
    <div
      role="group"
      aria-label={t("branches_switchPrompt")}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) {
          e.stopPropagation();
          onCancel();
        }
      }}
      style={{
        margin: "1px 0 4px",
        // 深层树仍把选择器约束在面板内；树线保留深度信息，操作区不随深度无限右移。
        marginLeft: Math.min(indent, 64),
        border: "1px solid var(--border)",
        borderRadius: 6,
        background: "var(--bg-panel)",
        padding: 4,
      }}
    >
      {busy ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", fontSize: 12, color: "var(--text-muted)" }}>
          <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          {pendingLabel}
        </div>
      ) : mode === "options" ? (
        <div>
          <ChooserOption
            title={t("branches_switchDirect")}
            desc={t("branches_switchDirectHint")}
            onClick={() => onChoose({ mode: "direct" })}
          />
          <ChooserOption
            title={t("branches_switchSummary")}
            desc={t("branches_switchSummaryHint")}
            onClick={() => onChoose({ mode: "summary" })}
          />
          <ChooserOption
            title={t("branches_switchCustom")}
            desc={t("branches_switchCustomHint")}
            onClick={() => onModeChange("custom")}
          />
        </div>
      ) : (
        <div style={{ padding: 4 }}>
          <input
            autoFocus
            value={customFocus}
            onChange={(e) => onFocusChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && customFocus.trim()) onChoose({ mode: "custom", focus: customFocus });
              if (e.key === "Escape") {
                e.stopPropagation();
                onModeChange("options");
              }
            }}
            placeholder={t("branches_switchCustomPlaceholder")}
            aria-label={t("branches_switchCustom")}
            style={{
              width: "100%",
              height: 28,
              padding: "0 8px",
              fontSize: 12,
              color: "var(--text)",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 5,
              boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button
              type="button"
              disabled={!customFocus.trim()}
              onClick={() => onChoose({ mode: "custom", focus: customFocus })}
              style={{
                minHeight: 28,
                padding: "0 10px",
                fontSize: 11,
                borderRadius: 5,
                border: "1px solid var(--accent)",
                background: customFocus.trim() ? "var(--accent)" : "transparent",
                color: customFocus.trim() ? "#fff" : "var(--text-dim)",
                cursor: customFocus.trim() ? "pointer" : "not-allowed",
              }}
            >
              {t("branches_switchCustomSubmit")}
            </button>
            <button
              type="button"
              onClick={() => onModeChange("options")}
              style={{
                minHeight: 28,
                padding: "0 10px",
                fontSize: 11,
                borderRadius: 5,
                border: "1px solid var(--border)",
                background: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              {t("branches_switchBack")}
            </button>
          </div>
        </div>
      )}
      {error && (
        <div role="alert" style={{ padding: "4px 8px 2px", fontSize: 11, color: "var(--status-danger)", lineHeight: 1.4 }}>
          {error}
        </div>
      )}
    </div>
  );
}

/** 当前叶书签：设置 / 修改 / 清除；失败内联反馈，成功由 tree 刷新呈现。 */
function BranchBookmarkFooter({ currentLabel, disabled, onSubmit, t }: {
  currentLabel: string | null;
  disabled: boolean;
  onSubmit: (raw: string) => Promise<BranchActionResult>;
  t: I18nT;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const busy = disabled || saving;
  const trimmed = draft.trim();
  const unchanged = trimmed === (currentLabel ?? "");

  const submit = async (raw: string) => {
    if (busy) return;
    const value = raw.trim();
    if (value.length > BRANCH_LABEL_MAX_LENGTH) {
      setError(t("branches_bookmarkTooLong", { max: BRANCH_LABEL_MAX_LENGTH }));
      return;
    }
    setSaving(true);
    setError(null);
    const result = await onSubmit(value);
    setSaving(false);
    if (result.kind === "ok") {
      setEditing(false);
      return;
    }
    if (result.kind === "busy") {
      setError(t("branches_waitForRun"));
      return;
    }
    setError(result.kind === "error" && result.message
      ? `${t("branches_bookmarkFailed")}: ${result.message}`
      : t("branches_bookmarkFailed"));
  };

  const startEdit = (initial: string) => {
    setDraft(initial);
    setError(null);
    setEditing(true);
  };

  const textButtonStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    minHeight: 28,
    padding: "0 8px",
    fontSize: 11,
    borderRadius: 5,
    border: "1px solid var(--border)",
    background: "none",
    color: "var(--text-muted)",
    cursor: busy ? "not-allowed" : "pointer",
    flexShrink: 0,
    opacity: busy ? 0.55 : 1,
  };

  return (
    <div style={{ borderTop: "1px solid var(--border)", padding: "6px 12px 8px", flexShrink: 0 }}>
      {editing ? (
        <div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              ref={inputRef}
              value={draft}
              maxLength={BRANCH_LABEL_MAX_LENGTH}
              disabled={saving}
              onChange={(e) => { setDraft(e.target.value); setError(null); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && trimmed && !unchanged) void submit(trimmed);
                if (e.key === "Escape") { setEditing(false); setError(null); }
              }}
              placeholder={t("branches_bookmarkPlaceholder")}
              aria-label={t("branches_bookmarkPlaceholder")}
              style={{
                flex: 1,
                minWidth: 0,
                height: 28,
                padding: "0 8px",
                fontSize: 12,
                color: "var(--text)",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 5,
              }}
            />
            <button
              type="button"
              disabled={busy || !trimmed || unchanged}
              onClick={() => void submit(trimmed)}
              style={{
                ...textButtonStyle,
                border: "1px solid var(--accent)",
                background: !trimmed || unchanged ? "transparent" : "var(--accent)",
                color: !trimmed || unchanged ? "var(--text-dim)" : "#fff",
                cursor: busy || !trimmed || unchanged ? "not-allowed" : "pointer",
                opacity: 1,
              }}
            >
              {t("branches_bookmarkSave")}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => { setEditing(false); setError(null); }}
              style={textButtonStyle}
            >
              {t("branches_bookmarkCancel")}
            </button>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4, minHeight: 14 }}>
            {error ? (
              <span role="alert" style={{ fontSize: 10, color: "var(--status-danger)", lineHeight: 1.4 }}>{error}</span>
            ) : (
              <span />
            )}
            <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>
              {draft.length}/{BRANCH_LABEL_MAX_LENGTH}
            </span>
          </div>
        </div>
      ) : (
        <div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, minHeight: 28 }}>
            <span style={{
              fontSize: 10,
              color: "var(--text-dim)",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              flexShrink: 0,
            }}>
              {t("branches_currentPoint")}
            </span>
            {currentLabel ? (
              <>
                <span
                  title={currentLabel}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    minWidth: 0,
                    flex: 1,
                    fontSize: 11,
                    color: "var(--text)",
                  }}
                >
                  <span style={{ color: "var(--accent)", display: "flex", flexShrink: 0 }}>
                    <BookmarkIcon size={10} />
                  </span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {currentLabel}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => startEdit(currentLabel)}
                  title={t("branches_editBookmark")}
                  style={textButtonStyle}
                >
                  {t("branches_editBookmark")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void submit("")}
                  title={t("branches_removeBookmark")}
                  style={textButtonStyle}
                >
                  {t("branches_removeBookmark")}
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => startEdit("")}
                style={{ ...textButtonStyle, gap: 5 }}
              >
                <BookmarkIcon size={10} />
                {t("branches_addBookmark")}
              </button>
            )}
          </div>
          {error && (
            <div role="alert" style={{ marginTop: 4, fontSize: 10, color: "var(--status-danger)", lineHeight: 1.4 }}>
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function BranchNavigator({ tree, activeLeafId, onLeafChange, inline, containerRef, open: openProp, onToggle, hasSession, compact, branchActions, panel }: Props) {
  const { t } = useI18n();
  const [openInternal, setOpenInternal] = useState(false);
  const open = openProp !== undefined ? openProp : openInternal;
  const btnRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);

  // 切换选择器状态：targetId 之外的模式/焦点/错误/进行中全部局部化。
  const [switchTargetId, setSwitchTargetId] = useState<string | null>(null);
  const [chooserMode, setChooserMode] = useState<"options" | "custom">("options");
  const [customFocus, setCustomFocus] = useState("");
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [pendingMode, setPendingMode] = useState<BranchSwitchChoice["mode"] | null>(null);

  const canWrite = branchActions?.canWrite === true;
  const actionsBusy = branchActions?.busy === true;

  useEffect(() => {
    if (!open || !inline) return;
    const anchor = containerRef?.current ?? btnRef.current;
    if (!anchor) return;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom, left: rect.left, width: rect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(anchor);
    return () => ro.disconnect();
  }, [open, inline, containerRef]);

  // 面板关闭后复位选择器；树刷新（保存书签、agent 结束等）后目标可能已过期。
  useEffect(() => {
    if (open) return;
    setSwitchTargetId(null);
    setSwitchError(null);
    setChooserMode("options");
    setCustomFocus("");
    setPendingMode(null);
  }, [open]);
  useEffect(() => {
    setSwitchTargetId(null);
    setSwitchError(null);
  }, [tree]);

  const activePathIds = useMemo(
    () => buildActivePath(tree, activeLeafId),
    [tree, activeLeafId]
  );

  const bookmarksExist = useMemo(() => treeHasBookmarks(tree), [tree]);
  const currentLeafLabel = useMemo(
    () => findBranchLabelByEntryId(tree, activeLeafId),
    [tree, activeLeafId],
  );

  const closeDropdown = useCallback(() => {
    if (openProp !== undefined) {
      // 受控模式：仅在确实打开时交给外部切换，避免反向打开。
      if (openProp) onToggle?.();
      return;
    }
    setOpenInternal(false);
  }, [openProp, onToggle]);

  const handleNodeActivate = useCallback((rep: SessionTreeNode) => {
    if (actionsBusy) return;
    const targetId = rep.entry.id;
    // 与 TreeNodeView 一致：leaf 在压缩链中非链末（分叉未发送）时不算当前，可点击切到链末
    // 与 TreeNodeView 一致：leaf 在压缩链中（分叉未发送）非当前，可点击切到链末 = 主分支
    const isCurrentLeaf = targetId === activeLeafId;
    if (isCurrentLeaf) {
      // 点击当前叶不触发切换；若选择器开着则收起。
      setSwitchTargetId(null);
      return;
    }
    if (canWrite) {
      // 可写会话：先给轻量选择（直接 / 默认摘要 / 自定义焦点），不立即跳转。
      setSwitchError(null);
      setChooserMode("options");
      setCustomFocus("");
      setSwitchTargetId((cur) => (cur === targetId ? null : targetId));
      return;
    }
    // 只读会话：保持既有纯 GET context 的直跳行为。
    onLeafChange(targetId);
  }, [actionsBusy, activeLeafId, canWrite, onLeafChange]);

  const runSwitch = useCallback(async (choice: BranchSwitchChoice) => {
    if (!branchActions || !switchTargetId || branchActions.busy) return;
    setSwitchError(null);
    setPendingMode(choice.mode);
    const result = await branchActions.navigate(switchTargetId, choice);
    setPendingMode(null);
    if (result.kind === "ok") {
      setSwitchTargetId(null);
      // 切换成功：收起面板，让用户直接看到新分支上下文。
      closeDropdown();
      return;
    }
    // 取消/中止：保留当前 context，静默收起选择器。
    if (result.kind === "cancelled") {
      setSwitchTargetId(null);
      return;
    }
    if (result.kind === "busy") {
      setSwitchError(t("branches_waitForRun"));
      return;
    }
    setSwitchError(result.message ? `${t("branches_switchFailed")}: ${result.message}` : t("branches_switchFailed"));
  }, [branchActions, switchTargetId, closeDropdown, t]);

  const chooserFor = useCallback((nodeId: string, indent: number): ReactNode => {
    if (switchTargetId !== nodeId || !canWrite) return null;
    return (
      <BranchSwitchChooser
        indent={indent}
        mode={chooserMode}
        busy={pendingMode !== null || actionsBusy}
        pendingLabel={pendingMode === "direct" ? t("branches_switching") : t("branches_summarizing")}
        error={switchError}
        customFocus={customFocus}
        onModeChange={(mode) => { setChooserMode(mode); setSwitchError(null); }}
        onFocusChange={setCustomFocus}
        onChoose={(choice) => void runSwitch(choice)}
        onCancel={() => setSwitchTargetId(null)}
        t={t}
      />
    );
  }, [switchTargetId, canWrite, chooserMode, pendingMode, actionsBusy, switchError, customFocus, runSwitch, t]);

  // 分叉/导航后未发送（leaf 不在文件末尾）也显示树：体现当前位置并可切回主分支
  const leafAtEnd = activeLeafId ? isLeafAtTreeEnd(tree, activeLeafId) : true;
  const noBranchReason = !hasSession
    ? t("branches_noSession")
    : !hasBranch(tree) && !bookmarksExist && leafAtEnd
      ? t("branches_empty")
      : null;

  // Find first meaningful node (skip pure linear prefix)
  // 根节点就是会话的主分支起点。始终保留根行，避免主分支在无书签时被
  // 压缩链吞掉；其 children 仍按原规则压缩，分支切换语义不变。
  const rows = tree.length > 0 ? [tree[0]] : [];
  const hasContent = !noBranchReason && rows.length > 0;
  // 分叉/导航后未发送：leaf 不在文件末尾 → 面板顶部显示当前位置指示
  const showCurrentPosition = panel && !leafAtEnd && !noBranchReason;
  const assistantLabel = t("branches_assistant");
  const bookmarkAria = t("branches_bookmarkAria");

  const positionHint = showCurrentPosition ? (
    <div style={{ padding: "4px 12px 2px 12px", fontSize: 11, color: "var(--text-dim)" }}>
      {t("branches_currentPosition")}
    </div>
  ) : null;

  const panelContent = (
    <>
      {positionHint}
      {hasContent ? (
        <div style={{ padding: "4px 12px 8px 12px", maxHeight: 260, overflowY: "auto" }}>
          {rows.map((row, idx) => (
            <TreeNodeView
              key={row.entry.id}
              node={row}
              activePathIds={activePathIds}
              activeLeafId={activeLeafId}
              depth={0}
              isLast={idx === rows.length - 1}
              parentLines={[]}
              onActivate={handleNodeActivate}
              assistantLabel={assistantLabel}
              bookmarkAria={bookmarkAria}
              switchable={canWrite}
              switchTargetId={switchTargetId}
              chooserFor={chooserFor}
              disabled={actionsBusy}
              preserveRoot
            />
          ))}
        </div>
      ) : (
        <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
          {noBranchReason}
        </div>
      )}
    </>
  );

  const bookmarkFooter = canWrite && activeLeafId ? (
    <BranchBookmarkFooter
      key={activeLeafId}
      currentLabel={currentLeafLabel}
      disabled={actionsBusy}
      onSubmit={(raw) => branchActions!.setLabel(activeLeafId, raw)}
      t={t}
    />
  ) : null;

  const branchIcon = actionsBusy ? (
    <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ color: "var(--accent)", flexShrink: 0 }}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ) : (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: hasContent ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );

  const chevron = (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 2, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
      <polyline points="2 3.5 5 6.5 8 3.5" />
    </svg>
  );

  if (inline) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "stretch" }}>
        <button
          ref={btnRef}
          onClick={() => onToggle ? onToggle() : setOpenInternal((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: "100%",
            padding: "0 12px",
            background: open ? "var(--bg-selected)" : "none",
            border: "none",
            borderTop: open ? "2px solid var(--accent)" : "2px solid transparent",
            borderRight: "1px solid var(--border)",
            cursor: "pointer",
            color: open ? "var(--text)" : "var(--text-muted)",
            fontSize: 11,
            whiteSpace: "nowrap",
            transition: "color 0.1s, background 0.1s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = open ? "var(--text)" : "var(--text-muted)"; }}
          title={t("branches")}
          aria-label={t("branches")}
          aria-pressed={open}
        >
          {branchIcon}
          {!compact && <span>{t("branches")}</span>}
        </button>
        {open && dropdownPos && (
          <div style={{
            position: "fixed",
            top: dropdownPos.top,
            left: dropdownPos.left,
            width: dropdownPos.width,
            background: "var(--bg-panel)",
            borderBottom: "1px solid var(--border)",
            zIndex: 500,
          }}>
            {panelContent}
            {bookmarkFooter}
          </div>
        )}
      </div>
    );
  }

  if (panel) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg-panel)" }}>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingTop: 8 }}>{panelContent}</div>
        {bookmarkFooter}
      </div>
    );
  }

  return (
    <div style={{ borderBottom: "1px solid var(--border)", background: "var(--bg)", flexShrink: 0, position: "relative" }}>
      {/* Header toggle */}
      <button
        onClick={() => setOpenInternal((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "5px 12px",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--text-muted)",
          fontSize: 11,
          textAlign: "left",
        }}
      >
        {branchIcon}
        <span style={{ color: "var(--text-muted)" }}>{t("branches")}</span>
        {chevron}
      </button>

      {/* Tree panel - overlay */}
      {open && (
        <div style={{
          position: "absolute",
          top: "100%",
          left: 0,
          right: 0,
          background: "var(--bg)",
          borderBottom: "1px solid var(--border)",
          boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
          zIndex: 100,
        }}>
          {panelContent}
          {bookmarkFooter}
        </div>
      )}
    </div>
  );
}
