"use client";

import { useEffect } from "react";
import { matchesExtensionShortcut, type ExtensionShortcutEntry } from "@/lib/extension-shortcuts";

/**
 * 把插件注册的快捷键（`pi.registerShortcut`）绑到 Web 的键盘上（issue #105）。
 *
 * 与 TUI 的差别（有意，且都在设置清单里可见）：
 *
 * - 只绑**能区分出意图**的键：F1–F12、Ctrl/Alt/Super + 非保留键。纯字符键与编辑键
 *   （方向键、Enter、Tab…）不绑 —— Web 上没有 pi-tui 那种同步的全局输入层，绑了就会
 *   和「用户在打字/移光标」打架。判定在 `lib/extension-shortcuts.ts` 里，与服务端给
 *   设置清单用的是同一份结论（设置里说不可用的，这里也不会绑）。
 * - 浏览器与壳自己的组合永不抢：`BROWSER_RESERVED_CTRL_KEYS` + 壳的 Ctrl/Cmd+K、
 *   Escape（见同文件）。不可绑的键**不改键**，只在清单里标原因。
 * - 插件界面（扩展对话框 / 自定义面板）显示时**不触发**：TUI 里快捷键挂在编辑器上，
 *   焦点被 overlay 拿走时同样收不到 —— 那时按键归面板自己（窗口 ③）。
 *
 * 监听放在**冒泡**阶段：壳自己的监听器先跑，它们 `preventDefault` 过的键这里直接跳过，
 * 于是「壳赢」不依赖两个监听器的注册顺序。
 */
export function useExtensionShortcuts(options: {
  shortcuts: readonly ExtensionShortcutEntry[];
  /** 会话可写、且当前没有把键盘让给别的面时才绑。 */
  enabled: boolean;
  /** 命中的键名（已归一化）交给调用方去服务端执行。 */
  onRun: (key: string) => void;
}): void {
  const { shortcuts, enabled, onRun } = options;

  useEffect(() => {
    if (!enabled) return;
    const bound = shortcuts.filter((shortcut) => shortcut.available);
    if (bound.length === 0) return;

    const handler = (event: KeyboardEvent) => {
      // 壳/面板已经处理过（preventDefault）→ 让给它们。
      if (event.defaultPrevented) return;
      const match = bound.find((shortcut) => matchesExtensionShortcut(shortcut.key, event));
      if (!match) return;
      // 命中就拦下：不拦的话浏览器可能同时执行自己的默认动作（滚动、焦点移动）。
      event.preventDefault();
      onRun(match.key);
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, onRun, shortcuts]);
}
