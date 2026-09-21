/**
 * 窗口标题的所有权：**AppShell 是唯一写者**，扩展的 `setTitle` 只是一段有到期时间的临时覆盖。
 *
 * 原先扩展直接写 `document.title`，而 AppShell 用 MutationObserver 把标题拉回
 * 「<目录名> - Pidance」——扩展标题在用户看到之前就被覆盖，谁也没定义它该活多久。
 * 现在：base 由 AppShell 按当前项目/会话维护；扩展标题作为 override 生效一段时间，
 * 到期自动回落到 base；项目/会话切换（base 变化）时 override 立即作废。
 *
 * 状态在模块级，因此**每个标签页各自一份**，多标签互不影响。
 */

export const EXTENSION_TITLE_TTL_MS = 30_000;

export interface WindowTitleState {
  /** 项目/会话标题（AppShell 维护） */
  base: string;
  /** 扩展临时标题；null = 没有覆盖 */
  override: string | null;
  /** 覆盖到期时刻（epoch ms）；无覆盖为 0 */
  overrideUntil: number;
}

export function createWindowTitleState(base: string): WindowTitleState {
  return { base, override: null, overrideUntil: 0 };
}

/** base 变化（切项目/会话）→ 覆盖立即作废；base 未变则返回原引用。 */
export function withWindowTitleBase(state: WindowTitleState, base: string): WindowTitleState {
  if (state.base === base) return state;
  return { base, override: null, overrideUntil: 0 };
}

/** 扩展设置标题：空白忽略（返回原引用）；否则写入带 TTL 的覆盖。 */
export function withExtensionWindowTitle(
  state: WindowTitleState,
  title: string,
  now = Date.now(),
  ttlMs = EXTENSION_TITLE_TTL_MS,
): WindowTitleState {
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (!trimmed) return state;
  return { ...state, override: trimmed, overrideUntil: now + Math.max(0, ttlMs) };
}

export function isWindowTitleOverrideActive(state: WindowTitleState, now = Date.now()): boolean {
  return state.override !== null && now < state.overrideUntil;
}

/** 覆盖剩余毫秒（无覆盖/已过期 → 0），供调用方安排回落定时器。 */
export function windowTitleOverrideRemainingMs(state: WindowTitleState, now = Date.now()): number {
  if (!isWindowTitleOverrideActive(state, now)) return 0;
  return Math.max(0, state.overrideUntil - now);
}

/** 当前应显示的标题：覆盖有效则用覆盖，否则回落到 base。 */
export function resolveWindowTitle(state: WindowTitleState, now = Date.now()): string {
  return isWindowTitleOverrideActive(state, now) ? state.override! : state.base;
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

/** 扩展 UI 的 setTitle 落点（临时覆盖）。 */
export function setExtensionWindowTitle(title: string, now = Date.now()): void {
  publish(withExtensionWindowTitle(state, title, now));
}

/** 测试用：重置模块级状态。 */
export function resetWindowTitleForTests(): void {
  state = createWindowTitleState("Pidance");
  listeners.clear();
}
