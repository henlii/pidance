"use client";

import { useEffect, useRef } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import { isPlainCharacterKey, resolveExtensionWidgetKeyAction } from "@/lib/extension-panel-keys";
import { toTerminalKeyData } from "@/lib/terminal-input";

/**
 * 让插件 widget 的按键交互在 Web 上成立（`ctx.ui.onTerminalInput` 的窄口子）。
 *
 * pi-tui 里插件能收到每一个按键并决定是否 `consume`；Web 没有同步键盘层，
 * 「每个键都往返一次」会给普通打字加延迟（这是此前有意不开全局按键路由的理由）。
 * 这里只开一条窄口子，前提是**输入框为空且聚焦**（插件自己的激活条件也是空文本）：
 *
 * 1. 未进入选择态：只把 `↓`/`←` 拿去问插件，且**不拦截**这个键 —— 空输入框里
 *    这两个键本来没有可见行为，插件没消费也不吃亏。
 * 2. 插件消费了 → 进入「选择态」，此后只路由导航键（方向键、`j`/`k`、`Enter`、`Esc`），
 *    这些键会拦下来（它们在输入框里会动光标/换行）。
 * 3. 任何其它按键立刻退出选择态，按键原样留给输入框；普通打字路径一次请求都不发。
 *
 * 焦点由这里一并上报：服务端把它投影成 `tui.focusedComponent`（鸭子类型探针），
 * 插件据此判断「主编辑器有焦点」。切后台、失焦、切会话都会如实告知，避免插件
 * 停在一个已经离开的编辑器的选择态里。
 */
export function useExtensionWidgetKeys(options: {
  sessionId: string | null;
  /**
   * 只在「没有 custom 面板、该会话存在 widget、且有插件注册了全局按键监听」时为真。
   * custom 面板存在时按键归面板自己的 keytrap（面板收起那条路径另有
   * `useExtensionTerminalInput` 负责），两边不重叠。
   */
  enabled: boolean;
  composerEmpty: boolean;
  composerFocused: boolean;
}): void {
  const { sessionId, enabled, composerEmpty, composerFocused } = options;
  const interactiveRef = useRef(false);
  const lastFocusAssertRef = useRef(0);
  const lastReportedFocusRef = useRef<boolean | null>(false);
  // 监听器按 [enabled, sessionId] 重建，门槛值走 ref，避免每次输入都重挂监听。
  const gateRef = useRef({ focused: composerFocused, empty: composerEmpty });
  gateRef.current = { focused: composerFocused, empty: composerEmpty };

  /** 路由按键前补一次焦点上报：服务端焦点有 TTL，否则长时间聚焦后会激活失败。 */
  const assertFocus = (sid: string) => {
    const now = Date.now();
    if (now - lastFocusAssertRef.current < 10_000) return;
    lastFocusAssertRef.current = now;
    void sendAgentCommand(sid, { type: "editor_focus", focused: true }).catch(() => {
      /* 上报失败不影响按键本身 */
    });
  };

  // 门槛成立（空且聚焦）才可能处于选择态；任一不成立立刻退出。
  useEffect(() => {
    if (enabled && composerFocused && composerEmpty) return;
    interactiveRef.current = false;
  }, [enabled, composerFocused, composerEmpty, sessionId]);

  // 焦点上报：聚焦/失焦、切后台/回前台、切会话、卸载。
  useEffect(() => {
    if (!sessionId) return;
    const report = (focused: boolean) => {
      if (lastReportedFocusRef.current === focused) return;
      lastReportedFocusRef.current = focused;
      void sendAgentCommand(sessionId, { type: "editor_focus", focused }).catch(() => {});
    };
    const reportCurrent = () => {
      report(gateRef.current.focused && document.visibilityState === "visible");
    };
    reportCurrent();
    document.addEventListener("visibilitychange", reportCurrent);
    window.addEventListener("pagehide", reportCurrent);
    window.addEventListener("focus", reportCurrent);
    return () => {
      document.removeEventListener("visibilitychange", reportCurrent);
      window.removeEventListener("pagehide", reportCurrent);
      window.removeEventListener("focus", reportCurrent);
      lastFocusAssertRef.current = 0;
      report(false);
    };
  }, [sessionId, composerFocused]);

  useEffect(() => {
    if (!enabled || !sessionId) {
      interactiveRef.current = false;
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const action = resolveExtensionWidgetKeyAction({
        key: event.key,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        composing: event.isComposing || event.defaultPrevented,
        interactive: interactiveRef.current,
      });
      if (action === "ignore") return;
      if (action === "exit-interaction") {
        interactiveRef.current = false;
        return;
      }
      // 插件的激活条件就是「编辑器为空」：不满足时连问都不问。
      if (!gateRef.current.focused || !gateRef.current.empty) {
        interactiveRef.current = false;
        return;
      }
      const data = toTerminalKeyData(event) ?? (isPlainCharacterKey(event) ? event.key : null);
      if (!data) return;
      if (action === "route-navigation") {
        // 这些键在输入框里会动光标/换行，必须先拦下来再问插件；未被消费就当作没发生。
        event.preventDefault();
        event.stopPropagation();
      }
      assertFocus(sessionId);
      void sendAgentCommand<{ consumed?: boolean }>(sessionId, { type: "terminal_input", data })
        .then((result) => {
          const consumed = result?.consumed === true;
          if (action === "route-activation") interactiveRef.current = consumed;
          else if (!consumed) interactiveRef.current = false;
        })
        .catch(() => {
          interactiveRef.current = false;
        });
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [enabled, sessionId]);
}
