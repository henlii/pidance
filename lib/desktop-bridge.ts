/**
 * 桌面壳（Electron）桥接的**纯逻辑**：类型、形状校验、以及「什么时候该发桌面通知」的判定（#51）。
 *
 * 背景：`desktop/src/preload.js` 通过 contextBridge 暴露了 `window.pidanceDesktop`
 * （`isDesktop` / `getSettings` / `setSetting` / `notify` / `onOpenSettings`），托盘菜单里的
 * 「桌面版设置…」会向页面发 `desktop-settings:open`。**Web 端此前没有任何消费者**，所以那个
 * 菜单项点了没反应、桌面通知也没人调用。
 *
 * 这里只放不依赖 Electron / DOM 的部分（形状校验 + 通知判定），方便 node:test 直接覆盖；
 * 读写 IPC 与 UI 接线在 hooks/组件里。
 */

/** 桌面设置的三个开关，与 `desktop/src/main.js` 的 `updateDesktopSetting` 白名单一致。 */
export type DesktopSettingKey = "openAtLogin" | "minimizeToTray" | "notificationsEnabled";

export interface DesktopSettings {
  openAtLogin: boolean;
  minimizeToTray: boolean;
  notificationsEnabled: boolean;
}

export const DESKTOP_SETTING_KEYS: readonly DesktopSettingKey[] = [
  "openAtLogin",
  "minimizeToTray",
  "notificationsEnabled",
];

/** 主进程返回的设置快照 → 规范化。缺字段/非布尔一律按 false（不猜、不抛）。 */
export function normalizeDesktopSettings(raw: unknown): DesktopSettings {
  const record = (raw && typeof raw === "object" && !Array.isArray(raw))
    ? (raw as Record<string, unknown>)
    : {};
  const out: DesktopSettings = { openAtLogin: false, minimizeToTray: false, notificationsEnabled: false };
  for (const key of DESKTOP_SETTING_KEYS) {
    if (record[key] === true) out[key] = true;
  }
  return out;
}

/** 预加载脚本暴露的桥（只需用到的方法）。 */
export interface DesktopBridge {
  isDesktop?: boolean;
  getSettings: () => Promise<unknown>;
  setSetting: (key: string, value: boolean) => Promise<unknown>;
  notify: (title: string, body: string) => unknown;
  onOpenSettings: (callback: () => void) => () => void;
}

/**
 * 从宿主对象里取出桌面桥；**形状不对就返回 null**（Web 上根本没有这个对象）。
 * 校验形状而不是只看 `isDesktop`：预加载脚本升级/半注入时宁可当作「没有桌面能力」。
 */
export function readDesktopBridge(scope: unknown = globalThis): DesktopBridge | null {
  if (!scope || typeof scope !== "object") return null;
  const candidate = (scope as { pidanceDesktop?: unknown }).pidanceDesktop;
  if (!candidate || typeof candidate !== "object") return null;
  const bridge = candidate as Partial<DesktopBridge>;
  if (typeof bridge.getSettings !== "function") return null;
  if (typeof bridge.setSetting !== "function") return null;
  if (typeof bridge.notify !== "function") return null;
  if (typeof bridge.onOpenSettings !== "function") return null;
  return bridge as DesktopBridge;
}

/**
 * 是否该为「某个会话跑完了」发桌面通知。
 *
 * 只在**页面不可见**（窗口最小化/被切走）时发：用户正在看的时候再弹系统通知纯属打扰；
 * 关掉「桌面通知」开关时也不发（主进程侧还会再兜一层，这里早退省一次 IPC）。
 */
export function shouldNotifyRunCompletion(input: {
  /** `document.visibilityState === "hidden"` */
  hidden: boolean;
  /** 刚跑完的会话 */
  sessionId: string | null;
  /** 当前正在看的会话（正在看它就已经看见了，不必再通知） */
  visibleSessionId: string | null;
  notificationsEnabled: boolean;
}): boolean {
  if (!input.notificationsEnabled) return false;
  if (!input.hidden) return false;
  if (!input.sessionId) return false;
  if (input.sessionId === input.visibleSessionId) return false;
  return true;
}
