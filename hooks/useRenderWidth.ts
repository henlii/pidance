"use client";

import { useEffect, useRef, type RefObject } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import { measureRenderColumns } from "@/lib/render-width";

/**
 * 把「按等宽字体能放多少列」上报给服务端：插件组件按这个列数排版。
 *
 * 不这么做的话，窄视口上服务端仍按桌面宽度（100 列）渲染，超宽的行只能被
 * CSS 断行，方框/表格/选中条会错位。视口变化用 ResizeObserver 跟，只在列数
 * 真的变了才发命令（同一宽度重复上报会被服务端忽略）。
 */
export function useRenderWidth(options: {
  sessionId: string | null;
  /** 量宽度的宿主（等宽字体容器，例如消息列）。 */
  containerRef: RefObject<HTMLElement | null>;
  /** 关掉（例如只读会话）。 */
  enabled?: boolean;
}): void {
  const { sessionId, containerRef, enabled = true } = options;
  const lastSentRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    const host = containerRef.current;
    if (!host) return;

    const publish = () => {
      const columns = measureRenderColumns(host);
      if (columns === null || columns === lastSentRef.current) return;
      lastSentRef.current = columns;
      void sendAgentCommand(sessionId, { type: "set_render_width", width: columns }).catch(() => {
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
