"use client";

import { useEffect, useRef, type RefObject } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import { measureRenderColumns, measureRenderRows } from "@/lib/render-width";

/**
 * 把「按等宽字体能放多少列 / 多少行」上报给服务端：插件组件按这个尺寸排版与裁切。
 *
 * 不这么做的话，窄视口上服务端仍按桌面宽度（100 列）渲染，超宽的行只能被
 * CSS 断行，方框/表格/选中条会错位；高度同理 —— `tui.terminal.rows` 是 40 的
 * 常量时，按它裁详情视口的插件（pi-subagents 的 fleet 详情）会把本可以显示的行
 * 裁掉，而裁掉的行根本不在输出里。视口变化用 ResizeObserver 跟，只在需要时才发命令。
 */

/** 行数的稳定带：与上次**上报值**相差不超过它就不重发。 */
export const RENDER_ROWS_STABLE_BAND = 1;

/** 上报失败后的重试间隔（不设无限重试：宿主可能确实不在了）。 */
export const RENDER_SIZE_RETRY_MS = 2_000;
export const RENDER_SIZE_MAX_RETRIES = 3;

/** 宿主还没挂载时的重试（覆盖「先出加载态、后挂滚动区」的挂载顺序）。 */
const ATTACH_RETRY_MS = 250;
const ATTACH_MAX_ATTEMPTS = 40;

/** 一次上报的内容：尺寸必须带上会话 id —— 同一块像素尺寸可能属于不同会话。 */
export interface RenderSizeReport {
  sessionId: string;
  width: number;
  rows: number;
}

/**
 * 这次测量该不该上报。
 *
 * - 没报过 → 报；
 * - **换了会话** → 报：新 host 的 columns/rows 还是默认值，而滚动区的像素尺寸在两棵
 *   会话之间通常一样，只比尺寸会把它整条漏掉（issue #70 审查发现的缺口）；
 * - 宽度变了 → 报（插件按列排版，列错了方框/表格就错位）；
 * - 行数变化在稳定带内 → 不报：按 rows 裁切的插件会让自己的行数随 rows 变，
 *   高度贴着 maxHeight 时容易形成 1 行幅度的往复。比较的是**上次上报值**，
 *   所以连续的小变化会累积到超过带宽再报，不是把变化丢掉。
 */
export function shouldReportRenderSize(
  previous: RenderSizeReport | null,
  next: RenderSizeReport,
): boolean {
  if (!previous) return true;
  if (previous.sessionId !== next.sessionId) return true;
  if (previous.width !== next.width) return true;
  return Math.abs(previous.rows - next.rows) > RENDER_ROWS_STABLE_BAND;
}

export function useRenderSize(options: {
  sessionId: string | null;
  /** 量尺寸的宿主（等宽字体容器，例如消息滚动区）。 */
  containerRef: RefObject<HTMLElement | null>;
  /** 关掉（例如只读会话）。 */
  enabled?: boolean;
}): void {
  const { sessionId, containerRef, enabled = true } = options;
  const lastSentRef = useRef<RenderSizeReport | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    // 换会话就作废上次记录：像素尺寸相同也要让新 host 拿到真实尺寸
    // （见 shouldReportRenderSize 的注释）。
    lastSentRef.current = null;
    let disposed = false;
    let attachAttempts = 0;
    let retries = 0;
    let attachTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let observer: ResizeObserver | null = null;
    let observedHost: HTMLElement | null = null;

    const publish = (host: HTMLElement) => {
      const width = measureRenderColumns(host);
      const rows = measureRenderRows(host);
      // 两个维度必须一起报：只报其中一个会让服务端的一半是真实值、另一半是默认值。
      // 任一量不出（未布局 / 字体探针量不到）就等下一次测量，不报半份尺寸。
      if (width === null || rows === null) return;
      const next = { sessionId, width, rows };
      if (!shouldReportRenderSize(lastSentRef.current, next)) return;
      lastSentRef.current = next;
      void sendAgentCommand(sessionId, { type: "set_render_size", width, rows }).catch(() => {
        // 上报失败：作废记录并**主动重试**（尺寸不变时不会有下一次 resize，
        // 干等就永远不会补上）。次数用尽后退回「等下一次 resize」。
        lastSentRef.current = null;
        if (disposed || retries >= RENDER_SIZE_MAX_RETRIES) return;
        retries += 1;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          const current = containerRef.current;
          if (!disposed && current) publish(current);
        }, RENDER_SIZE_RETRY_MS);
      });
    };

    /**
     * 挂载测量：宿主可能还没渲染出来（会话先出加载态、后挂滚动区），
     * 那时 effect 不会自己再跑一遍，所以要有界重试到宿主出现为止。
     * 已经观察到同一个宿主时不重复挂。
     */
    function attach() {
      if (disposed) return;
      const host = containerRef.current;
      if (!host) {
        if (attachAttempts >= ATTACH_MAX_ATTEMPTS) return;
        attachAttempts += 1;
        attachTimer = setTimeout(() => {
          attachTimer = null;
          attach();
        }, ATTACH_RETRY_MS);
        return;
      }
      if (observedHost === host) return;
      observer?.disconnect();
      observedHost = host;
      publish(host);
      observer = new ResizeObserver(() => publish(host));
      observer.observe(host);
    }

    attach();
    return () => {
      disposed = true;
      if (attachTimer) clearTimeout(attachTimer);
      if (retryTimer) clearTimeout(retryTimer);
      observer?.disconnect();
      observer = null;
      observedHost = null;
    };
  }, [containerRef, enabled, sessionId]);
}
