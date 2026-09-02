"use client";

import { useCallback, useEffect, useReducer, useState } from "react";
import { noticeReducer, type NoticeType } from "@/lib/notice-reducer";
import { getNoticeQueueStore } from "@/lib/notice-queue-store";
import type { SessionActivity } from "@/lib/session-activity";

/**
 * notice/activity 展示状态所有权（#17 D5c + #23 每会话队列）。
 *
 * - notices：改由「每会话通知队列」驱动——通知归属指定会话（sessionId），
 *   独立内存队列、不跟随会话生命周期；当前加载哪个会话就展示哪个会话的
 *   可见投影（同时最多 3 条普通 + 3 条高级，普通自动过期、高级常驻）。
 * - mainReducer 投影仍保留（历史活动合并/退出动画），双轨以 store 为主。
 * - liveNoticeActivities：notify 持久活动的页内增量覆盖层（与之前一致）。
 */

export type LiveNoticeActivity = {
  activity: SessionActivity;
  timestamp: number;
};

const NOTICE_VISIBLE_MS = 5000;

function createNoticeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useNoticeState(sessionId?: string | null) {
  const store = getNoticeQueueStore();
  const activeSessionId = sessionId ?? null;
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
  // legacy reducer 保留：visible 投影由 store 提供后，此 reducer 只承载退出动画
  // 与活动历史的「历史合并」；实际消费的 notices 来自 store 的 getVisible()。
  const [, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const [liveNoticeActivities, setLiveNoticeActivities] = useState<LiveNoticeActivity[]>([]);

  // 订阅 store：任何入队/激活/关闭都触发本 hook 重渲。
  useEffect(() => {
    return store.subscribe(() => forceUpdate());
  }, [store]);

  // 活跃会话变化：激活对应队列（其可见投影立即切换）。
  useEffect(() => {
    store.activate(activeSessionId);
  }, [store, activeSessionId]);

  const addNotice = useCallback((notice: { id?: string; message: string; type?: NoticeType; activityRecord?: boolean }) => {
    const message = notice.message.trim();
    if (!message) return;
    store.enqueue({
      sessionId: activeSessionId,
      id: notice.id ?? createNoticeId(),
      message,
      type: notice.type ?? "info",
      activityRecord: notice.activityRecord === true,
    });
  }, [store, activeSessionId]);

  /** 并入页内活动投影：requestId 去重（与磁盘快照带回后自动去重语义一致）。 */
  const addLiveActivity = useCallback((activity: SessionActivity) => {
    setLiveNoticeActivities((current) => (
      current.some((item) => item.activity.requestId === activity.requestId)
        ? current
        : [...current, { activity, timestamp: Date.now() }]
    ));
  }, []);

  /** 会话切换时清空页内活动投影（不写回磁盘；磁盘活动由 loadSession 重新加载）。 */
  const clearLiveActivities = useCallback(() => {
    setLiveNoticeActivities([]);
  }, []);

  const dismissNotice = useCallback((id: string) => {
    store.dismiss(id);
  }, [store]);

  const toggleNoticePin = useCallback((id: string) => {
    store.togglePin(id);
  }, [store]);

  // 普通消息自动过期：可见 transient 满 5s 后从队列移除（FIFO 补位）。
  useEffect(() => {
    const visible = store.getVisible();
    const oldestTransient = visible.find((notice) => notice.tier === "transient");
    if (!oldestTransient) return;
    const t = setTimeout(() => {
      store.expireTransient(oldestTransient.id);
    }, NOTICE_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [store, activeSessionId, store.getVisible().length]);

  return {
    notices: store.getVisible(),
    liveNoticeActivities,
    addNotice,
    addLiveActivity,
    clearLiveActivities,
    dismissNotice,
    toggleNoticePin,
  };
}
