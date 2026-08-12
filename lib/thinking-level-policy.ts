/**
 * 思考深度显示/选择契约（纯函数）。
 *
 * 三层状态：
 * 1. 会话级 thinkingLevel（按钮 ·xxx、ensure 首建）
 * 2. 每模型缓存 serverPrefs[`thinkingLevel.${provider}:${modelId}`]
 * 3. Pi live set_thinking_level（有 host 才发）
 *
 * 本模块只约束 1↔2 的 UI 选择与 ensure 载荷，避免列表串模型、引导页选不中。
 */

/** 模型列表行右侧显示的深度：非当前模型禁止回退会话级。 */
export function listThinkingDisplayLevel(
  cached: string | null | undefined,
  isActive: boolean,
  sessionThinking: string | null | undefined,
): string {
  if (typeof cached === "string" && cached) return cached;
  if (isActive) return sessionThinking && sessionThinking.length > 0 ? sessionThinking : "auto";
  return "auto";
}

/** 点击模型行时带给 onModelChange 的深度：只用该模型缓存，无则 auto。 */
export function modelClickThinkingLevel(cached: string | null | undefined): string {
  return typeof cached === "string" && cached ? cached : "auto";
}

/** ensure_session / 新建 body 是否附带 thinkingLevel（auto 表示用 settings 默认，不传）。 */
export function thinkingLevelForEnsureBody(
  level: string | null | undefined,
): string | undefined {
  if (typeof level !== "string" || !level || level === "auto") return undefined;
  return level;
}

/**
 * 引导页（常无 live sid）模型/深度选择：本地状态必须先更新。
 * 返回应写入会话级 thinkingLevel 的值；null 表示不改思考、只改模型。
 */
export function guidePageThinkingUpdate(
  thinkingLevel: string | null | undefined,
): string | null {
  if (thinkingLevel == null || thinkingLevel === "") return null;
  return thinkingLevel;
}
