/**
 * Custom extension panels still speak the TUI key protocol, but GUI copy/select
 * must not be swallowed. Ctrl/Cmd+A always stays with the browser; Ctrl/Cmd+C
 * stays with the browser when there is a text selection (otherwise it remains
 * the TUI interrupt, usually Close).
 */
export function shouldCaptureCustomPanelKey(
  event: { key: string; ctrlKey: boolean; metaKey: boolean },
  selectedText: string,
): boolean {
  const key = event.key.toLowerCase();
  const chord = event.ctrlKey || event.metaKey;
  if (!chord) return true;
  if (key === "a") return false;
  if (key === "c" && selectedText.length > 0) return false;
  return true;
}

/** 浏览器自身保留的 Ctrl 组合：不问插件，直接交给浏览器。 */
const BROWSER_RESERVED_CTRL_KEYS = new Set([
  "a", "c", "v", "x", "z", "y", "p", "s", "f", "n", "t", "w", "r", "l", "o",
]);

/**
 * 插件把 custom 面板收起后，哪些按键要拿去问它的全局监听器
 * （`ctx.ui.onTerminalInput`；如 rpiv-ask-user 的折叠键用来重新展开）。
 *
 * 只放不与输入框/浏览器冲突的键：Escape、F1–F12、Ctrl/Alt + 非保留字符键。
 * 方向键与 Home/End/PageUp/PageDown 留给输入框和滚动，Enter/Tab 留给正常输入 ——
 * Web 没有 pi-tui 那种同步的全局输入层，拿不准的键宁可不去碰。
 */
export function shouldRouteKeyToExtensionListener(event: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): boolean {
  if (event.metaKey) return false;
  if (event.key === "Escape") return true;
  if (/^F([1-9]|1[0-2])$/.test(event.key)) return true;
  // Alt 组合不是浏览器快捷键（除了 Alt+字符的菜单访问键，浏览器不占用）
  if (event.altKey) return event.key.length === 1;
  if (!event.ctrlKey) return false;
  if (event.key.length !== 1) return false;
  // Ctrl+空格 是输入法切换，也留给浏览器
  if (event.key === " ") return false;
  return !BROWSER_RESERVED_CTRL_KEYS.has(event.key.toLowerCase());
}

