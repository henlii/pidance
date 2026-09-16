"use client";

import { useSyncExternalStore } from "react";
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

function publish(next: SubagentActivitySnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

async function fetchActivity(): Promise<void> {
  if (inFlight) return;
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
}

function stopPolling(): void {
  if (timer) clearInterval(timer);
  timer = null;
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
