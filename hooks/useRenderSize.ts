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
 * 裁掉，而裁掉的行根本不在输出里。视口变化用 ResizeObserver 跟，只在尺寸真的
 * 变了才发命令（同尺寸重复上报会被服务端忽略）。
 */
export function useRenderSize(options: {
  sessionId: string | null;
  /** 量尺寸的宿主（等宽字体容器，例如消息滚动区）。 */
  containerRef: RefObject<HTMLElement | null>;
  /** 关掉（例如只读会话）。 */
  enabled?: boolean;
}): void {
  const { sessionId, containerRef, enabled = true } = options;
  const lastSentRef = useRef<{ width: number; rows: number } | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    const host = containerRef.current;
    if (!host) return;

    const publish = () => {
      const width = measureRenderColumns(host);
      const rows = measureRenderRows(host);
      // 两个维度必须一起报：只报其中一个会让服务端的一半是真实值、另一半是默认值
      if (width === null || rows === null) return;
      const last = lastSentRef.current;
      if (last && last.width === width && last.rows === rows) return;
      lastSentRef.current = { width, rows };
      void sendAgentCommand(sessionId, { type: "set_render_size", width, rows }).catch(() => {
        // 上报失败不回退本地状态：下一次 resize 会再试
        lastSentRef.current = null;
      });
    };

    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(host);
    return () => observer.disconnect();
  }, [containerRef, enabled, sessionId]);
}
