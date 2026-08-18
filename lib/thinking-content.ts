/**
 * 思考块正文提取与洪水通道判定。
 * 不同供应商把正文放在 thinking / text / reasoning，签名也不一样。
 */

export type ThinkingTextSource = {
  type?: unknown;
  thinking?: unknown;
  text?: unknown;
  reasoning?: unknown;
  thinkingSignature?: unknown;
};

export function getThinkingText(block: ThinkingTextSource): string {
  for (const value of [block.thinking, block.text, block.reasoning]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

/**
 * openai-completions（如 deepseek 官方）把 reasoning_content 整段流式塞进 thinking。
 * 只有这种签名在 message_update 里剥正文；其它通道照常下发。
 */
export function isFloodStreamingThinking(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  const source = block as ThinkingTextSource;
  return source.type === "thinking" && source.thinkingSignature === "reasoning_content";
}

/** 剥洪水通道的可读正文，保留块结构与签名。 */
export function stripFloodStreamingThinking(block: unknown): unknown {
  if (!isFloodStreamingThinking(block)) return block;
  const source = block as Record<string, unknown>;
  const next = { ...source };
  let changed = false;
  for (const key of ["thinking", "text", "reasoning"] as const) {
    if (typeof next[key] === "string" && (next[key] as string).length > 0) {
      next[key] = "";
      changed = true;
    }
  }
  return changed ? next : block;
}
