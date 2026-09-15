/**
 * follow-up 队列的持久化格式（唯一解码器）。
 *
 * 为什么单独成模块：写入方（SdkSessionHost）与启动恢复扫描（LiveSessionRegistry）
 * 必须使用同一套判定。之前两边各写一份，写入格式升级成 `{items, revision}` 后
 * 恢复扫描仍只认数组，于是重启后当前格式的队列**不会被恢复投递**（静默失效）。
 * 独立模块同时避免 host 与 registry 互相 import 形成环。
 *
 * 格式：
 * - 旧格式（纯数组）：无版本号，revision 从 0 起算；
 * - 当前格式：`{ items: string[], revision: number }`；
 * - 其他/损坏：按空队列处理，不抛错（启动恢复不能因一条坏记录失败）。
 */

export type FollowUpQueueState = {
  items: string[];
  revision: number;
};

/** 队列条目的唯一清洗入口：只保留非空字符串。 */
export function normalizeFollowUpItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
}

export function parseFollowUpQueue(raw: unknown): FollowUpQueueState {
  if (Array.isArray(raw)) {
    return { items: normalizeFollowUpItems(raw), revision: 0 };
  }
  if (raw && typeof raw === "object") {
    const stored = raw as { items?: unknown; revision?: unknown };
    return {
      items: normalizeFollowUpItems(stored.items),
      revision: typeof stored.revision === "number" && Number.isFinite(stored.revision)
        ? stored.revision
        : 0,
    };
  }
  return { items: [], revision: 0 };
}

/** 持久化形状（写入方与恢复扫描共享，避免两边漂移）。 */
export function serializeFollowUpQueue(state: FollowUpQueueState): {
  items: string[];
  revision: number;
} {
  return { items: [...state.items], revision: state.revision };
}

/** 是否还有待投递内容（启动恢复据此决定要不要拉起 host）。 */
export function hasQueuedFollowUp(raw: unknown): boolean {
  return parseFollowUpQueue(raw).items.length > 0;
}
