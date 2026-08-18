/**
 * 把各种供应商的思考形态收成统一的 thinking 块，并从正文里拆出 <think>。
 * 只做投影，不改展开/折叠。
 */

export type ThinkingTextSource = {
  type?: unknown;
  thinking?: unknown;
  text?: unknown;
  reasoning?: unknown;
  deferred?: unknown;
};

export type DisplayContentBlock = {
  type: string;
  thinking?: string;
  text?: string;
  reasoning?: unknown;
  deferred?: boolean;
};

export type DisplayBlockItem = {
  block: DisplayContentBlock;
  sourceIndex: number;
};

export function getThinkingText(block: ThinkingTextSource): string {
  for (const value of [block.thinking, block.text, block.reasoning]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

export function isThinkingLikeType(type: unknown): boolean {
  return type === "thinking" || type === "reasoning" || type === "redacted_thinking";
}

export function toThinkingBlock(block: ThinkingTextSource): DisplayContentBlock {
  const next: DisplayContentBlock = {
    ...(block as DisplayContentBlock),
    type: "thinking",
    thinking: getThinkingText(block),
  };
  if (block.deferred === true) next.deferred = true;
  return next;
}

const CLOSED_THINK_RE = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
const OPEN_THINK_RE = /<think(?:ing)?>/i;

/** 把正文里的 <think>/<thinking> 拆成 thinking + 剩余 text。未闭合标签视为仍在思考（流式）。 */
export function splitTextByThinkTags(text: string): Array<{ type: "thinking" | "text"; value: string }> {
  const parts: Array<{ type: "thinking" | "text"; value: string }> = [];
  let last = 0;
  CLOSED_THINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CLOSED_THINK_RE.exec(text)) !== null) {
    if (match.index > last) parts.push({ type: "text", value: text.slice(last, match.index) });
    parts.push({ type: "thinking", value: match[1] ?? "" });
    last = match.index + match[0].length;
  }
  const rest = text.slice(last);
  const open = OPEN_THINK_RE.exec(rest);
  if (open && open.index !== undefined) {
    if (open.index > 0) parts.push({ type: "text", value: rest.slice(0, open.index) });
    parts.push({ type: "thinking", value: rest.slice(open.index + open[0].length) });
  } else if (rest.length > 0) {
    parts.push({ type: "text", value: rest });
  }
  return parts;
}

/**
 * 渲染投影：思考类 type 收成 thinking；正文里的 think 标签拆出思考块。
 * sourceIndex 指向原始块，供历史 deferred 按需加载。
 */
export function projectDisplayBlocks(blocks: readonly DisplayContentBlock[]): DisplayBlockItem[] {
  const out: DisplayBlockItem[] = [];
  blocks.forEach((block, sourceIndex) => {
    if (isThinkingLikeType(block.type)) {
      out.push({ block: toThinkingBlock(block), sourceIndex });
      return;
    }
    if (block.type === "text" && typeof block.text === "string" && OPEN_THINK_RE.test(block.text)) {
      OPEN_THINK_RE.lastIndex = 0;
      for (const part of splitTextByThinkTags(block.text)) {
        if (part.type === "thinking") {
          out.push({ block: { type: "thinking", thinking: part.value }, sourceIndex });
        } else if (part.value.length > 0) {
          out.push({ block: { ...block, type: "text", text: part.value }, sourceIndex });
        }
      }
      return;
    }
    out.push({ block, sourceIndex });
  });
  return out;
}
