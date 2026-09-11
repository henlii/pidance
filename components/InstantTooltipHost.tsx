"use client";

/**
 * 全局 fixed 层 tooltip：避免 overflow:hidden / transform 裁切 CSS ::after。
 * 监听 [data-tooltip] 的 hover/focus，视口内夹紧并上下翻转。
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

type TipState = {
  text: string;
  left: number;
  top: number;
  placement: "up" | "down";
};

function findTooltipEl(target: EventTarget | null): HTMLElement | null {
  let el = target as HTMLElement | null;
  while (el && el !== document.body) {
    if (el instanceof HTMLElement && el.hasAttribute("data-tooltip")) {
      const text = el.getAttribute("data-tooltip");
      if (text && text.trim()) return el;
    }
    el = el.parentElement;
  }
  return null;
}

function placeTip(anchor: DOMRect, tipW: number, tipH: number): Omit<TipState, "text"> {
  const gap = 6;
  const pad = 8;
  let placement: "up" | "down" = "down";
  let top = anchor.bottom + gap;
  if (top + tipH > window.innerHeight - pad && anchor.top - gap - tipH >= pad) {
    placement = "up";
    top = anchor.top - gap - tipH;
  }
  top = Math.max(pad, Math.min(top, window.innerHeight - tipH - pad));
  let left = anchor.left + anchor.width / 2 - tipW / 2;
  left = Math.max(pad, Math.min(left, window.innerWidth - tipW - pad));
  return { left, top, placement };
}

export function InstantTooltipHost() {
  const [tip, setTip] = useState<TipState | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    let activeEl: HTMLElement | null = null;
    let measureEl: HTMLDivElement | null = null;

    const hide = () => {
      activeEl = null;
      setTip(null);
    };

    const show = (el: HTMLElement) => {
      const text = el.getAttribute("data-tooltip")?.trim();
      if (!text) {
        hide();
        return;
      }
      activeEl = el;
      const rect = el.getBoundingClientRect();
      // 离屏测量宽高
      if (!measureEl) {
        measureEl = document.createElement("div");
        measureEl.setAttribute("aria-hidden", "true");
        measureEl.style.cssText =
          "position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none;max-width:min(280px,calc(100vw - 16px));padding:5px 8px;font-size:11px;font-weight:400;line-height:1.35;white-space:pre-line;overflow-wrap:anywhere;word-break:break-word;border:1px solid transparent;box-sizing:border-box;";
        document.body.appendChild(measureEl);
      }
      measureEl.textContent = text;
      const tipW = Math.ceil(measureEl.getBoundingClientRect().width) || 80;
      const tipH = Math.ceil(measureEl.getBoundingClientRect().height) || 28;
      const pos = placeTip(rect, tipW, tipH);
      setTip({ text, ...pos });
    };

    const onMove = (event: Event) => {
      const el = findTooltipEl(event.target);
      if (!el) {
        if (activeEl) hide();
        return;
      }
      if (el !== activeEl) show(el);
    };

    const onScrollOrResize = () => {
      if (activeEl && document.contains(activeEl)) show(activeEl);
      else hide();
    };

    // pointer 设备：mouseover 冒泡覆盖子节点；键盘：focusin
    // 具名处理器：cleanup 必须能原样移除（匿名监听会残留，重复挂载后越积越多）。
    const onPointerOut = (e: Event) => {
      const related = (e as MouseEvent).relatedTarget as Node | null;
      if (activeEl && related && activeEl.contains(related)) return;
      if (activeEl && !findTooltipEl(related)) hide();
    };
    const onFocusOut = (e: Event) => {
      const related = (e as FocusEvent).relatedTarget as Node | null;
      if (activeEl && related && findTooltipEl(related)) return;
      hide();
    };
    document.addEventListener("mouseover", onMove, true);
    document.addEventListener("focusin", onMove, true);
    document.addEventListener("mouseout", onPointerOut, true);
    document.addEventListener("focusout", onFocusOut, true);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);

    // data-tooltip 是活值（顶栏统计随运行更新）：悬停期间属性变化要重读，
    // 否则气泡停在打开那一刻的旧文案。
    const observer = new MutationObserver((mutations) => {
      if (!activeEl || !document.contains(activeEl)) return;
      if (mutations.some((mutation) => mutation.target === activeEl)) show(activeEl);
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ["data-tooltip"], subtree: true });

    return () => {
      observer.disconnect();
      document.removeEventListener("mouseover", onMove, true);
      document.removeEventListener("focusin", onMove, true);
      document.removeEventListener("mouseout", onPointerOut, true);
      document.removeEventListener("focusout", onFocusOut, true);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
      measureEl?.remove();
    };
  }, [mounted]);

  if (!mounted || !tip) return null;

  return createPortal(
    <div
      role="tooltip"
      className="instant-tooltip-layer"
      style={{
        position: "fixed",
        left: tip.left,
        top: tip.top,
        zIndex: 10050,
        maxWidth: "min(280px, calc(100vw - 16px))",
        padding: "5px 8px",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius-sm)",
        background: "var(--bg-elevated)",
        color: "var(--text)",
        boxShadow: "var(--shadow-float)",
        fontSize: 11,
        fontWeight: 400,
        lineHeight: 1.35,
        whiteSpace: "pre-line",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
        pointerEvents: "none",
        // 与测量层一致，避免长文案撑破气泡
      }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}

