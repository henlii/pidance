"use client";

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  acquireDialogBodyLock,
  isTopDialogInstance,
  pickInitialFocusTarget,
  registerDialogInstance,
  resolveFocusRestoreTarget,
  resolveDialogKeyDown,
  resolveTabTrap,
} from "./dialog-guards";

// SSR 时降级为 useEffect，避免服务端渲染告警；视口跟踪只在客户端发生。
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** 当前 visual viewport 在 fixed 定位坐标系（layout viewport 原点）中的精确区域 */
export interface DialogViewportRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * 读取 window.visualViewport 的 offsetLeft/offsetTop/width/height；
 * 不存在或数值异常时回退 innerWidth/innerHeight + 0 offset。
 * 返回值保证有限且非负。iOS 上 fixed 元素相对 layout viewport 定位，
 * offsetTop/offsetLeft 正是视觉视口在该坐标系中的偏移，可直接作为
 * fixed 元素的 top/left 使用。
 */
export function readDialogViewportRect(): DialogViewportRect {
  if (typeof window === "undefined") {
    return { top: 0, left: 0, width: 0, height: 0 };
  }
  const fallback: DialogViewportRect = {
    top: 0,
    left: 0,
    width: Number.isFinite(window.innerWidth) ? Math.max(0, window.innerWidth) : 0,
    height: Number.isFinite(window.innerHeight) ? Math.max(0, window.innerHeight) : 0,
  };
  const vv = window.visualViewport;
  if (!vv) return fallback;
  const width = Number.isFinite(vv.width) ? Math.max(0, vv.width) : 0;
  const height = Number.isFinite(vv.height) ? Math.max(0, vv.height) : 0;
  if (width <= 0 || height <= 0) return fallback;
  return {
    top: Number.isFinite(vv.offsetTop) ? Math.max(0, vv.offsetTop) : 0,
    left: Number.isFinite(vv.offsetLeft) ? Math.max(0, vv.offsetLeft) : 0,
    width,
    height,
  };
}

/**
 * 面板可用安全区：visual viewport 四边各扣 margin 像素，结果保证非负。
 * 面板 maxWidth/maxHeight 由此派生，任何视口（含软键盘、缩放）都不越界。
 */
export function getDialogSafeArea(viewport: DialogViewportRect, margin = 16): { maxWidth: number; maxHeight: number } {
  return {
    maxWidth: Math.max(0, viewport.width - margin * 2),
    maxHeight: Math.max(0, viewport.height - margin * 2),
  };
}

export interface ViewportDialogProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  /** 可选描述，固定显示在标题区下方并关联 aria-describedby */
  description?: React.ReactNode;
  /** 正文，超高时仅该区域内部滚动 */
  children?: React.ReactNode;
  /** 底部操作区，固定可达 */
  actions?: React.ReactNode;
  /** 桌面面板宽度（默认 560）；任何视口下都不会越过可视区域安全边距 */
  width?: number | string;
  /** 固定面板高度（默认按内容自适应）；同样受视口安全边距限制 */
  height?: number | string;
  zIndex?: number;
  /** 点击遮罩关闭，默认 true */
  closeOnBackdrop?: boolean;
  /** Esc 关闭，默认 true */
  closeOnEsc?: boolean;
  /** 自定义打开时的初始聚焦元素；默认聚焦面板内第一个可交互元素 */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** 标题栏右侧、关闭按钮之前的额外操作（如移动端 Back 按钮） */
  headerActions?: React.ReactNode;
  /** 正文区内边距，默认 "14px 18px"；嵌入整版布局（如 Settings）可传 "0" */
  contentPadding?: string;
  /** 关闭按钮的 aria-label，默认 "Close" */
  closeLabel?: string;
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((el) => el.getClientRects().length > 0);
}

/**
 * 视口安全的通用对话框壳：桌面居中、移动端保留安全边距，
 * 标题/操作区固定可达，只有正文内部滚动。
 *
 * 无进场动画（与 Pidance 现有弹窗一致），天然尊重 prefers-reduced-motion；
 * 颜色全部来自 globals.css 语义变量，亮暗主题自动适配。
 */
export function ViewportDialog({
  open,
  onClose,
  title,
  description,
  children,
  actions,
  width = 560,
  height,
  zIndex = 1000,
  closeOnBackdrop = true,
  closeOnEsc = true,
  initialFocusRef,
  headerActions,
  contentPadding = "14px 18px",
  closeLabel = "Close",
}: ViewportDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  // 每个打开实例一个稳定 symbol：Esc 只关顶层、嵌套恢复焦点按栈序进行。
  const instanceIdRef = useRef<symbol | null>(null);
  if (instanceIdRef.current === null) instanceIdRef.current = Symbol("ViewportDialog");

  // 打开时注册实例栈（关闭/卸载注销），供 Esc 顶层判定。
  useEffect(() => {
    if (!open) return;
    return registerDialogInstance(instanceIdRef.current!);
  }, [open]);

  // 打开时聚焦初始元素（首个可交互元素或面板本身），关闭后恢复触发元素焦点。
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement;
    const panel = panelRef.current;
    const target = pickInitialFocusTarget(
      initialFocusRef?.current,
      panel ? getFocusableElements(panel) : [],
      panel,
    );
    target?.focus({ preventScroll: true });
    return () => {
      const restore = resolveFocusRestoreTarget(
        previouslyFocused instanceof HTMLElement ? previouslyFocused : null,
        (el) => document.contains(el),
      );
      restore?.focus({ preventScroll: true });
    };
  }, [open, initialFocusRef]);

  // 打开期间锁定背景滚动：模块级引用计数，多实例/嵌套只有首个加锁、
  // 末个解锁才恢复，避免嵌套关闭顺序把背景滚动错误解锁。
  useEffect(() => {
    if (!open) return;
    return acquireDialogBodyLock(document.body);
  }, [open]);

  // document bubble 阶段由顶层对话框拦截所有 keydown，避免到达 window 全局快捷键。
  // Escape 只有在未被消费且允许关闭时才关闭；底层对话框不抢占事件。
  useEffect(() => {
    if (!open) return;
    const instanceId = instanceIdRef.current!;
    const onKeyDown = (event: KeyboardEvent) => {
      const decision = resolveDialogKeyDown({
        key: event.key,
        defaultPrevented: event.defaultPrevented,
        closeOnEsc,
        isTop: isTopDialogInstance(instanceId),
      });
      if (!decision.stopPropagation) return;
      event.stopPropagation();
      if (decision.preventDefault) event.preventDefault();
      if (decision.close) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, closeOnEsc, onClose]);

  // 焦点逃逸兜底：任何跑出面板的程序性聚焦都被拉回面板内。
  useEffect(() => {
    if (!open) return;
    const instanceId = instanceIdRef.current!;
    const onFocusIn = (event: FocusEvent) => {
      if (!isTopDialogInstance(instanceId)) return;
      const panel = panelRef.current;
      if (!panel || !(event.target instanceof Node) || panel.contains(event.target)) return;
      const focusable = getFocusableElements(panel);
      (focusable[0] ?? panel).focus({ preventScroll: true });
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [open]);

  // ── visual viewport 跟踪 ────────────────────────────────────────────────
  // 软键盘、缩放或视觉视口滚动时，backdrop 必须始终精确覆盖当前可视区域。
  const [viewportRect, setViewportRect] = useState<DialogViewportRect | null>(null);
  const viewportRafRef = useRef(0);

  const updateViewportRect = useCallback(() => {
    const next = readDialogViewportRect();
    setViewportRect((prev) => (
      prev
      && prev.top === next.top
      && prev.left === next.left
      && prev.width === next.width
      && prev.height === next.height
        ? prev
        : next
    ));
  }, []);

  useIsomorphicLayoutEffect(() => {
    if (!open) {
      setViewportRect(null);
      return;
    }
    // 打开时同步读取一次，事件经 rAF 合帧跟进。
    updateViewportRect();
    const schedule = () => {
      if (viewportRafRef.current) return;
      viewportRafRef.current = requestAnimationFrame(() => {
        viewportRafRef.current = 0;
        updateViewportRect();
      });
    };
    window.addEventListener("resize", schedule);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", schedule);
    vv?.addEventListener("scroll", schedule);
    return () => {
      window.removeEventListener("resize", schedule);
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", schedule);
      if (viewportRafRef.current) {
        cancelAnimationFrame(viewportRafRef.current);
        viewportRafRef.current = 0;
      }
    };
  }, [open, updateViewportRect]);

  if (!open || typeof document === "undefined") return null;

  // Tab 焦点约束：在面板内循环，不跑到背景（纯逻辑见 dialog-guards）。
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const trap = resolveTabTrap<HTMLElement>({
      focusable: getFocusableElements(panel),
      active: document.activeElement as HTMLElement | null,
      shiftKey: event.shiftKey,
      panel,
      contains: (el) => panel.contains(el),
    });
    if (trap.handled) {
      event.preventDefault();
      trap.target.focus({ preventScroll: true });
    }
  };

  const widthCss = typeof width === "number" ? `${width}px` : width;
  // 首帧（state 尚未同步）直接同步读取，避免软键盘下闪到错误大小。
  const viewport = viewportRect ?? readDialogViewportRect();
  // 面板最大宽高 = visual viewport 扣除四边 16px 安全边距，保证非负。
  const safeArea = getDialogSafeArea(viewport);
  // width 为数值时优先使用数值 style；字符串宽度保留原语义，用 min() 与安全上限组合。
  const panelMaxWidthCss = typeof width === "number"
    ? Math.min(width, safeArea.maxWidth)
    : `min(${widthCss}, ${safeArea.maxWidth}px)`;
  // 固定高度时同样受安全区约束：手机/小视口自动缩到可用高度，内容区内部滚动
  const panelHeightCss = height === undefined
    ? undefined
    : (typeof height === "number"
        ? Math.min(height, safeArea.maxHeight)
        : `min(${height}, ${safeArea.maxHeight}px)`);

  return createPortal(
    <div
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
      style={{
        // fixed 相对 layout viewport 定位；top/left/width/height 精确覆盖
        // 当前 visual viewport（不使用 inset，避免坐标系冲突）。
        position: "fixed",
        top: viewport.top,
        left: viewport.left,
        width: viewport.width,
        height: viewport.height,
        zIndex,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        // 阻断滚动链：触屏/触控板在遮罩上的滚动手势不传给背景页面。
        overscrollBehavior: "contain",
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        style={{
          width: "100%",
          maxWidth: panelMaxWidthCss,
          maxHeight: safeArea.maxHeight,
          ...(panelHeightCss !== undefined ? { height: panelHeightCss, minHeight: 0 } : {}),
          display: "flex",
          flexDirection: "column",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "12px 18px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}>
          <div id={titleId} style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", minWidth: 0, flex: 1 }}>
            {title}
          </div>
          {headerActions}
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: 32,
              minHeight: 32,
              padding: "2px 6px",
              background: "none",
              border: "none",
              borderRadius: 7,
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 20,
              lineHeight: 1,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--bg-hover)";
              e.currentTarget.style.color = "var(--text)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "none";
              e.currentTarget.style.color = "var(--text-muted)";
            }}
          >
            ×
          </button>
        </div>
        {description && (
          <div
            id={descriptionId}
            style={{
              padding: "10px 18px",
              borderBottom: "1px solid var(--border)",
              fontSize: 13,
              lineHeight: 1.55,
              color: "var(--text-muted)",
              flexShrink: 0,
            }}
          >
            {description}
          </div>
        )}
        {children && (
          <div style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            // 正文滚到底后不连锁滚动背景（配合打开时的 body overflow 锁定）。
            overscrollBehavior: "contain",
            padding: contentPadding,
          }}>
            {children}
          </div>
        )}
        {actions && (
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            padding: "12px 18px",
            borderTop: "1px solid var(--border)",
            flexShrink: 0,
          }}>
            {actions}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
