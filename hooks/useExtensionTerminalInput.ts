"use client";

import { useEffect } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import { shouldRouteKeyToExtensionListener } from "@/lib/extension-panel-keys";
import { toTerminalKeyData } from "@/lib/terminal-input";

/**
 * 插件把 custom 面板收起后，仍要能收到按键。
 *
 * pi-tui 的 `addInputListener`（`ctx.ui.onTerminalInput`）是全局的，Web 没有
 * 等价的同步键盘层，所以这里只覆盖一个具体缺口：**面板被插件 `setHidden(true)`
 * 收起时**，用户在页面别处按下白名单键（Escape / F1–F12 / Ctrl·Alt+非保留字符），
 * 交给服务端问插件监听器。rpiv-ask-user 的折叠键就是靠它把面板重新展开。
 *
 * 面板可见时不介入 —— 那时按键归面板自己的 keytrap（`ExtensionCustomPanel`）；
 * 没有面板时也不介入，避免给普通打字/快捷键加一次往返。
 */
export function useExtensionTerminalInput(options: {
  sessionId: string | null;
  enabled: boolean;
}): void {
  const { sessionId, enabled } = options;

  useEffect(() => {
    if (!enabled || !sessionId) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;
      if (!shouldRouteKeyToExtensionListener(event)) return;
      const data = toTerminalKeyData(event);
      if (!data) return;
      // 此刻面板已收起，按键没有别的去处：直接吞掉再问插件。
      event.preventDefault();
      event.stopPropagation();
      void sendAgentCommand(sessionId, { type: "terminal_input", data }).catch(() => {
        /* 询问失败就当作没被消费，不再重放按键 */
      });
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [enabled, sessionId]);
}
