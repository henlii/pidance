"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { SessionInfo } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { copyText } from "@/lib/clipboard";
import {
  buildSessionExportHtmlHref,
  buildSessionExportJsonlHref,
  canExportSession,
} from "../session-export-links";
import { didMenuAnchorMove } from "@/lib/menu-anchor";
import {
  AnimatedDropdown,
  ArchiveIcon,
  MoreVerticalIcon,
  PencilIcon,
  PinIcon,
  ProjectMenuItem,
  SidebarIconButton,
  TrashIcon,
  XIcon,
  iconProps,
} from "./display";

// ── 项目行三点菜单 ─────────────────────────────────────────────────────────

/**
 * 项目行竖向三点菜单：仅「编辑项目」「关闭项目」两项，均带图标。
 * 同一时刻仅一个菜单打开（父组件以 root 标识控制）；Escape 与点击外部关闭，
 * 关闭后焦点恢复触发按钮；桌面行 hover/focus-within 渐进显露，粗指针常显。
 * 本轮不提供右键菜单。
 */
export function ProjectRowMenu({ open, onOpenChange, projectName, onEdit, onClose }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前显示名（alias 或路径显示名），仅用于 aria 文案。 */
  projectName: string;
  onEdit: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const anchorRef = useRef<{ top: number; bottom: number; right: number } | null>(null);

  const closeMenu = useCallback((restoreFocus: boolean) => {
    onOpenChange(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, [onOpenChange]);

  const openMenu = useCallback(() => {
    if (open) {
      closeMenu(true);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      // 与 SessionRowMenu 同一适配：项目行可能在侧栏滚动容器深处，absolute
      // 向下展开会被容器裁切/超出视口；改为 fixed，先按向下展开定位，
      // 渲染后按实际菜单高度校正（估算高度会造成翻转位置偏差）。
      anchorRef.current = { top: rect.top, bottom: rect.bottom, right: rect.right };
      setPosition({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
    }
    onOpenChange(true);
  }, [open, closeMenu, onOpenChange]);

  // 渲染后按实际菜单高度校正：底部空间不足时向上翻转（offsetHeight 不受
  // 展开动画 transform 影响，避免 scale 导致测量偏差）。
  useEffect(() => {
    if (!open || !anchorRef.current) return;
    const frame = requestAnimationFrame(() => {
      const menu = menuRef.current;
      const anchor = anchorRef.current;
      if (!menu || !anchor) return;
      const height = menu.offsetHeight;
      if (anchor.bottom + 4 + height <= window.innerHeight) return;
      setPosition((prev) => (prev ? { ...prev, top: Math.max(8, anchor.top - height - 4) } : prev));
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // 点击外部关闭（不抢焦点：点击目标自然获得焦点）
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      // 菜单 portal 到 body：点击菜单本体（菜单项）不算外部，否则 mousedown 先
      // 关闭菜单导致菜单项 click 丢失（表现为「点了没反应」）。
      if (
        wrapperRef.current
        && !wrapperRef.current.contains(e.target as Node)
        && !menuRef.current?.contains(e.target as Node)
      ) {
        onOpenChange(false);
      }
    };
    const onScrollOrResize = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!didMenuAnchorMove(anchorRef.current, rect ? { top: rect.top, right: rect.right } : null)) return;
      onOpenChange(false);
    };
    document.addEventListener("mousedown", handler);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", handler);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, onOpenChange]);

  // 打开后焦点移入第一个菜单项（菜单键盘可达；Esc 由 wrapper onKeyDown 拦截）
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return (
    <div
      ref={wrapperRef}
      style={{ position: "relative", flexShrink: 0, display: "flex" }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          e.preventDefault();
          closeMenu(true);
        }
      }}
    >
      <SidebarIconButton
        label={t("sidebar_projectMenuLabel", { project: projectName })}
        active={open}
        expanded={open}
        haspopup="menu"
        hoverReveal
        buttonRef={triggerRef}
        onClick={(e) => {
          e.stopPropagation();
          openMenu();
        }}
      >
        <MoreVerticalIcon size={14} />
      </SidebarIconButton>
      {open && createPortal(
        <AnimatedDropdown
          open={open}
          style={{
            position: "fixed",
            top: position?.top ?? 0,
            right: position?.right ?? 0,
            zIndex: 600,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-float)",
            overflow: "hidden",
            minWidth: 148,
          }}
        >
          <div ref={menuRef} role="menu" aria-label={t("sidebar_projectMenuLabel", { project: projectName })}>
            <ProjectMenuItem
              icon={<PencilIcon size={13} />}
              label={t("sidebar_editProject")}
              onClick={() => { closeMenu(true); onEdit(); }}
            />
            <ProjectMenuItem
              icon={<XIcon size={13} />}
              label={t("sidebar_closeProject")}
              onClick={() => { closeMenu(true); onClose(); }}
            />
          </div>
        </AnimatedDropdown>,
        document.body,
      )}
    </div>
  );
}

export function SessionRowMenu({ session, title, canRename, canDelete, canArchive, archiveDisabledReason, isPinned, onTogglePin, onRename, onDelete, onArchive }: { session: SessionInfo; title: string; canRename: boolean; canDelete: boolean; canArchive: boolean; archiveDisabledReason: string | null; isPinned?: boolean; onTogglePin?: () => void; onRename: () => void; onDelete: () => void; onArchive: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const anchorRef = useRef<{ top: number; bottom: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const label = t("sidebar_sessionMenuLabel", { session: title });
  const close = useCallback((focus = false) => { setOpen(false); if (focus) triggerRef.current?.focus(); }, []);

  // 渲染后按实际菜单高度校正：底部空间不足时向上翻转（估算高度会造成位置偏差）。
  useEffect(() => {
    if (!open || !anchorRef.current) return;
    const frame = requestAnimationFrame(() => {
      const menu = menuRef.current;
      const anchor = anchorRef.current;
      if (!menu || !anchor) return;
      const height = menu.offsetHeight;
      if (anchor.bottom + 4 + height <= window.innerHeight) return;
      setPosition((prev) => (prev ? { ...prev, top: Math.max(8, anchor.top - height - 4) } : prev));
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) close();
    };
    const onScrollOrResize = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!didMenuAnchorMove(anchorRef.current, rect ? { top: rect.top, right: rect.right } : null)) return;
      close();
    };
    document.addEventListener("mousedown", outside);
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    const frame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus());
    return () => { cancelAnimationFrame(frame); document.removeEventListener("mousedown", outside); window.removeEventListener("resize", onScrollOrResize); window.removeEventListener("scroll", onScrollOrResize, true); };
  }, [close, open]);

  const openMenu = () => {
    if (open) { close(); return; }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      // fixed 定位 + 渲染后按实际高度翻转校正（见上方 effect），
      // 避免最后几行的删除项被裁切。
      anchorRef.current = { top: rect.top, bottom: rect.bottom, right: rect.right };
      setPosition({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
    }
    setOpen(true);
  };
  const itemStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 8, width: "100%", minHeight: 32, padding: "6px 11px", boxSizing: "border-box", background: "var(--bg-elevated)", border: "none", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", textDecoration: "none", fontSize: 12, whiteSpace: "nowrap" };
  const hover = {
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; },
    onMouseLeave: (event: React.MouseEvent<HTMLElement>) => { event.currentTarget.style.background = "var(--bg-elevated)"; event.currentTarget.style.color = "var(--text-muted)"; },
  };
  const menuIcon = (child: ReactNode) => <span aria-hidden="true" style={{ display: "flex", color: "var(--text-dim)" }}>{child}</span>;

  return <div style={{ display: "flex", flexShrink: 0 }} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape" && open) { event.preventDefault(); close(true); } }}>
    <SidebarIconButton label={label} active={open} expanded={open} haspopup="menu" hoverReveal buttonRef={triggerRef} onClick={(event) => { event.stopPropagation(); openMenu(); }}><MoreVerticalIcon size={14}/></SidebarIconButton>
    {open && position && createPortal(
      <div ref={menuRef} role="menu" aria-label={label} style={{ position: "fixed", top: position.top, right: position.right, zIndex: 600, minWidth: 190, padding: 4, background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)" }}>
      {canRename && <button type="button" role="menuitem" style={itemStyle} {...hover} onClick={() => { close(); onRename(); }}>{menuIcon(<PencilIcon size={13}/>)}{t("sidebar_renameSession")}</button>}
      <button type="button" role="menuitem" style={itemStyle} {...hover} onClick={() => { close(); void copyText(session.id); }}>{menuIcon(<svg {...iconProps(13)}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>)}{t("sidebar_copySessionId")}</button>
      {!session.subagent && onTogglePin && <button type="button" role="menuitem" style={itemStyle} {...hover} onClick={() => { close(); onTogglePin(); }}>{menuIcon(<PinIcon size={13}/>)}{t(isPinned ? "sidebar_unpinSession" : "sidebar_pinSession")}</button>}
      {(canArchive || archiveDisabledReason !== null) && <button type="button" role="menuitem" disabled={!canArchive} title={!canArchive ? archiveDisabledReason ?? undefined : undefined} style={{ ...itemStyle, opacity: !canArchive ? 0.45 : 1, cursor: !canArchive ? "not-allowed" : "pointer" }} onClick={() => { if (!canArchive) return; close(); onArchive(); }}>{menuIcon(<ArchiveIcon size={13}/>)}{t("sidebar_archiveSession")}</button>}
      {canExportSession(session) && <><a role="menuitem" href={buildSessionExportHtmlHref(session.id)} download style={itemStyle} {...hover} onClick={() => close()}>{menuIcon(<svg {...iconProps(13)}><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>)}{t("sidebar_exportSessionHtml")}</a>
      <a role="menuitem" href={buildSessionExportJsonlHref(session.id, null)} download style={itemStyle} {...hover} onClick={() => close()}>{menuIcon(<svg {...iconProps(13)}><path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-4a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/></svg>)}{t("sidebar_exportSessionJsonl")}</a></>}
      {canDelete && <><div style={{ height: 1, margin: "4px 6px", background: "var(--border)" }}/><button type="button" role="menuitem" style={{ ...itemStyle, color: "var(--status-danger)" }} onClick={() => { close(); onDelete(); }}>{menuIcon(<TrashIcon size={13}/>)}{t("sidebar_deleteSession")}</button></>}
      </div>,
      document.body,
    )}
  </div>;
}
