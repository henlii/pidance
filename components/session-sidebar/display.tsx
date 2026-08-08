"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import { formatRunningDuration } from "@/lib/running-duration";
import {
  GROUP_VISIBLE_PAGE_SIZE,
  canShowFewerTopLevel,
  canShowMoreTopLevel,
} from "../session-sidebar-state";

export function formatRelativeTime(dateStr: string, t: ReturnType<typeof useI18n>["t"]): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return t("sidebar_justNow");
  if (mins < 60) return t("sidebar_minutesAgo", { count: mins });
  if (hours < 24) return t("sidebar_hoursAgo", { count: hours });
  if (days < 7) return t("sidebar_daysAgo", { count: days });
  return date.toLocaleDateString();
}

export function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        minWidth: 0,
        lineHeight: 1.35,
        direction: "rtl",
        textAlign: "left",
        ...style,
      }}
    >
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}

const DROPDOWN_ANIMATION_MS = 140;

export function AnimatedDropdown({ open, children, style }: { open: boolean; children: ReactNode; style: CSSProperties }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    let frame: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (open) {
      setMounted(true);
      setVisible(false);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      timeout = setTimeout(() => setMounted(false), DROPDOWN_ANIMATION_MS);
    }

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (timeout) clearTimeout(timeout);
    };
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      style={{
        ...style,
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0) scale(1)" : "translateY(-8px) scale(0.96)",
        transformOrigin: "top center",
        transition: `opacity ${DROPDOWN_ANIMATION_MS}ms ease, transform ${DROPDOWN_ANIMATION_MS}ms ease`,
        pointerEvents: open ? "auto" : "none",
      }}
    >
      {children}
    </div>
  );
}

const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";

export function useScramble(target: string, running: boolean): string {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number | null>(null);
  const iterRef = useRef(0);

  useEffect(() => {
    if (!running) {
      setDisplay(target);
      return;
    }
    iterRef.current = 0;
    const totalFrames = target.length * 4;

    const step = () => {
      iterRef.current += 1;
      const progress = iterRef.current / totalFrames;
      const resolved = Math.floor(progress * target.length);

      setDisplay(
        target
          .split("")
          .map((char, i) => {
            if (char === " ") return " ";
            if (i < resolved) return char;
            return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
          })
          .join("")
      );

      if (iterRef.current < totalFrames) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        setDisplay(target);
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [target, running]);

  return display;
}

export function PiWebTitle() {
  const [showVersion, setShowVersion] = useState(false);
  const [scrambling, setScrambling] = useState(false);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const target = showVersion ? `${process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}p${process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}` : "Pidance";
  const display = useScramble(target, scrambling);

  const triggerScramble = useCallback((toVersion: boolean) => {
    setShowVersion(toVersion);
    setScrambling(true);
    setTimeout(() => setScrambling(false), (toVersion ? 6 : 8) * 4 * (1000 / 60) + 100);
  }, []);

  const handleClick = useCallback(() => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);

    const next = !showVersion;
    triggerScramble(next);

    if (next) {
      revertTimerRef.current = setTimeout(() => triggerScramble(false), 3000);
    }
  }, [showVersion, triggerScramble]);

  useEffect(() => () => { if (revertTimerRef.current) clearTimeout(revertTimerRef.current); }, []);

  return (
    <button
      onClick={handleClick}
      style={{
        background: "none", border: "none", padding: 0, cursor: "default",
        fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em",
        color: showVersion ? "var(--accent)" : "var(--text)",
        fontFamily: "var(--font-mono)",
        minWidth: "6ch",
      }}
    >
      {display}
    </button>
  );
}

// ── 统一图标按钮与图标 ─────────────────────────────────────────────────────

/**
 * 会话栏统一图标按钮：24×24 盒、6px 圆角、hover/active/focus-visible/disabled
 * 样式全部由 globals.css 的 .sidebar-icon-btn 系列类承载；
 * label 同时作为 title（tooltip）与 aria-label。
 */
export function SidebarIconButton({
  label,
  onClick,
  disabled = false,
  active = false,
  danger = false,
  done = false,
  hoverReveal = false,
  expanded,
  pressed,
  haspopup,
  buttonRef,
  children,
}: {
  label: string;
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
  /** toggle 开启态（搜索/菜单展开）。 */
  active?: boolean;
  /** 危险操作（hover 变红）。 */
  danger?: boolean;
  /** 刷新完成反馈态。 */
  done?: boolean;
  /** 行内操作渐进显露：细指针下行 hover/focus-within 才可见；
      hover:none / 粗指针设备上常显（globals.css 媒体查询），保证触屏可发现。 */
  hoverReveal?: boolean;
  expanded?: boolean;
  pressed?: boolean;
  /** 弹出菜单语义（aria-haspopup），项目行三点菜单使用。 */
  haspopup?: "menu" | boolean;
  /** 触发按钮 ref：菜单关闭后焦点恢复用。 */
  buttonRef?: React.Ref<HTMLButtonElement>;
  children: ReactNode;
}) {
  const classes = ["sidebar-icon-btn"];
  if (active) classes.push("sidebar-icon-btn--active");
  if (danger) classes.push("sidebar-icon-btn--danger");
  if (done) classes.push("sidebar-icon-btn--done");
  if (hoverReveal) classes.push("sidebar-icon-btn--hover");
  return (
    <button
      type="button"
      ref={buttonRef}
      onClick={onClick}
      disabled={disabled}
      data-tooltip={label}
      aria-label={label}
      aria-expanded={expanded}
      aria-pressed={pressed}
      aria-haspopup={haspopup}
      className={classes.join(" ")}
    >
      {children}
    </button>
  );
}

export function iconProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  } as const;
}

export const FolderPlusIcon = ({ size = 18 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    <path d="M12 10v6" />
    <path d="M9 13h6" />
  </svg>
);

export const FolderIcon = ({ size = 14 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
);

export const HistoryIcon = ({ size = 14 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
    <path d="M12 7v5l3 2" />
  </svg>
);

/** lucide archive：归档入口（侧栏工具栏与行菜单共用）。 */
export const ArchiveIcon = ({ size = 18 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <rect x="2" y="3" width="20" height="5" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
    <path d="M10 12h4" />
  </svg>
);

export const ChatPlusIcon = ({ size = 18 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    <path d="M12 7v6" />
    <path d="M9 10h6" />
  </svg>
);

export const SearchIcon = ({ size = 18 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

export const SlidersIcon = ({ size = 18 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <line x1="21" x2="14" y1="4" y2="4" />
    <line x1="10" x2="3" y1="4" y2="4" />
    <line x1="21" x2="12" y1="12" y2="12" />
    <line x1="8" x2="3" y1="12" y2="12" />
    <line x1="21" x2="16" y1="20" y2="20" />
    <line x1="12" x2="3" y1="20" y2="20" />
    <line x1="14" x2="14" y1="2" y2="6" />
    <line x1="8" x2="8" y1="10" y2="14" />
    <line x1="16" x2="16" y1="18" y2="22" />
  </svg>
);

export const RefreshIcon = ({ size = 18 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

export const CheckIcon = ({ size = 14 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export const HomeIcon = ({ size = 15 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <polyline points="9 22 9 12 15 12 15 22" />
  </svg>
);

export const XIcon = ({ size = 14 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

export const BranchIcon = ({ size = 12 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <line x1="6" y1="3" x2="6" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </svg>
);

export const BranchPlusIcon = ({ size = 14 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <line x1="6" y1="3" x2="6" y2="15" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
    <circle cx="18" cy="6" r="3" />
    <path d="M15.5 17.5h5" />
    <path d="M18 15v5" />
  </svg>
);

export const TrashIcon = ({ size = 13 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </svg>
);

export const PencilIcon = ({ size = 13 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
  </svg>
);

export const LayersIcon = ({ size = 10 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <polygon points="12 2 2 7 12 12 22 7 12 2" />
    <polyline points="2 17 12 22 22 17" />
    <polyline points="2 12 12 17 22 12" />
  </svg>
);

/** 竖向三点（⋮）：项目行菜单触发图标。 */
export const MoreVerticalIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="12" cy="5" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="12" cy="19" r="1.7" />
  </svg>
);

/** 折叠 chevron：20×20 透明小按钮，旋转表示折叠态。 */
export function ChevronButton({ collapsed, label, left, onClick }: {
  collapsed: boolean;
  label: string;
  left: number;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => { onClick(e); e.currentTarget.blur(); }}
      data-tooltip={label}
      aria-label={label}
      className="sidebar-indent-indicator"
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        position: "absolute", left, top: "50%",
        width: 16, height: 20, padding: 0, flexShrink: 0,
        zIndex: 1,
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
  );
}

// ── 弹窗按钮 ──────────────────────────────────────────────────────────────

/** 弹窗按钮：primary 为主操作（accent 填充白字），danger 为危险操作（红底白字），其余为次级（描边）。 */
export function DialogButton({ primary = false, danger = false, disabled = false, onClick, children }: {
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: (e: React.MouseEvent) => void;
  children: ReactNode;
}) {
  const filled = primary || danger;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        height: 30,
        padding: "0 14px",
        flexShrink: 0,
        background: danger ? "var(--status-danger)" : primary ? "var(--accent)" : "var(--bg)",
        border: filled ? "none" : "1px solid var(--border)",
        borderRadius: 7,
        color: filled ? "#fff" : "var(--text-muted)",
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize: 12,
        fontWeight: filled ? 600 : 500,
        opacity: disabled ? 0.55 : 1,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

// ── 显示模式菜单项 ─────────────────────────────────────────────────────────

export function DisplayMenuItem({ label, checked, onClick }: { label: string; checked?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        width: "100%",
        padding: "7px 10px",
        background: "var(--bg-elevated)",
        border: "none",
        color: checked ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer",
        textAlign: "left",
        fontSize: 11.5,
      }}
    >
      {checked
        ? <span style={{ color: "var(--accent)", display: "flex", flexShrink: 0 }}><CheckIcon size={11} /></span>
        : <span style={{ width: 11, flexShrink: 0 }} />}
      {label}
    </button>
  );
}

export function ProjectMenuItem({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "7px 12px",
        background: "var(--bg-elevated)",
        border: "none",
        color: "var(--text-muted)",
        cursor: "pointer",
        textAlign: "left",
        fontSize: 12,
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-hover)";
        e.currentTarget.style.color = "var(--text)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "var(--bg-elevated)";
        e.currentTarget.style.color = "var(--text-muted)";
      }}
      onFocus={(e) => {
        e.currentTarget.style.background = "var(--bg-hover)";
        e.currentTarget.style.color = "var(--text)";
      }}
      onBlur={(e) => {
        e.currentTarget.style.background = "var(--bg-elevated)";
        e.currentTarget.style.color = "var(--text-muted)";
      }}
    >
      <span style={{ display: "flex", flexShrink: 0, color: "var(--text-dim)" }} aria-hidden="true">{icon}</span>
      {label}
    </button>
  );
}

export interface WorktreeActions {
  /** 本项目 worktree 状态已加载且为 git 顶层检出：可创建/删除。 */
  canManage: boolean;
  createHint: string;
  busy: boolean;
}

export function GroupPagination({ groupKey, total, visibleCount, searchActive, onShowMore, onShowFewer }: {
  groupKey: string;
  total: number;
  visibleCount: number;
  searchActive: boolean;
  onShowMore: (groupKey: string) => void;
  onShowFewer: (groupKey: string) => void;
}) {
  const { t } = useI18n();
  const showMore = canShowMoreTopLevel(total, visibleCount, searchActive);
  const showFewer = canShowFewerTopLevel(visibleCount, searchActive);
  if (!showMore && !showFewer) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 8px 5px 28px" }}>
      {showMore && (
        <button type="button" className="sidebar-pagination-btn" onClick={() => onShowMore(groupKey)}>
          {t("sidebar_showMore")}
          <span aria-hidden="true">+{GROUP_VISIBLE_PAGE_SIZE}</span>
        </button>
      )}
      {showFewer && (
        <button type="button" className="sidebar-pagination-btn" onClick={() => onShowFewer(groupKey)}>
          {t("sidebar_showFewer")}
        </button>
      )}
    </div>
  );
}

export function RunningSessionIndicator({ size = 14 }: { size?: number }) {
  const { t } = useI18n();
  return (
    <span
      title={t("sidebar_running")}
      aria-label={t("sidebar_running")}
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--status-running)",
      }}
    >
      {/* 空心圆环 + 旋转缺口：套在图标列之上，居中，带旋转动画表示运行中。 */}
      <span
        aria-hidden="true"
        style={{
          display: "block",
          width: size - 4,
          height: size - 4,
          borderRadius: "50%",
          border: "2px solid currentColor",
          borderTopColor: "transparent",
          background: "transparent",
          boxSizing: "border-box",
          animation: "sidebar-running-spin 1s linear infinite",
        }}
      />
    </span>
  );
}

/**
 * 展开会话行的运行时长（P1-5）：仅时长文本（圆环只在图标列显示一次，避免双环）。
 * - running + startedAt（首次见到 running 的时刻）：显示如「2m 14s」；
 * - running + 无 startedAt（刷新后 SSE 重建，无法确认真实开始时间）：
 *   显示「运行中」而不是伪造时长；
 * - 非 running：不渲染。
 * 折叠的父组/项目/worktree 行只使用 RunningSessionIndicator（聚合圆点），
 * 不渲染本组件——单个时长无法代表多个任务。
 */
export function RunningDurationText({ startedAt, now, running }: {
  startedAt?: number;
  now: number;
  running: boolean;
}) {
  const { t } = useI18n();
  if (!running) return null;
  return (
    <span
      title={t("sidebar_running")}
      style={{
        display: "inline-flex",
        alignItems: "center",
        flexShrink: 0,
        color: "var(--status-running)",
        fontSize: 10,
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
      }}
    >
      <span>
        {startedAt !== undefined
          ? formatRunningDuration(Math.max(0, now - startedAt), t)
          : t("sidebar_running")}
      </span>
    </span>
  );
}

export function UnreadSessionIndicator({ size = 14 }: { size?: number }) {
  const { t } = useI18n();
  return (
    <span
      title={t("sidebar_activity")}
      aria-label={t("sidebar_activity")}
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--status-unread)",
      }}
    >
      <span aria-hidden="true" style={{ display: "block", width: 6, height: 6, borderRadius: "50%", background: "currentColor" }} />
    </span>
  );
}
