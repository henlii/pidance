/**
 * subagent 运行状态投影（纯函数，浏览器侧共用）。
 *
 * 把 /api/subagent-runs 的 run 列表压成两份索引：哪些子会话在跑、
 * sessionId → 运行信息（标签/token/耗时/当前工具的展示来源）。
 */

import type { SubagentRunStepView, SubagentRunView } from "./subagent-run-types";

/** 视为「进行中」的 run 状态（与侧栏 running 点同一语义）。 */
export const SUBAGENT_ACTIVE_RUN_STATES: ReadonlySet<string> = new Set(["running", "queued", "paused"]);

export type SubagentActivityEntry = {
  runId: string;
  mode: string;
  /** 该 step 所属 run 是否进行中。 */
  active: boolean;
  step: SubagentRunStepView;
};

export type SubagentActivity = {
  /** 进行中 run 涉及的子会话 id。 */
  runningChildIds: ReadonlySet<string>;
  /** sessionId → 运行信息（run 列表按新到旧，同一会话取最新一条）。 */
  bySessionId: ReadonlyMap<string, SubagentActivityEntry>;
};

export const EMPTY_SUBAGENT_ACTIVITY: SubagentActivity = {
  runningChildIds: new Set<string>(),
  bySessionId: new Map<string, SubagentActivityEntry>(),
};

export function buildSubagentActivity(runs: readonly SubagentRunView[] | null | undefined): SubagentActivity {
  const runningChildIds = new Set<string>();
  const bySessionId = new Map<string, SubagentActivityEntry>();
  for (const run of runs ?? []) {
    if (!run || typeof run !== "object") continue;
    const active = SUBAGENT_ACTIVE_RUN_STATES.has(run.state);
    for (const step of run.steps ?? []) {
      const sessionId = step?.sessionId;
      if (!sessionId) continue;
      if (active) runningChildIds.add(sessionId);
      if (!bySessionId.has(sessionId)) {
        bySessionId.set(sessionId, { runId: run.id, mode: run.mode, active, step });
      }
    }
  }
  return { runningChildIds, bySessionId };
}
