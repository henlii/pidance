/**
 * 扩展快捷键（`pi.registerShortcut`）在 Web 上的**可用性判定**与**按键匹配**。
 *
 * 纯逻辑、不 import SDK、可直接单测：宿主与服务端都必须得出同一份结论，否则
 * 设置里说「可用」的键在页面上按了没反应。
 *
 * 三种「不可用」的理由（都是**可见降级**：设置里列出来并写明原因，不静默丢弃，
 * 也**不自动改键** —— 改键会让用户按 TUI 文档上的键却触发别的东西）：
 *
 * - `browser-reserved`：浏览器自己要用（Ctrl/Cmd + 字母表、Ctrl+Space、Alt+左右/Home）；
 * - `shell-reserved`：Pidance 壳自己要用（Ctrl/Cmd+K 命令面板、Escape 中止运行）；
 * - `typing-conflict`：纯字符键与编辑/滚动键（方向键、Enter、Tab、Home/End、PageUp/Down…）。
 *   Web 上没有 pi-tui 那种同步的全局输入层，分不清「用户在打字」和「插件想在打字时收键」；
 *   TUI 里这类键也是编辑器先收，插件拿到的是编辑器处理后的结果。
 *
 * 表本身只应该有一份：`BROWSER_RESERVED_CTRL_KEYS` / `SHELL_RESERVED_CTRL_KEYS` 直接复用
 * `lib/extension-panel-keys.ts` 的既有常量（复制一份必然漂移）。
 */
import { BROWSER_RESERVED_CTRL_KEYS, SHELL_RESERVED_CTRL_KEYS } from "./extension-panel-keys";

export type ShortcutUnavailableReason = "browser-reserved" | "shell-reserved" | "typing-conflict";

export interface ShortcutAvailability {
  available: boolean;
  reason?: ShortcutUnavailableReason;
}

const MODIFIERS = ["ctrl", "alt", "shift", "super"] as const;

/**
 * 浏览器级的 Ctrl/Cmd 组合（**绑定时**用，比 `BROWSER_RESERVED_CTRL_KEYS` 更宽）。
 *
 * 为什么另开一张而不是扩共享表：共享表那条路是「面板收起时/插件界面显示中要不要把按键
 * 拿去问插件」，口径是「拿不准的键宁可不去碰」；而**绑定全局快捷键**的后果更重 ——
 * 插件会长期占住一个用户每天要用的浏览器组合。所以这里把各主流浏览器真正占用的字母都算上：
 * 书签栏(b)/书签(d)/搜索(e)/历史(h)/开发者工具(i)/下载(j)/退出或关闭(q)/查看源码(u)/
 * 查找与打印等原来的那张表(f/p/s 等)。
 *
 * 代价是「插件绑了这些键 → 设置里列成不可用」，属于**可见降级**，比默默抢走用户的浏览器键好。
 */
export const SHORTCUT_RESERVED_BROWSER_CTRL_KEYS: ReadonlySet<string> = new Set([
  ...BROWSER_RESERVED_CTRL_KEYS,
  "b", "d", "e", "g", "h", "i", "j", "q", "u", "m",
]);
const FUNCTION_KEY_PATTERN = /^f([1-9]|1[0-2])$/;

/**
 * 编辑/滚动键：Web 上**无论加什么修饰符**都不给插件（TUI 里这些键也归编辑器）。
 *
 * 为什么带修饰符也算：Enter 是发送键、方向键是移动/滚动键，Ctrl+Enter / Alt+Enter /
 * Ctrl+方向 在输入框里都是同一类动作（发送、按词移动、跳到首尾）。绑上去会与打字和
 * 光标操作互相打架，而浏览器里没有 pi-tui 那种「编辑器先收、再决定要不要给插件」的分层。
 * Escape 单列（`shell-reserved`，它另有中止运行的语义）。
 */
const EDITING_KEYS: ReadonlySet<string> = new Set([
  "enter", "tab", "space", "backspace", "delete", "insert", "clear",
  "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
]);

/** Alt + 这些键是浏览器的前进/后退/主页（`hasAlt` 分支里判）。 */
const BROWSER_RESERVED_ALT_KEYS: ReadonlySet<string> = new Set(["left", "right", "home"]);

/**
 * 归一化一个 pi 键 id：小写、修饰符按固定顺序排列。
 *
 * 顺序必须固定，否则 `ctrl+shift+p` 与 `shift+ctrl+p` 会被当成两个键。pi 的
 * `parseKeyId` 用的是 `parts.includes`，本身不在意顺序，但我们的匹配是**字符串相等**，
 * 所以两边都要过这一道。
 *
 * 认不出（非字符串、带未知修饰符 `ctrl+super+alt+foo` 之类）返回 null —— 调用方据此
 * 判「不可用」，不要猜。
 */
export function normalizeShortcutKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const parts = raw
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const base = parts[parts.length - 1];
  if (!base) return null;
  // `ctrl+` 这种只有修饰符的串会被 split 成 `["ctrl"]`：那不是一个键，别把它当成键名。
  if ((MODIFIERS as readonly string[]).includes(base)) return null;
  const modifiers = parts.slice(0, -1);
  if (modifiers.some((modifier) => !(MODIFIERS as readonly string[]).includes(modifier))) return null;
  // 重复修饰符（`ctrl+ctrl+a`）没有意义：归一化时去重而不是保留两次。
  const ordered = MODIFIERS.filter((modifier) => modifiers.includes(modifier));
  return [...ordered, base].join("+");
}

/**
 * 这个键在 Web 上能不能绑（见文件头三种理由）。
 * 认不出的键也判不可用：与其绑一个永远匹配不上任何事件的字符串，不如如实列出。
 */
export function shortcutAvailability(raw: string): ShortcutAvailability {
  const key = normalizeShortcutKey(raw);
  if (!key) return { available: false, reason: "typing-conflict" };
  const parts = key.split("+");
  const base = parts[parts.length - 1];
  const hasCtrl = parts.includes("ctrl");
  const hasAlt = parts.includes("alt");
  const hasSuper = parts.includes("super");

  // 浏览器：Ctrl/Cmd + 字母表、Ctrl+Space；Alt + 左右/Home；Alt + 单个字母（浏览器菜单栏）。
  // 字母表要求**不带 Alt**：Ctrl+Alt+<字母> 不是浏览器快捷键（AltGr 在 Windows/Linux 上是
  // 「打字符」，浏览器不会拿它做全局动作）。Ctrl+Space 不设这个例外 —— 它是输入法切换。
  if ((hasCtrl || hasSuper) && ((!hasAlt && SHORTCUT_RESERVED_BROWSER_CTRL_KEYS.has(base)) || base === "space")) {
    return { available: false, reason: "browser-reserved" };
  }
  if (hasAlt && BROWSER_RESERVED_ALT_KEYS.has(base)) {
    return { available: false, reason: "browser-reserved" };
  }
  // Alt+<单个字母>：Firefox 用它激活菜单栏、Chrome 认其中一部分（Alt+E 菜单、Alt+F 文件…），
  // 平台差异大。绑上去会出现「有时开浏览器菜单、有时触发插件」，所以整类判保留。
  if (hasAlt && !hasCtrl && !hasSuper && base.length === 1 && base >= "a" && base <= "z") {
    return { available: false, reason: "browser-reserved" };
  }
  // 壳自己：Ctrl/Cmd + K（命令面板）；Escape（中止运行，输入框里还有菜单语义）。
  if ((hasCtrl || hasSuper) && SHELL_RESERVED_CTRL_KEYS.has(base)) {
    return { available: false, reason: "shell-reserved" };
  }
  if (base === "escape" || base === "esc") return { available: false, reason: "shell-reserved" };
  // 壳的快捷键有**两层**保护，这里只是静态的一层：
  // - 静态（本函数）：壳无论什么状态都该占住的键（命令面板 Ctrl/Cmd+K、Escape）。
  // - 动态（客户端）：`hooks/useExtensionShortcuts.ts` 在**冒泡**阶段监听，壳的处理器先跑；
  //   壳处理过的键会 `preventDefault`，那里直接跳过 —— 例如 Ctrl+Alt+N（新建会话，
  //   `hooks/useKeyboardShortcuts.ts`）只在有活动项目时才处理，没项目时让插件用它并无害。
  // 所以下面的表**不需要**把壳的每个快捷键都列全，列全反而会在壳不处理时白白挡掉插件。

  if (FUNCTION_KEY_PATTERN.test(base)) return { available: true };
  // 编辑/滚动键：加什么修饰符都不给插件（见 EDITING_KEYS）。
  if (EDITING_KEYS.has(base)) return { available: false, reason: "typing-conflict" };
  if (hasCtrl || hasAlt || hasSuper) return { available: true };
  // 其余：可打印字符（见文件头）。
  return { available: false, reason: "typing-conflict" };
}

/** 浏览器键盘事件里 `key` 的具名值 → pi 的键名。 */
const NAMED_FROM_EVENT: Record<string, string> = {
  escape: "escape",
  esc: "escape",
  enter: "enter",
  tab: "tab",
  " ": "space",
  spacebar: "space",
  backspace: "backspace",
  delete: "delete",
  del: "delete",
  insert: "insert",
  home: "home",
  end: "end",
  pageup: "pageup",
  pagedown: "pagedown",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  clear: "clear",
};

/**
 * Shift 后字符变成符号的数字键反查（US 布局）。
 *
 * 不这么做的话插件绑的 `ctrl+shift+1` 在浏览器里是 `ctrl+shift+!`，永远匹配不上。
 * 只覆盖数字行：字母的 shift 结果就是大写（`toLowerCase` 已经还原）。
 */
const SHIFTED_DIGITS: Record<string, string> = {
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5",
  "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
};

/**
 * 浏览器事件 → pi 键 id（与 `normalizeShortcutKey` 同一种形状，可直接比较）。
 *
 * 认不出的事件（Dead、Process、Unidentified、未知具名键）返回 null：宁可这次不匹配，
 * 也不要把一个猜出来的键送去插件。
 */
export function keyIdFromKeyboardEvent(event: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string | null {
  const raw = typeof event.key === "string" ? event.key : "";
  if (raw.length === 0) return null;
  let base: string | null = null;
  if (raw.length === 1) {
    base = raw.toLowerCase();
    if (event.shiftKey && SHIFTED_DIGITS[raw]) base = SHIFTED_DIGITS[raw];
  } else {
    const lower = raw.toLowerCase();
    base = NAMED_FROM_EVENT[lower] ?? (FUNCTION_KEY_PATTERN.test(lower) ? lower : null);
  }
  if (!base) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("ctrl");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  if (event.metaKey) parts.push("super");
  parts.push(base);
  return parts.join("+");
}

/** 这一次键盘事件是不是这个扩展快捷键（两边都归一化后相等）。 */
export function matchesExtensionShortcut(
  key: string,
  event: { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean },
): boolean {
  const normalized = normalizeShortcutKey(key);
  if (!normalized) return false;
  const fromEvent = keyIdFromKeyboardEvent(event);
  return fromEvent !== null && fromEvent === normalized;
}

/** 给界面看的键位文案（`ctrl+alt+n` → `Ctrl+Alt+N`）。不用 pi 的 keyText：客户端不 import SDK。 */
export function formatShortcutKey(raw: string): string {
  const normalized = normalizeShortcutKey(raw);
  if (!normalized) return raw;
  return normalized
    .split("+")
    .map((part) => (part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("+");
}

export interface ResolvedExtensionShortcut {
  key: string;
  description?: string;
  extensionPath: string;
}

export interface ExtensionShortcutEntry extends ResolvedExtensionShortcut {
  available: boolean;
  reason?: ShortcutUnavailableReason;
}

/**
 * 给「设置 → 插件 → 插件快捷键」清单用：给每个已解析的快捷键补上可用性。
 * 输入顺序保持不变（宿主按 SDK 的解析结果给，冲突已由 SDK 处理）。
 */
export function classifyExtensionShortcuts(
  shortcuts: readonly ResolvedExtensionShortcut[],
): ExtensionShortcutEntry[] {
  return shortcuts.map((shortcut) => {
    const availability = shortcutAvailability(shortcut.key);
    return {
      key: normalizeShortcutKey(shortcut.key) ?? shortcut.key,
      description: shortcut.description,
      extensionPath: shortcut.extensionPath,
      ...availability,
    };
  });
}
