import type { StorageLike } from "./ui-preferences";

/**
 * 「会话内容懒加载」：设置 → 会话 里的开关 + 每次加载条数。
 *
 * - 勾选（默认）：请求带 `limit=<条数>`，首屏 tail、向上翻页、向下翻页、
 *   换色重取都按这个值取。
 * - 不勾选：**请求不带 `limit`**（服务端的 `parseContextLimitParam` 缺省返回 null，
 *   调用方就不切片 —— 这是既有的全量路径）。不要传 0 或超大数：那会让服务端
 *   的 `clampLimit` 把 0 夹成 1、把超大数夹成 500，语义完全变了。
 *
 * 逻辑集中在这里而不是散在四处调用点：请求形态（带不带 limit）是本功能的核心行为，
 * 放在纯函数里才能被单测直接钉住。
 */

export const SESSION_LAZY_LOAD_STORAGE_KEY = "pidance.sessionLazyLoad";

/** 条数下限/上限：上限与服务端 clampLimit 的口径一致（1–500）。 */
export const SESSION_LAZY_LOAD_MIN_COUNT = 1;
export const SESSION_LAZY_LOAD_MAX_COUNT = 500;

/** 默认条数：20（比服务端缺省 100 小，一屏读完再往下滚的体验更好）。 */
export const DEFAULT_SESSION_LAZY_LOAD_COUNT = 20;

export type SessionLazyLoadSetting = {
  /** 是否启用懒加载；false = 全量加载（请求不带 limit）。 */
  enabled: boolean;
  /** 每次加载的可见消息条数。 */
  count: number;
};

export const DEFAULT_SESSION_LAZY_LOAD: SessionLazyLoadSetting = {
  enabled: true,
  count: DEFAULT_SESSION_LAZY_LOAD_COUNT,
};

/**
 * 条数清洗。
 *
 * - 数字字符串按数字处理（表单输入是字符串，`"30"` 应当就是 30）；
 *   非整数（`30.5`、`NaN`、`Infinity`）、非数字、空串 → 回落默认 20。
 * - 小于 1 的整数（0、-5）同样回落 20：它是「没填」而不是「要 1 条」。
 * - 大于上限的整数夹到 500（意图明确，只是超过服务端能力，保留意图比抹掉更好）。
 */
export function sanitizeSessionLazyLoadCount(value: unknown): number {
  const numeric = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || !Number.isInteger(numeric)) {
    return DEFAULT_SESSION_LAZY_LOAD_COUNT;
  }
  if (numeric < SESSION_LAZY_LOAD_MIN_COUNT) return DEFAULT_SESSION_LAZY_LOAD_COUNT;
  return Math.min(SESSION_LAZY_LOAD_MAX_COUNT, numeric);
}

/** 解析存储里的设置；缺省/损坏一律回落默认（勾选 + 20）。 */
export function parseSessionLazyLoadSetting(raw: unknown): SessionLazyLoadSetting {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_SESSION_LAZY_LOAD };
  }
  const record = raw as Record<string, unknown>;
  // 仅显式 false / 0 / "0" / "false" 关闭；缺省与脏数据保持开启（与 autoUpdateCheck 同一口径）。
  const enabled = !(record.enabled === false || record.enabled === 0 || record.enabled === "0" || record.enabled === "false");
  return { enabled, count: sanitizeSessionLazyLoadCount(record.count) };
}

/**
 * 请求里该用多少条 —— `null` 表示**不带 limit**（全量）。
 *
 * `atLeast` 给「换色重取」那种需要覆盖已加载窗口的场景用：它要一次拿回至少已加载的
 * 条数，所以取 `max(已加载条数, 配置值)`；未启用时依然是 null（全量）。
 */
export function sessionLazyLoadLimit(setting: SessionLazyLoadSetting, atLeast = 0): number | null {
  if (!setting.enabled) return null;
  const floor = Number.isFinite(atLeast) && atLeast > 0 ? Math.floor(atLeast) : 0;
  return Math.min(SESSION_LAZY_LOAD_MAX_COUNT, Math.max(floor, sanitizeSessionLazyLoadCount(setting.count)));
}

export function loadSessionLazyLoadSettingFromStorage(storage: StorageLike): SessionLazyLoadSetting {
  try {
    const raw = storage.getItem(SESSION_LAZY_LOAD_STORAGE_KEY);
    if (raw === null) return { ...DEFAULT_SESSION_LAZY_LOAD };
    try {
      return parseSessionLazyLoadSetting(JSON.parse(raw) as unknown);
    } catch {
      return { ...DEFAULT_SESSION_LAZY_LOAD };
    }
  } catch {
    return { ...DEFAULT_SESSION_LAZY_LOAD };
  }
}

/** SSR / 无 localStorage 环境安全返回默认值。 */
export function loadSessionLazyLoadSetting(): SessionLazyLoadSetting {
  if (typeof window === "undefined") return { ...DEFAULT_SESSION_LAZY_LOAD };
  return loadSessionLazyLoadSettingFromStorage(window.localStorage);
}

export function saveSessionLazyLoadSettingToStorage(storage: StorageLike, setting: SessionLazyLoadSetting): void {
  try {
    // 写入前先清洗：越界值不落盘，免得下次读出来还是越界的。
    storage.setItem(
      SESSION_LAZY_LOAD_STORAGE_KEY,
      JSON.stringify({ enabled: setting.enabled === true, count: sanitizeSessionLazyLoadCount(setting.count) }),
    );
  } catch {
    // 忽略存储配额 / 隐私模式错误：读不到就按默认走。
  }
}

export function saveSessionLazyLoadSetting(setting: SessionLazyLoadSetting): void {
  if (typeof window === "undefined") return;
  saveSessionLazyLoadSettingToStorage(window.localStorage, setting);
}
