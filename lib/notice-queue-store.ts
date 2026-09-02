/**
 * 每会话通知队列（纯逻辑，无 React）。
 *
 * 需求：
 * - 通知属于指定会话：会话 A 产生的提示只会在 A 被加载时展示。
 * - 每会话独立内存队列，不跟随会话生命周期（切走不清空，会话对象销毁也不丢，
 *   UI 重新加载该会话时仍可取出展示）。
 * - 展示上限：同时最多 3 条普通（transient，自动关闭）+ 3 条高级（important，
 *   不会自动关闭，直到用户关闭）。
 * - 当前加载哪个会话，就从该会话队列里一条一条取出（FIFO）在右上角展示。
 *
 * 与旧 notice-reducer 的关系：reducer 保留（活动历史合并/退出动画），
 * 队列是本 store 的 enqueue/dequeue 语义，驱动同一 NoticeItem 形状。
 */

import type { NoticeItem, NoticeType } from "./notice-reducer";

export const NOTICE_TRANSIENT_VISIBLE = 3;
export const NOTICE_IMPORTANT_VISIBLE = 3;

export type NoticeQueueItem = {
  id: string;
  sessionId: string | null;
  message: string;
  type: NoticeType;
  tier: "transient" | "important";
  pinned: boolean;
  activityRecord: boolean;
};

export type NoticeQueueState = {
  /** sessionId → FIFO 队列（sessionId 用 null 表示全局/新会话意图）。 */
  queues: Map<string | null, NoticeQueueItem[]>;
  /** 当前活跃会话的可见投影（按 tiers 分槽）。 */
  visible: NoticeItem[];
};

export type NoticeQueueAction =
  | { type: "enqueue"; item: NoticeQueueItem }
  | { type: "activate"; sessionId: string | null }
  | { type: "dismiss"; id: string }
  | { type: "toggle_pin"; id: string }
  | { type: "expire_transient"; id: string }
  | { type: "clear_session"; sessionId: string };

function projectVisible(
  queues: Map<string | null, NoticeQueueItem[]>,
  sessionId: string | null,
): NoticeItem[] {
  const queue = queues.get(sessionId) ?? [];
  const transient: NoticeItem[] = [];
  const important: NoticeItem[] = [];
  for (const item of queue) {
    if (item.tier === "transient") {
      if (transient.length >= NOTICE_TRANSIENT_VISIBLE) continue;
      transient.push({
        id: item.id,
        message: item.message,
        type: item.type,
        tier: "transient",
        pinned: false,
        activityRecord: item.activityRecord,
      });
    } else {
      if (important.length >= NOTICE_IMPORTANT_VISIBLE) continue;
      important.push({
        id: item.id,
        message: item.message,
        type: item.type,
        tier: "important",
        pinned: item.pinned,
        activityRecord: item.activityRecord,
      });
    }
  }
  // 重要消息优先展示，普通消息排在后面；各自保持 FIFO。
  return [...important, ...transient];
}

export function createNoticeQueueStore() {
  let queues = new Map<string | null, NoticeQueueItem[]>();
  let activeSessionId: string | null = null;
  const listeners = new Set<() => void>();

  const getQueue = (sessionId: string | null): NoticeQueueItem[] => {
    const existing = queues.get(sessionId);
    if (existing) return existing;
    const next: NoticeQueueItem[] = [];
    queues.set(sessionId, next);
    return next;
  };

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const store = {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    enqueue(
      input: { sessionId: string | null; id?: string; message: string; type: NoticeType; activityRecord?: boolean },
    ): string {
      const id = input.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const level = input.type;
      const tier: "transient" | "important" = level === "warning" || level === "error"
        ? "important"
        : "transient";
      const queue = getQueue(input.sessionId ?? null);
      // 同 id 去重（SSE 重放）
      if (queue.some((item) => item.id === id)) return id;
      queue.push({
        id,
        sessionId: input.sessionId ?? null,
        message: input.message.trim(),
        type: level,
        tier,
        pinned: false,
        activityRecord: input.activityRecord === true,
      });
      notify();
      return id;
    },
    activate(sessionId: string | null) {
      if (activeSessionId === sessionId) return;
      activeSessionId = sessionId;
      notify();
    },
    /** 当前活跃会话可见投影（3 transient + 3 important）。 */
    getVisible(): NoticeItem[] {
      return projectVisible(queues, activeSessionId);
    },
    /** 指定会话队列长度（调试/测试用）。 */
    queueLength(sessionId: string | null): number {
      return (queues.get(sessionId ?? null) ?? []).length;
    },
    /** 从活跃会话队列移除一条已展示/已关闭的项。 */
    dismiss(id: string) {
      const queue = queues.get(activeSessionId);
      if (!queue) return;
      const next = queue.filter((item) => item.id !== id);
      if (next.length !== queue.length) {
        queues.set(activeSessionId, next);
        notify();
      }
    },
    togglePin(id: string) {
      const queue = queues.get(activeSessionId);
      if (!queue) return;
      const next = queue.map((item) =>
        item.id === id && item.tier === "important" ? { ...item, pinned: !item.pinned } : item,
      );
      if (next.some((item, i) => item !== queue[i])) {
        queues.set(activeSessionId, next);
        notify();
      }
    },
    /** 普通消息自动过期：从活跃会话队列移除该条并通知。 */
    expireTransient(id: string) {
      const queue = queues.get(activeSessionId);
      if (!queue) return;
      const next = queue.filter((item) => !(item.id === id && item.tier === "transient"));
      if (next.length !== queue.length) {
        queues.set(activeSessionId, next);
        notify();
      }
    },
    clearSession(sessionId: string | null) {
      if (!queues.has(sessionId)) return;
      queues.set(sessionId, []);
      notify();
    },
    /** 测试用：重置全部状态。 */
    resetForTests() {
      queues = new Map();
      activeSessionId = null;
      notify();
    },
  };

  return store;
}

export type NoticeQueueStore = ReturnType<typeof createNoticeQueueStore>;

let singleton: NoticeQueueStore | null = null;

export function getNoticeQueueStore(): NoticeQueueStore {
  if (!singleton) singleton = createNoticeQueueStore();
  return singleton;
}
