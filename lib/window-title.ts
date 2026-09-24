/**
 * 窗口标题的所有权：**AppShell 是唯一写者**，扩展的 `setTitle` 是一层覆盖。
 *
 * 原先扩展直接写 `document.title`，而 AppShell 用 MutationObserver 把标题拉回
 * 「<目录名> - Pidance」——扩展标题在用户看到之前就被覆盖，谁也没定义它该活多久。
 * 现在：base 由 AppShell 按当前项目维护；扩展标题作为 override 顶在 base 之上，
 * **一直有效到下一次标题写入**（切项目、切会话、或插件再 setTitle 一次）。
 *
 * 生命周期为什么不是「固定 N 秒」（issue #76）：pi-tui 的 `ctx.ui.setTitle` 直接写
 * 终端标题（`terminal.setTitle(title)`，见 SDK 的 UI 适配层），之后**只有应用自己**
 * 在会话/项目变化时重写它——Pi 的 TUI 里没有到期这回事。固定 TTL 会让插件标题在
 * run 还没结束时就自己消失，属于我们自造的语义。改成「下次标题写入即作废」既跟 Pi
 * 一致，又保证标题不会永远压在项目名上（会话切换会重写 base）。
 *
 * 状态在模块级，因此**每个标签页各自一份**，多标签互不影响。
 */

export interface WindowTitleState {
  /** 项目标题（AppShell 维护） */
  base: string;
  /** 当前会话键（AppShell 维护）；变化即作废覆盖 */
  sessionKey: string | null;
  /** 扩展标题；null = 没有覆盖 */
  override: string | null;
}

export function createWindowTitleState(base: string): WindowTitleState {
  return { base, sessionKey: null, override: null };
}

/** base 变化（切项目）→ 覆盖作废；base 未变则返回原引用。 */
export function withWindowTitleBase(state: WindowTitleState, base: string): WindowTitleState {
  if (state.base === base) return state;
  return { ...state, base, override: null };
}

/**
 * 会话变化 → 覆盖作废；同一会话（含 null → null）返回原引用。
 * 单靠 base 不够：同一项目下的两个会话 base 相同，插件标题会跨会话粘住。
 */
export function withWindowTitleSession(state: WindowTitleState, sessionKey: string | null): WindowTitleState {
  if (state.sessionKey === sessionKey) return state;
  return { ...state, sessionKey, override: null };
}

/** 扩展设置标题：空白忽略（返回原引用）；否则写入覆盖。 */
export function withExtensionWindowTitle(state: WindowTitleState, title: string): WindowTitleState {
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (!trimmed) return state;
  return { ...state, override: trimmed };
}

export function isWindowTitleOverrideActive(state: WindowTitleState): boolean {
  return state.override !== null;
}

/** 当前应显示的标题：有覆盖则用覆盖，否则回落到 base。 */
export function resolveWindowTitle(state: WindowTitleState): string {
  return state.override ?? state.base;
}

// ── 模块级状态（每标签页一份）+ 订阅 ────────────────────────────────────────

let state: WindowTitleState = createWindowTitleState("Pidance");
const listeners = new Set<() => void>();

function publish(next: WindowTitleState): void {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

export function getWindowTitleState(): WindowTitleState {
  return state;
}

export function subscribeWindowTitle(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** AppShell 用它把「项目名 - Pidance」写成 base。 */
export function setWindowTitleBase(base: string): void {
  publish(withWindowTitleBase(state, base));
}

/** AppShell 用它上报当前会话；会话变了就作废扩展标题。 */
export function setWindowTitleSession(sessionKey: string | null): void {
  publish(withWindowTitleSession(state, sessionKey));
}

/** 扩展 UI 的 setTitle 落点（覆盖，直到下次标题写入）。 */
export function setExtensionWindowTitle(title: string): void {
  publish(withExtensionWindowTitle(state, title));
}

/** 测试用：重置模块级状态。 */
export function resetWindowTitleForTests(): void {
  state = createWindowTitleState("Pidance");
  listeners.clear();
}
