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

/**
 * 输入框模型按钮上的档位标签。
 *
 * 只有「该会话的权威档位已确认」时才显示：
 * - ready=false（切换中/加载中）→ null，不显示；
 * - ready=true 但 level 为空（切会话瞬间已清空、权威值还没回来）→ null。
 *   不能回落到 fallback：已有会话的 fallback 是 off，会让标签先闪成 off
 *   （用户看到「显示变了、实际没变」），等权威值到达后才纠正。
 * - 引导页（无会话档）由调用方传 fallback = settings 默认，属真实取值。
 */
export function thinkingLabel(
  ready: boolean,
  level: string | null | undefined,
  fallback: string | null | undefined,
): string | null {
  if (!ready) return null;
  return namedLevel(level) ?? (fallback !== null && fallback !== undefined ? namedLevel(fallback) : null);
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

/**
 * 远程思考档是否可以写进当前视图。
 *
 * 磁盘 hydrate 是打开会话的权威落地。热状态 / thinking_level_changed 在用户
 * 尚未改档时不得覆盖已经落地的值——Pi 常把 max/xhigh 误报成 high，
 * 而会话实际仍按磁盘档位发请求。用户改档或代次前进之后，远程值重新可写。
 */
export function shouldAcceptRemoteThinking(input: {
  viewSessionId: string | null;
  targetSessionId: string | null;
  generation: number;
  capturedGeneration: number;
  userTouched: boolean;
  localLevel: string | null;
  remoteLevel: string;
  source: "disk" | "live-hydrate" | "event";
}): boolean {
  if (!input.viewSessionId || input.viewSessionId !== input.targetSessionId) return false;
  if (input.generation !== input.capturedGeneration) return false;
  if (input.source === "disk") return true;
  if (input.userTouched) return true;
  if (input.localLevel && input.localLevel !== input.remoteLevel) return false;
  return true;
}

