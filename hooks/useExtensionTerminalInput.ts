"use client";

import { useEffect, useRef } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import {
  IME_COMPOSITION_GRACE_MS,
  isDomOwnedKeyTarget,
  isImeComposing,
  isPlainCharacterKey,
  resolveExtensionSurfaceKeyAction,
  shouldRouteKeyToExtensionListener,
  type KeyTargetLike,
} from "@/lib/extension-panel-keys";
import { toTerminalKeyData } from "@/lib/terminal-input";

/**
 * 把按键交给插件注册的全局监听器（`ctx.ui.onTerminalInput`）。
 *
 * pi-tui 的 `addInputListener` 是全局同步的，Web 没有等价层，所以只有两种情形会路由，
 * 其余时候**一次请求都不发**（普通打字不能加往返）：
 *
 * - **窗口 ① `hiddenPanelRouting`**：插件把 custom 面板 `setHidden(true)` 收起后，
 *   白名单键（Escape / F1–F12 / Alt·Ctrl+非保留字符，见 `shouldRouteKeyToExtensionListener`）
 *   仍要能到达插件 —— rpiv-ask-user 的折叠键靠它把面板重新展开。
 * - **窗口 ③ `surfaceRouting`**：插件界面**正在显示**时（可见的 custom 面板 / overlay /
 *   扩展对话框），除了浏览器保留组合、Tab 与有 DOM 归属的键之外，按键都归插件。
 *   在此之前这种情形下按键没有归属者：面板自己可聚焦时由它的 keytrap 收（那条路不变），
 *   但焦点不在面板里（用户点了别处、或对话框那种没有 keytrap 的界面）时插件就完全收不到。
 *
 * 实际顺序（同一按键只会被一个窗口处理，矩阵见 `lib/extension-panel-keys.test.mjs`）：
 *
 * 1. **窗口 ① 先判**：面板被插件收起 → 白名单键。它**有意**排在 DOM 归属之前 —— 这条窗口的
 *    主场景就是「输入框仍然聚焦」（用户打完字、插件把面板收起来），先按焦点让位的话，
 *    rpiv-ask-user 那种「收起后靠一个键重新展开」的写法就再也收不到键。白名单本身很窄。
 * 2. **窗口 ③**：插件界面显示中 → 事件目标已有 DOM 归属者就让位。判据是**通用**的
 *    （焦点落在任何真实元素上都算，见 `isDomOwnedKeyTarget`）：只列 input/button 之类的标签
 *    必然漏掉壳自己的拖宽手柄、谱系树行、可聚焦的工具输出，那些控件聚焦后本来就用方向键做事。
 *    输入框聚焦时 keydown 的目标就是那个 textarea，所以「输入框聚焦时维持现状」也由这条覆盖；
 *    抢过来会造成一次按键两个消费者（对话框按钮的 Enter 既点按钮、又被当成插件的确认键）。
 * 3. 输入框聚焦且插件界面没显示 → 窗口 ②（`useExtensionWidgetKeys`，见 `ChatInput`）。
 *
 * 输入法：合成中（含 `keyCode === 229`）与 `compositionend` 之后的 `IME_COMPOSITION_GRACE_MS`
 * 宽限期内一律不路由，两个窗口都适用 —— 否则合成提交那一下会先被当成插件的按键吃掉。
 *
 * 焦点：两个窗口都**不带** `assertFocus`。窗口 ① 的按键常发生在输入框仍聚焦时（面板收起了），
 * 窗口 ③ 则恰恰是输入框没有焦点时；两种情况下断言「编辑器有焦点」都会让插件读到与事实相反的
 * `tui.focusedComponent`（窗口 ② 才带 `assertFocus`，因为那里输入框真的聚焦）。
 */
export function useExtensionTerminalInput(options: {
  sessionId: string | null;
  /** 窗口 ①：面板被插件收起（`hidden`）时的白名单键。 */
  hiddenPanelRouting: boolean;
  /** 窗口 ③：插件界面正在显示（可见的 custom 面板 / overlay / 扩展对话框）。 */
  surfaceRouting: boolean;
}): void {
  const { sessionId, hiddenPanelRouting, surfaceRouting } = options;
  const compositionEndAtRef = useRef(0);

  useEffect(() => {
    if (!sessionId || (!hiddenPanelRouting && !surfaceRouting)) return;

    // 合成提交那一下会先来一个 Esc/Enter：给一小段宽限期，别把它当成插件的按键。
    const onCompositionEnd = () => {
      compositionEndAtRef.current = Date.now() + IME_COMPOSITION_GRACE_MS;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // 上游（面板 keytrap 一类）已经处理过：不再重复。
      if (event.defaultPrevented) return;
      const now = Date.now();
      const composing = isImeComposing(event, compositionEndAtRef.current, now);
      if (composing) return;

      // 窗口 ①：面板收起时的白名单键（行为与「窗口 ③」引入前完全一致）。它先判是有意的：
      // 这条窗口的主场景就是「输入框仍然聚焦」，先按焦点让位的话插件再也收不到那个收缩键。
      const panelWindowClaimsTheKey = hiddenPanelRouting && shouldRouteKeyToExtensionListener(event);
      if (panelWindowClaimsTheKey) {
        const data = toTerminalKeyData(event);
        if (!data) return;
        // 此刻面板已收起，按键没有别的去处：直接吞掉再问插件。
        event.preventDefault();
        event.stopPropagation();
        void sendAgentCommand(sessionId, { type: "terminal_input", data }).catch(() => {
          /* 询问失败就当作没被消费，不再重放按键 */
        });
        return;
      }

      if (!surfaceRouting) return;
      const action = resolveExtensionSurfaceKeyAction({
        key: event.key,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        composing,
        // 归属判据是通用的「焦点落在真实元素上」：输入框、面板 keytrap、壳的拖宽手柄、
        // 谱系树行、可聚焦的工具输出都算（只认标签白名单必然漏，见 isDomOwnedKeyTarget）。
        domOwned: isDomOwnedKeyTarget(
          event.target as KeyTargetLike | null,
          document.activeElement as KeyTargetLike | null,
        ),
      });
      if (action !== "route") return;

      // `toTerminalKeyData` 只认特殊键与组合键，普通字符（插件的 `j`/`k`、数字…）返回 null，
      // 而 pi-tui 的监听器收到的就是字符本身。
      const data = toTerminalKeyData(event) ?? (isPlainCharacterKey(event) ? event.key : null);
      if (!data) return;
      // 焦点不在输入框、目标也没有 DOM 归属者：这个键就是给插件的，别再让页面同时响应
      // （方向键滚页、空格翻页之类会让插件的界面看起来在乱动）。
      event.preventDefault();
      event.stopPropagation();
      void sendAgentCommand(sessionId, { type: "terminal_input", data }).catch(() => {
        /* 询问失败就当作没被消费，不再重放按键 */
      });
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("compositionend", onCompositionEnd, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("compositionend", onCompositionEnd, true);
    };
  }, [sessionId, hiddenPanelRouting, surfaceRouting]);
}
