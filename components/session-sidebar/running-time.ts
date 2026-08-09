"use client";

/**
 * 会话行共享运行计时上下文（P1-5）：first-seen startedAt + 1Hz now ticker。
 * 从 SessionSidebar 抽出，供主组件（Provider）与渲染段（SessionItem 消费）共用，
 * 避免 sections ↔ SessionSidebar 循环 import。
 */

import { createContext } from "react";

export interface RunningTimeContextValue {
  startedAt: ReadonlyMap<string, number>;
  now: number;
}

export const RunningTimeContext = createContext<RunningTimeContextValue>({
  startedAt: new Map(),
  now: Date.now(),
});
