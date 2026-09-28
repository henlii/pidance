/**
 * 手机端「屏幕按键条」（issue #113）。
 *
 * 为什么需要：插件面板（问卷/选择/审批）靠方向键与回车操作，手机软键盘产不出方向键，
 * 于是这类面板在手机上是**不可用**的 —— 桌面能用、手机不能。这不是插件的问题，
 * 是 Web 端缺一层输入。
 *
 * 设计边界（刻意保持通用）：
 * - 只发**按键序列**，不做插件专属处理，也不猜测语义（点"第 2 项"仍是 ↓ 再 Enter）；
 * - 键数据复用既有 `toTerminalKeyData`，与物理键盘走**同一套**通道：
 *   插件面板 → `extension_ui_input`（组件 handleInput）；编辑器接管 → `editor_component_input`；
 * - 只在窄视口且**确有插件界面占着键盘**时出现，桌面不出现。
 */

import { toTerminalKeyData } from "./terminal-input";

export type ExtensionKeyBarKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Enter" | "Escape";

/** 按键条上的键（顺序即显示顺序）。 */
export const EXTENSION_KEY_BAR_KEYS: readonly ExtensionKeyBarKey[] = [
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
  "Escape",
];

/** 键 → i18n key（文案在组件里取，这里只给标识）。 */
export const EXTENSION_KEY_BAR_LABEL_KEYS: Record<ExtensionKeyBarKey, string> = {
  ArrowUp: "keyBar_up",
  ArrowDown: "keyBar_down",
  ArrowLeft: "keyBar_left",
  ArrowRight: "keyBar_right",
  Enter: "keyBar_enter",
  Escape: "keyBar_escape",
};

/** 按键条上的键 → 终端序列（与物理键盘同一实现；量不出来就返回 null，不猜）。 */
export function keyBarKeyData(key: ExtensionKeyBarKey): string | null {
  return toTerminalKeyData({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
}

/** 按键该走哪条通道。 */
export type ExtensionKeyBarChannel = "editor" | "panel" | "terminal" | "none";

/**
 * 判定通道：编辑器接管 → 面板 → 其余浮层（terminal_input，与窗口 ③ 同一条）。
 *
 * 注意顺序：编辑器接管时输入框根本不渲染，面板也可能同时存在，必须先问接管。
 */
export function resolveExtensionKeyBarChannel(input: {
  hasEditorTakeover: boolean;
  hasVisibleCustomPanel: boolean;
  canRouteTerminal: boolean;
}): ExtensionKeyBarChannel {
  if (input.hasEditorTakeover) return "editor";
  if (input.hasVisibleCustomPanel) return "panel";
  if (input.canRouteTerminal) return "terminal";
  return "none";
}

/**
 * 是否显示按键条。只在窄视口显示；没有任何插件界面占键盘时**不显示**
 * （否则它会挡住输入框，且按了也没人收）。
 */
export function shouldShowExtensionKeyBar(input: {
  isMobile: boolean;
  channel: ExtensionKeyBarChannel;
}): boolean {
  return input.isMobile && input.channel !== "none";
}
