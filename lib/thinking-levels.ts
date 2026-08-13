/**
 * 思考档位：Pidance 配置语义。
 * 仅 thinkingLevelMap[level] === null 表示禁用；省略 = 可用（含 xhigh/max）。
 * 与 Pi getSupportedThinkingLevels「xhigh/max 必须显式写出」不同——
 * 否则会话默认 xhigh 对未写 map 的模型会被钳成 high。
 */

export const EXTENDED_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ExtendedThinkingLevel = (typeof EXTENDED_THINKING_LEVELS)[number];

export function thinkingLevelsFromMap(
  reasoning: boolean,
  map?: Record<string, string | null> | null,
): string[] {
  if (!reasoning) return ["off"];
  return EXTENDED_THINKING_LEVELS.filter((level) => map?.[level] !== null);
}

export type ThinkingMapModel = {
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
};

/** 给 Pi SDK 看的模型：省略的 xhigh/max 补成恒等映射，避免 setThinkingLevel 钳档。 */
export function withPassThroughExtendedThinking<T extends ThinkingMapModel>(model: T): T {
  if (!model.reasoning) return model;
  const src = model.thinkingLevelMap;
  const next: Record<string, string | null> = { ...(src ?? {}) };
  let changed = false;
  for (const level of ["xhigh", "max"] as const) {
    if (!Object.prototype.hasOwnProperty.call(next, level) || next[level] === undefined) {
      next[level] = level;
      changed = true;
    }
  }
  if (!changed && src) return model;
  return { ...model, thinkingLevelMap: next };
}

/** 尽量改原对象，避免无谓 setModel / model_change。失败则返回补丁副本。 */
export function applyPassThroughExtendedThinkingInPlace<T extends ThinkingMapModel>(model: T): T {
  const patched = withPassThroughExtendedThinking(model);
  if (patched === model) return model;
  try {
    (model as ThinkingMapModel).thinkingLevelMap = patched.thinkingLevelMap;
    return model;
  } catch {
    return patched;
  }
}
