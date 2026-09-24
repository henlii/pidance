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

/**
 * 插件 widget（`setWidget`）自己处理按键时，这一个按键该怎么走。
 *
 * 背景：pi-tui 里插件的 `addInputListener` 会拿到每一个按键，并且可以 `consume`。
 * Web 没有同步键盘层，只能挑少数几个键去问插件，而且不能给普通打字加往返。
 * 所以这里只回答四件事：
 *
 * - `route-activation`：输入框为空时按 `↓`/`←`——插件的 widget 靠它从「摘要行」
 *   进「选择态」（pi-subagents 的 fleet 状态就是 `matchesKey(data, "down") ||
 *   matchesKey(data, "left")`）。这个键**不拦截**：空输入框里 `↓`/`←` 本来
 *   没有可见行为，万一插件没消费，也轮不到把按键吞掉。
 * - `route-navigation`：已经进入选择态后的导航键（方向键、`j`/`k`、`Enter`、
 *   `Esc`）——这些键在输入框里会改变光标/换行，所以必须拦下来再问插件。
 * - `exit-interaction`：不是导航键。立刻退出选择态，按键留给输入框（**不问插件**）。
 * - `ignore`：带修饰键或输入法合成中，压根不参与这套机制。
 *
 * Web 端的额外限制：只有输入框为空且聚焦时才可能路由（插件的激活条件也是
 * 空文本），带 Shift 的方向键是选区操作、`Shift+Enter` 是换行，都不碰。
 */
export type ExtensionWidgetKeyAction =
  | "route-activation"
  | "route-navigation"
  | "exit-interaction"
  | "ignore";

export interface ExtensionWidgetKeyInput {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /** 输入法合成中或已被上游 preventDefault：不参与。 */
  composing: boolean;
  /** 当前是否已处于 widget 选择态（由上一次按键是否被插件消费决定）。 */
  interactive: boolean;
}

/** 选择态内的导航键（不含修饰键）。 */
function isPlainNavigationKey(event: ExtensionWidgetKeyInput): boolean {
  if (event.shiftKey) return false;
  switch (event.key) {
    case "ArrowUp":
    case "ArrowDown":
    case "ArrowLeft":
    case "ArrowRight":
    case "Escape":
    case "Enter":
      return true;
    // 插件用 matchesKey(data, "j"/"k") 做上下选择；Shift 会变成大写字母，不是同一个键。
    case "j":
    case "k":
      return true;
    default:
      return false;
  }
}

/** 激活键：输入框为空时的 `↓`/`←`（不拦截，见类型注释）。 */
function isActivationKey(event: ExtensionWidgetKeyInput): boolean {
  if (event.shiftKey) return false;
  return event.key === "ArrowDown" || event.key === "ArrowLeft";
}

export function resolveExtensionWidgetKeyAction(event: ExtensionWidgetKeyInput): ExtensionWidgetKeyAction {
  if (event.composing) return "ignore";
  // 浏览器/输入框自己的快捷键与选区操作：一律不参与
  if (event.ctrlKey || event.altKey || event.metaKey) return "ignore";
  if (isPlainNavigationKey(event)) {
    if (event.interactive) return "route-navigation";
    // 选择态之外只有 `↓`/`←` 能开局，其余导航键留给输入框
    return isActivationKey(event) ? "route-activation" : "ignore";
  }
  return event.interactive ? "exit-interaction" : "ignore";
}

/**
 * 单个可打印字符（`j`/`k` 这类导航键）在 TUI 里的原始字节。
 *
 * `toTerminalKeyData` 只认特殊键与带修饰键的组合，普通字母返回 null；
 * 而 pi-tui 的监听器收到的就是字符本身。
 */
export function isPlainCharacterKey(event: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): boolean {
  return event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey;
}

/**
 * 本地「插件正处于选择态」的保鲜期。
 *
 * 选择态是**本地推断**出来的（上一次按键是否被插件 consume），插件侧可能因为
 * 任何原因先离开（它自己的状态变化、子任务结束、Esc/Enter 提交……）。超过这个
 * 时间没有再路由过按键，就当作它已经离开：宁可少路由，也不能把用户的字母键吞掉。
 */
export const WIDGET_INTERACTION_TTL_MS = 10_000;

/** 输入法合成结束后的宽限期：合成提交那一下会先来一个 Esc/Enter，别当成导航。 */
export const IME_COMPOSITION_GRACE_MS = 80;

export interface WidgetInteractionState {
  /** 本地记的「插件正处于选择态」。 */
  interactive: boolean;
  /** 上一次真正路由（问过插件）的时刻；0 表示还没路由过。 */
  lastRoutedAt: number;
}

export function initialState(): WidgetInteractionState {
  return { interactive: false, lastRoutedAt: 0 };
}

/**
 * 插件的「离开/提交」键：Esc 与 Enter。
 *
 * pi-subagents 的 fleet widget 在这两个键上会 `deactivate()`（Esc 直接复位；
 * Enter 选中 main 也复位）。之后它不再处于选择态，本地状态必须跟着清。
 */
export function isWidgetLeavingKey(key: string): boolean {
  return key === "Escape" || key === "Enter";
}

/** 本地选择态现在还算不算数（过期即视为离开）。 */
export function isWidgetInteractionLive(
  state: WidgetInteractionState,
  now: number,
  ttl: number = WIDGET_INTERACTION_TTL_MS,
): boolean {
  if (!state.interactive) return false;
  return now - state.lastRoutedAt <= ttl;
}

/**
 * 按键之后本地选择态怎么迁移（纯函数，钩子只负责取键与发命令）。
 *
 * 关键规则：**Esc / Enter 被消费也一律清零**。它们被插件消费意味着插件已经
 * 复位或提交，如果本地继续记着「在选择态」，接下来的 `j`/`k`/`Enter`/方向键会被
 * `preventDefault` + `stopPropagation` 拦下并交给已经离开的插件 —— 表现为字母打不进去、
 * 空输入框回车发不出队列（审查阻断项）。
 */
export function nextWidgetInteractionState(
  state: WidgetInteractionState,
  event: { action: ExtensionWidgetKeyAction; key: string; consumed: boolean; now: number },
): WidgetInteractionState {
  if (event.action === "ignore" || event.action === "exit-interaction") {
    return { interactive: false, lastRoutedAt: state.lastRoutedAt };
  }
  if (isWidgetLeavingKey(event.key)) {
    return { interactive: false, lastRoutedAt: event.now };
  }
  return { interactive: event.consumed === true, lastRoutedAt: event.now };
}

/**
 * 输入法合成中的按键不参与这套机制。
 *
 * 除 `isComposing` 外还要看 `keyCode === 229`（IME 处理中的键，部分浏览器/输入法
 * 只给这个信号）与 `compositionend` 之后的短宽限 —— 否则合成提交那一下会先被当成
 * 导航键拦截，中文/日文输入会被吃掉一个键。
 */
export function isImeComposing(
  event: { isComposing?: boolean; keyCode?: number },
  compositionGraceUntil: number,
  now: number,
): boolean {
  if (event.isComposing === true) return true;
  if (event.keyCode === 229) return true;
  return now < compositionGraceUntil;
}

