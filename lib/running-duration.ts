/**
 * 运行时长显示纯逻辑（P1-5 running 静态圆点 + 轮次计时）。
 *
 * - splitRunningDuration：把毫秒拆成 小时/分钟/秒；
 * - formatRunningDuration：按量级选择 i18n 键（<1m → 秒；<1h → 分+秒；≥1h → 时+分）；
 * - trackRunningStartedAt：running id 集合的「首次见到时间」跟踪（first-seen 语义）。
 *   刷新后 SSE 重新建立时集合只有 id、无真实开始时间，首次见到的时刻即近似开始；
 *   会话从集合消失后移除记录；下次再出现视为新运行（重新记时）。
 * - mergeRunningStartedAt：服务端本轮执行 startedAt 覆盖 first-seen（计时=发送→结束）。
 */
import type { TranslationKey } from "./locales/en";

export interface RunningDurationParts {
  hours: number;
  minutes: number;
  seconds: number;
}

/** 纯拆分：毫秒 → {hours, minutes, seconds}（向下取整；负值按 0）。 */
export function splitRunningDuration(elapsedMs: number): RunningDurationParts {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return { hours, minutes, seconds };
}

export type DurationTranslator = (key: TranslationKey, values?: Record<string, unknown>) => string;

/**
 * 格式化运行时长文本：
 * - < 1 分钟 → 「45s」
 * - < 1 小时 → 「2m 14s」
 * - ≥ 1 小时 → 「1h 05m」（小时 + 分钟，秒不再重要）
 * 测试中传入假 t（返回 key 本身）即可断言键选择。
 */
export function formatRunningDuration(elapsedMs: number, t: DurationTranslator): string {
  const { hours, minutes, seconds } = splitRunningDuration(elapsedMs);
  if (hours > 0) {
    return t("sidebar_runningHoursMinutes", { h: hours, m: minutes });
  }
  if (minutes > 0) {
    return t("sidebar_runningMinutesSeconds", { m: minutes, s: seconds });
  }
  return t("sidebar_runningSeconds", { s: seconds });
}

/**
 * first-seen 跟踪：给定当前 running id 集合与上轮记录，
 * 新增 id 以 now 作为首次见到时间；仍在集合的 id 保留原记录；
 * 已离开集合的 id 移除（下次再运行重新记时）。
 * 返回新 Map；无变化时返回原引用（便于组件跳过 setState）。
 */
export function trackRunningStartedAt(
  prev: ReadonlyMap<string, number>,
  ids: readonly string[],
  now: number,
): Map<string, number> {
  const next = new Map<string, number>();
  let changed = prev.size !== ids.length;
  for (const id of ids) {
    const existing = prev.get(id);
    if (existing !== undefined) {
      next.set(id, existing);
    } else {
      next.set(id, now);
      changed = true;
    }
  }
  return changed ? next : prev as Map<string, number>;
}

function serverStartedAtFor(
  serverStartedAt: ReadonlyMap<string, number> | undefined,
  id: string,
): number | undefined {
  const value = serverStartedAt?.get(id);
  return typeof value === "number" ? value : undefined;
}

/**
 * 侧栏计时：服务端本轮执行开始时间为权威；没有服务端值时才用 first-seen。
 * 离开 running 集合的 id 移除。无变化返回原引用。
 */
export function mergeRunningStartedAt(
  prev: ReadonlyMap<string, number>,
  ids: readonly string[],
  serverStartedAt: ReadonlyMap<string, number> | undefined,
  now: number,
): Map<string, number> {
  const next = new Map<string, number>();
  let changed = prev.size !== ids.length;
  for (const id of ids) {
    const value = serverStartedAtFor(serverStartedAt, id) ?? prev.get(id) ?? now;
    if (prev.get(id) !== value) changed = true;
    next.set(id, value);
  }
  return changed ? next : prev as Map<string, number>;
}
