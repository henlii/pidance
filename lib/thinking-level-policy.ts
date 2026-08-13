/**
 * 思考深度显示/选择契约（纯函数）。
 *
 * 三层状态：
 * 1. 会话级 thinkingLevel（按钮 ·xxx、ensure 首建）
 * 2. 每模型缓存 serverPrefs[`thinkingLevel.${provider}:${modelId}`]
 * 3. Pi live set_thinking_level（有 host 才发）
 *
 * 无 auto：缺省一律用 settings.json defaultThinkingLevel（由调用方传入 fallback）。
 */

const DEFAULT_FALLBACK = "off";

function namedLevel(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value || value === "auto") return null;
  return value;
}

/** 模型列表行右侧显示的深度：当前行与按钮一致（会话级）；非当前只用该模型缓存。 */
export function listThinkingDisplayLevel(
  cached: string | null | undefined,
  isActive: boolean,
  sessionThinking: string | null | undefined,
  fallback: string = DEFAULT_FALLBACK,
): string {
  if (isActive) {
    return namedLevel(sessionThinking) ?? namedLevel(cached) ?? fallback;
  }
  return namedLevel(cached) ?? fallback;
}

/** 点击模型行时带给 onModelChange 的深度：该模型缓存，否则 settings 默认。 */
export function modelClickThinkingLevel(
  cached: string | null | undefined,
  fallback: string = DEFAULT_FALLBACK,
): string {
  return namedLevel(cached) ?? fallback;
}

/** ensure_session / 新建 body：有具体档位就传，不再传 auto。 */
export function thinkingLevelForEnsureBody(
  level: string | null | undefined,
): string | undefined {
  return namedLevel(level) ?? undefined;
}

/**
 * 引导页（常无 live sid）模型/深度选择：本地状态必须先更新。
 * 返回应写入会话级 thinkingLevel 的值；null 表示不改思考、只改模型。
 */
export function guidePageThinkingUpdate(
  thinkingLevel: string | null | undefined,
): string | null {
  return namedLevel(thinkingLevel);
}
