"use client";

import { useEffect, useRef } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import {
  IME_COMPOSITION_GRACE_MS,
  initialState,
  isImeComposing,
  isPlainCharacterKey,
  isWidgetInteractionLive,
  nextWidgetInteractionState,
  resolveExtensionWidgetKeyAction,
  type WidgetInteractionState,
} from "@/lib/extension-panel-keys";
import { toTerminalKeyData } from "@/lib/terminal-input";

/** 每个标签页一个客户端 id：服务端按它做「任一标签聚焦即聚焦」的聚合。 */
function createClientId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  return `client-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

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
 * 本地选择态是**推断**出来的，所以有三道复位：`Esc`/`Enter`（插件的离开/提交键）无条件清零、
 * 非导航键清零、超过 `WIDGET_INTERACTION_TTL_MS` 没有路由过按键也算离开。宁可少路由，
 * 也不能把用户的字母键吞掉。
 *
 * 焦点由这里一并上报：服务端把它投影成 `tui.focusedComponent`（鸭子类型探针），
 * 插件据此判断「主编辑器有焦点」。上报带本标签的 clientId（多标签聚合），
 * 切后台、失焦、切会话、卸载都会如实告知，避免插件停在一个已经离开的编辑器的选择态里。
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
  const clientIdRef = useRef("");
  if (clientIdRef.current === "") clientIdRef.current = createClientId();
  const interactionRef = useRef<WidgetInteractionState>(initialState());
  const compositionEndAtRef = useRef(0);
  const lastReportedFocusRef = useRef<boolean | null>(null);
  // 监听器按 [enabled, sessionId] 重建，门槛值走 ref，避免每次输入都重挂监听。
  const gateRef = useRef({ focused: composerFocused, empty: composerEmpty });
  gateRef.current = { focused: composerFocused, empty: composerEmpty };

  // 门槛成立（空且聚焦）才可能处于选择态；任一不成立立刻退出。
  useEffect(() => {
    if (enabled && composerFocused && composerEmpty) return;
    interactionRef.current = initialState();
  }, [enabled, composerFocused, composerEmpty, sessionId]);

  // 焦点上报：聚焦/失焦、切后台/回前台、切会话、卸载。
  useEffect(() => {
    if (!sessionId) return;
    const report = (focused: boolean) => {
      if (lastReportedFocusRef.current === focused) return;
      lastReportedFocusRef.current = focused;
      void sendAgentCommand(sessionId, {
        type: "editor_focus",
        focused,
        clientId: clientIdRef.current,
      }).catch(() => {
        /* 上报失败不影响输入 */
      });
    };
    const reportCurrent = () => {
      const focused = gateRef.current.focused && document.visibilityState === "visible";
      // 切到后台等于离开输入区：本地选择态一并复位（手机锁屏/切后台）。
      if (!focused) interactionRef.current = initialState();
      report(focused);
    };
    // 换会话/换聚焦状态都要重新如实上报一次（上个会话的状态不能继承）。
    lastReportedFocusRef.current = null;
    reportCurrent();
    document.addEventListener("visibilitychange", reportCurrent);
    window.addEventListener("pagehide", reportCurrent);
    window.addEventListener("focus", reportCurrent);
    return () => {
      document.removeEventListener("visibilitychange", reportCurrent);
      window.removeEventListener("pagehide", reportCurrent);
      window.removeEventListener("focus", reportCurrent);
      interactionRef.current = initialState();
      report(false);
    };
  }, [sessionId, composerFocused]);

  useEffect(() => {
    if (!enabled || !sessionId) {
      interactionRef.current = initialState();
      return;
    }

    // 合成提交那一下会先来一个 Esc/Enter：给一小段宽限期，别当成导航键拦下。
    const onCompositionEnd = () => {
      compositionEndAtRef.current = Date.now() + IME_COMPOSITION_GRACE_MS;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const now = Date.now();
      const action = resolveExtensionWidgetKeyAction({
        key: event.key,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        // 上游已处理 / 输入法合成中（含 keyCode 229） / 合成刚结束的宽限期：都不参与。
        composing: event.defaultPrevented || isImeComposing(event, compositionEndAtRef.current, now),
        interactive: isWidgetInteractionLive(interactionRef.current, now),
      });
      if (action === "ignore") return;
      if (action === "exit-interaction") {
        interactionRef.current = nextWidgetInteractionState(interactionRef.current, {
          action,
          key: event.key,
          consumed: false,
          now,
        });
        return;
      }
      // 插件的激活条件就是「编辑器为空」：不满足时连问都不问。
      if (!gateRef.current.focused || !gateRef.current.empty) {
        interactionRef.current = initialState();
        return;
      }
      const data = toTerminalKeyData(event) ?? (isPlainCharacterKey(event) ? event.key : null);
      if (!data) return;
      if (action === "route-navigation") {
        // 这些键在输入框里会动光标/换行，必须先拦下来再问插件；未被消费就当作没发生。
        event.preventDefault();
        event.stopPropagation();
      }
      // 焦点与按键放在**同一条命令**里：服务端先刷新焦点再交给插件。拆成两条 HTTP
      // 会乱序（焦点还没到、按键先被处理），表现为冷启动/焦点过期后第一次 `↓` 不激活。
      void sendAgentCommand<{ consumed?: boolean }>(sessionId, {
        type: "terminal_input",
        data,
        assertFocus: true,
        clientId: clientIdRef.current,
      })
        .then((result) => {
          interactionRef.current = nextWidgetInteractionState(interactionRef.current, {
            action,
            key: event.key,
            consumed: result?.consumed === true,
            now: Date.now(),
          });
        })
        .catch(() => {
          interactionRef.current = initialState();
        });
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("compositionend", onCompositionEnd, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("compositionend", onCompositionEnd, true);
    };
  }, [enabled, sessionId]);
}
