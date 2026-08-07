/**
 * 统一 Settings 的导航模型：页面清单、可用性（无 cwd 降级提示）、
 * 最近页解析与移动端「导航首页 → 页面内容」状态转换。
 * 全部为纯函数，方便 node:test 定向覆盖。
 */

export type SettingsPageId = "general" | "appearance" | "models" | "defaults" | "skills" | "plugins" | "trust";

export interface SettingsPageInfo {
  id: SettingsPageId;
  label: SettingsPageId;
  /** 该页是否需要活动项目 cwd 才能使用业务能力 */
  requiresCwd: boolean;
  /** 当前是否可用（无 cwd 时 requiresCwd 页保留导航项但不可用） */
  available: boolean;
  /** 不可用时的具体提示文案（available=false 时必有值） */
  unavailableHint?: "skills" | "plugins";
}

// general / appearance / models / defaults / trust 无 cwd 也可看全局；skills/plugins 需要项目。
const PAGE_ORDER: SettingsPageId[] = ["general", "appearance", "models", "defaults", "skills", "plugins", "trust"];

/** 无 cwd 提示：保留导航项，内容区显示具体指引，不静默隐藏。 */
const PAGE_NO_CWD_HINT: Partial<Record<SettingsPageId, "skills" | "plugins">> = { skills: "skills", plugins: "plugins" };

export const SETTINGS_PAGE_STORAGE_KEY = "pidance:settings:page:v1";
export const DEFAULT_SETTINGS_PAGE: SettingsPageId = "appearance";

/** 可注入 storage，便于迁移单测。 */
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export function isSettingsPageId(value: unknown): value is SettingsPageId {
  return typeof value === "string" && (PAGE_ORDER as string[]).includes(value);
}

/**
 * 读取最近 Settings 页：仅读规范键；损坏输入安全回退默认页。
 */
export function loadStoredSettingsPage(storage: StorageLike): SettingsPageId {
  try {
    const raw = storage.getItem(SETTINGS_PAGE_STORAGE_KEY);
    if (raw === null) return DEFAULT_SETTINGS_PAGE;
    return parseStoredSettingsPage(raw);
  } catch {
    return DEFAULT_SETTINGS_PAGE;
  }
}

/** 页面清单：general/appearance/models/defaults/trust 无 cwd 可用；skills/plugins 无 cwd 时给出提示。 */
export function getSettingsPages(hasCwd: boolean): SettingsPageInfo[] {
  return PAGE_ORDER.map((id) => {
    const requiresCwd = id === "skills" || id === "plugins";
    const available = !requiresCwd || hasCwd;
    return {
      id,
      label: id,
      requiresCwd,
      available,
      ...(available ? {} : { unavailableHint: PAGE_NO_CWD_HINT[id]! }),
    };
  });
}

/**
 * 解析 localStorage 里的最近页：任何异常（非字符串、JSON 损坏、
 * 未知页面、旧格式对象）都安全回退到默认页，绝不抛错。
 */
export function parseStoredSettingsPage(raw: unknown): SettingsPageId {
  if (typeof raw !== "string" || !raw) return DEFAULT_SETTINGS_PAGE;
  let candidate: unknown = raw;
  // 兼容 JSON 包裹与旧格式 { page: "..." }，解析失败按裸字符串处理。
  try {
    candidate = JSON.parse(raw);
  } catch {
    candidate = raw;
  }
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    candidate = (candidate as { page?: unknown }).page;
  }
  return isSettingsPageId(candidate) ? candidate : DEFAULT_SETTINGS_PAGE;
}

/** 移动端导航状态：null = 导航首页；否则为具体页面。 */
export type MobileSettingsView = { page: SettingsPageId | null };

export type MobileSettingsNavAction =
  | { type: "select"; page: SettingsPageId }
  | { type: "back" };

/** 移动端「首页 → 页面 → Back 回首页」的状态转换，桌面端不使用该模型。 */
export function nextMobileSettingsView(
  current: MobileSettingsView,
  action: MobileSettingsNavAction,
): MobileSettingsView {
  if (action.type === "back") return { page: null };
  // 重复选择同一页保持幂等。
  if (current.page === action.page) return current;
  return { page: action.page };
}
