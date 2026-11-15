"use client";

import { useSyncExternalStore } from "react";
import { subscribeAppEvents } from "@/lib/app-events-stream";
import { buildSubagentActivity, EMPTY_SUBAGENT_ACTIVITY, type SubagentActivity } from "@/lib/subagent-activity";
import type { SubagentRunView } from "@/lib/subagent-run-types";

/**
 * subagent 运行状态的浏览器侧单一数据源（模块级单例）。
 *
 * 侧栏 running 点与顶栏子会话谱系共用同一次 30s 轮询，避免同一接口被多处
 * 各拉一遍；首个订阅者启动、最后一个退订停止。失败保留上次数据并置 stale
 * （UI 据此提示「数据可能过期」），标签页隐藏时跳过轮询、回到前台立即刷新。
 */

const POLL_INTERVAL_MS = 30_000;

export type SubagentActivitySnapshot = SubagentActivity & {
  /** 最近一次刷新失败（数据可能过期）。 */
  stale: boolean;
  /** 最近一次成功刷新的时间戳。 */
  updatedAt: number | null;
};

const INITIAL_SNAPSHOT: SubagentActivitySnapshot = {
  ...EMPTY_SUBAGENT_ACTIVITY,
  stale: false,
  updatedAt: null,
};

let snapshot: SubagentActivitySnapshot = INITIAL_SNAPSHOT;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let unsubscribeAppEvents: (() => void) | null = null;
/**
 * 请求进行中时又收到刷新信号：记下来在收尾后再拉一次。
 *
 * 没有这个位，子代理收尾那次 `subagent-runs-changed` 一旦撞上 in-flight 就被丢掉，
 * 侧栏/谱系会停在「还在跑」直到下一次 30s 轮询。
 */
let pendingRefresh = false;

function publish(next: SubagentActivitySnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

async function fetchActivity(): Promise<void> {
  if (inFlight) {
    pendingRefresh = true;
    return;
  }
  inFlight = true;
  try {
    const res = await fetch("/api/subagent-runs?limit=50");
    if (!res.ok) {
      publish({ ...snapshot, stale: true });
      return;
    }
    const data = await res.json() as { runs?: SubagentRunView[] };
    publish({ ...buildSubagentActivity(data.runs), stale: false, updatedAt: Date.now() });
  } catch {
    publish({ ...snapshot, stale: true });
  } finally {
    inFlight = false;
    if (pendingRefresh) {
      pendingRefresh = false;
      void fetchActivity();
    }
  }
}

/** 立即刷新（会话列表变化后调用，不等下一次轮询）。 */
export function refreshSubagentActivity(): void {
  void fetchActivity();
}

function handleVisibility(): void {
  if (!document.hidden) void fetchActivity();
}

function startPolling(): void {
  void fetchActivity();
  timer = setInterval(() => {
    if (!document.hidden) void fetchActivity();
  }, POLL_INTERVAL_MS);
  document.addEventListener("visibilitychange", handleVisibility);
  // 服务端 watch 到子代理 run 记录变化就推一次（只读子代理页面也靠这同一个信号），
  // 不必等 30s 轮询 —— 轮询只留作事件流断开时的兜底。
  unsubscribeAppEvents = subscribeAppEvents((payload) => {
    const data = payload as { type?: unknown } | null;
    if (data?.type !== "subagent-runs-changed") return;
    void fetchActivity();
  });
}

function stopPolling(): void {
  if (timer) clearInterval(timer);
  timer = null;
  unsubscribeAppEvents?.();
  unsubscribeAppEvents = null;
  document.removeEventListener("visibilitychange", handleVisibility);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) startPolling();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopPolling();
  };
}

function getSnapshot(): SubagentActivitySnapshot {
  return snapshot;
}

function getServerSnapshot(): SubagentActivitySnapshot {
  return INITIAL_SNAPSHOT;
}

export function useSubagentActivity(): SubagentActivitySnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
