/**
 * 宿主自己发出的**扩展能力提示**（"Web 端不支持 / 只部分支持某能力"）在同一个浏览器里
 * **每种能力只提示一次**。
 *
 * 为什么不按提示 id 记：id 是每次发出时新生成的 uuid（宿主重启就换一个），按 id 记等于没记
 * —— 刷新页面、重启服务都会让同一条提示再弹一次。
 *
 * 为什么不是"用户关掉才记"：这条提示的价值是一次性告知「这个能力在 Web 上有边界」，
 * 看过就够了；它属于 important 档、不会自动过期，留着只会变成噪音。
 *
 * 只在**浏览器本地**记（与折叠状态、未读等本机 UI 状态同一条口径）：换一台设备
 * 该提示会重新出现一次，这是可以接受的。
 */

export const CAPABILITY_NOTICE_SEEN_KEY = "pidance:capability-notices-seen.v1";

/** 上限：能力种类是枚举（公开面十几种），超出就丢最旧的。 */
export const MAX_SEEN_CAPABILITY_FEATURES = 64;

export type SeenStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/**
 * 从提示文本里取出能力名。
 *
 * 宿主的两条提示都用同一句式（`lib/web-extension-ui.ts` 的 notifyUnsupported /
 * notifyLimitedSupport）：`Extension UI "<feature>" is not supported|is limited …`。
 * 认不出句式就返回 null —— 那种情况（例如插件自己的 notify）**不做**一次性抑制。
 */
export function capabilityFeatureOf(message: string): string | null {
  if (typeof message !== "string") return null;
  const match = /Extension UI "([^"]{1,80})"/.exec(message);
  const feature = match?.[1]?.trim();
  return feature ? feature : null;
}

export function loadSeenCapabilityFeatures(storage: SeenStorage | null | undefined): Set<string> {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(CAPABILITY_NOTICE_SEEN_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string" && item.length > 0));
  } catch {
    // 损坏输入当作没记过：最多多弹一次，不影响功能。
    return new Set();
  }
}

export function markCapabilityFeatureSeen(storage: SeenStorage | null | undefined, feature: string): void {
  if (!storage || !feature) return;
  try {
    const seen = loadSeenCapabilityFeatures(storage);
    if (seen.has(feature)) return;
    seen.add(feature);
    const bounded = [...seen].slice(-MAX_SEEN_CAPABILITY_FEATURES);
    storage.setItem(CAPABILITY_NOTICE_SEEN_KEY, JSON.stringify(bounded));
  } catch {
    // 存储不可用（隐私模式）：退化成"每次刷新都可能再提示一次"，不影响功能。
  }
}

function browserStorage(): SeenStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function hasSeenCapabilityFeature(feature: string | null): boolean {
  if (!feature) return false;
  return loadSeenCapabilityFeatures(browserStorage()).has(feature);
}

export function rememberCapabilityFeature(feature: string | null): void {
  if (!feature) return;
  markCapabilityFeatureSeen(browserStorage(), feature);
}
