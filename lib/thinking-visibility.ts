/**
 * 「隐藏思考块」（settings.json 的 `hideThinkingBlock`）在 Web 侧的消费点。
 *
 * 为什么需要这个模块：这个设置本来只写进 settings.json，终端 TUI 从
 * `SettingsManager.getHideThinkingBlock()` 读它并把思考块换成一行标签，
 * 而 Web 侧**没有任何地方消费它** —— 开关点了没效果。这里补上消费点。
 *
 * 存在内存里的是一份**界面偏好镜像**（localStorage），值本身仍以 settings.json 为准：
 * 设置表单加载时会把文件里的值写进来，改开关时也会同步写。
 *
 * 用 localStorage 而不是每帧去问服务端，是因为它只影响本机怎么画消息，
 * 与「会话内容懒加载」那类显示偏好同一条口径（见 lib/session-lazy-load.ts）。
 */

export const HIDE_THINKING_STORAGE_KEY = "pidance.hideThinkingBlock";

/** localStorage 的最小接口（隐私模式/SSR 下没有 localStorage，读写都要能静默回退）。 */
export type ThinkingStorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function storageOrDefault(storage?: ThinkingStorageLike | null): ThinkingStorageLike | null {
  if (storage !== undefined) return storage;
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 读设置：只有显式的 "1" 才算开；缺失、坏值、存储不可用一律当关（默认与 TUI 一致）。 */
export function loadHideThinkingBlockSetting(storage?: ThinkingStorageLike | null): boolean {
  const store = storageOrDefault(storage);
  if (!store) return false;
  try {
    return store.getItem(HIDE_THINKING_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();

/** 订阅变化（同一标签内即时生效；跨标签刷新后自然读到新值）。 */
export function subscribeHideThinkingBlock(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 写设置并通知订阅者。写失败不影响界面（下次加载退回默认）。 */
export function saveHideThinkingBlockSetting(value: boolean, storage?: ThinkingStorageLike | null): void {
  const store = storageOrDefault(storage);
  try {
    store?.setItem(HIDE_THINKING_STORAGE_KEY, value ? "1" : "0");
  } catch {
    /* 存储不可用：界面按当前这次的选择走，只是不跨刷新 */
  }
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* 单个订阅者出错不影响其他订阅者 */
    }
  }
}

/** 服务端渲染时的快照：一律当关（与首帧默认一致，避免水合不一致）。 */
export function serverHideThinkingBlockSetting(): boolean {
  return false;
}
