/**
 * provider-error — 识别「上游拒绝请求但没有给出原因」的错误。
 *
 * 背景：Pi SDK 的上下文溢出判定是文本正则（@earendil-works/pi-ai 的
 * OVERFLOW_PATTERNS），其中「无 body 的 4xx」一条带 `^` 锚定。Responses 路径会把上游
 * 错误包成 `OpenAI API error (400): 400 status code (no body)`，前缀导致该规则不命中，
 * 于是 SDK 不会走「压缩后重试」的恢复分支，同一个超限请求会被反复重发。
 *
 * 本模块只做分类，不触发任何动作：调用方（UI）据此给出提示与手动压缩入口。
 * 401/403/404/429 语义明确（凭证 / 路由 / 限流），一律不归入此类。
 */

// 标记后面不能紧跟单词（`(no body)` / `no body` 命中，`no body allowed here` 这类叙述句不命中）
const BODYLESS = /(?:no body|no content|empty body)(?!\s*\w)/i;
const UNEXPLAINED_STATUSES = new Set([400, 413, 422]);

/** 从错误文本里取 HTTP 状态码，取不到返回 null。 */
function parseUpstreamStatus(text: string): number | null {
  const patterns = [/status code (\d{3})/i, /API error \((\d{3})\)/i, /\b([45]\d{2})\b/];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * 是否为「上游拒绝且未返回原因」的错误：无 body 的 400 / 413 / 422。
 * 只表示「无法从响应判断原因」，不推断具体成因。
 */
export function isUnexplainedUpstreamRejection(errorMessage: string): boolean {
  const text = (errorMessage ?? "").trim();
  if (!text || !BODYLESS.test(text)) return false;
  const status = parseUpstreamStatus(text);
  return status !== null && UNEXPLAINED_STATUSES.has(status);
}
