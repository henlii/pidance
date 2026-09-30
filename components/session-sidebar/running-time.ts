"use client";

/**
 * 会话行共享运行计时上下文（P1-5）：first-seen startedAt + 1Hz now ticker。
 * 从 SessionSidebar 抽出，供主组件（Provider）与渲染段（SessionItem 消费）共用，
 * 避免 sections ↔ SessionSidebar 循环 import。
 */

import { createContext, useContext } from "react";

export interface RunningTimeContextValue {
  startedAt: ReadonlyMap<string, number>;
  now: number;
}

export const RunningTimeContext = createContext<RunningTimeContextValue>({
  startedAt: new Map(),
  now: Date.now(),
});

/**
 * 询问用户中的会话集合（agent 暂停等待 extension 弹窗/ask 回复）：
 * 这些会话显示等待黄点而不是运行动画。由 SessionSidebar 从
 * /api/agent/running(+events) 的 pendingExtensionUi 维护并提供。
 */
export const WaitingSessionIdsContext = createContext<ReadonlySet<string>>(new Set());

export function useWaitingSessionIds(): ReadonlySet<string> {
  return useContext(WaitingSessionIdsContext);
}

/**
 * 上次运行异常中断（aborted/error）且尚未读过的会话：侧栏显示红点。
 * 事实由服务端写（unreadSessionState.abnormalAt），这里只负责传到行上。
 */
export const AbnormalSessionIdsContext = createContext<ReadonlySet<string>>(new Set());

export function useAbnormalSessionIds(): ReadonlySet<string> {
  return useContext(AbnormalSessionIdsContext);
}
