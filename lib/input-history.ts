/**
 * 输入框历史回溯（↑/↓ 取回上一条消息）。
 *
 * 语义抄终端 TUI 的 editor：内存级、不落盘、不进会话（多标签各记各的，避免互踩）。
 * 关键一条是**草稿暂存**：第一次按 ↑ 时先把当前没发出去的草稿存起来，
 * 一路按 ↓ 回到末尾时要还回来 —— 否则用户按两下 ↑ 再按 ↓，草稿就没了。
 */
export interface InputHistory {
  /** 记录一条成功提交的内容（与上一条完全相同则忽略；空串忽略）。 */
  push(text: string): void;
  /** 取更早一条；返回要填进输入框的文本，null 表示没有更早的（保持不动）。 */
  prev(currentDraft: string): string | null;
  /** 取更晚一条；到头了返回当初暂存的草稿。 */
  next(): string | null;
  /** 提交之后归位：游标回到「正在编辑草稿」状态。 */
  reset(): void;
}

export const INPUT_HISTORY_DEFAULT_LIMIT = 100;

export function createInputHistory(options: { limit?: number } = {}): InputHistory {
  const limit = Number.isFinite(options.limit) && (options.limit as number) > 0
    ? Math.floor(options.limit as number)
    : INPUT_HISTORY_DEFAULT_LIMIT;
  const entries: string[] = [];
  let cursor = -1;
  let stash = "";

  return {
    push(text: string): void {
      const value = String(text ?? "");
      if (value.trim() === "") return;
      if (entries[entries.length - 1] === value) return;
      entries.push(value);
      while (entries.length > limit) entries.shift();
      cursor = -1;
      stash = "";
    },

    prev(currentDraft: string): string | null {
      if (entries.length === 0) return null;
      if (cursor === -1) {
        stash = String(currentDraft ?? "");
        cursor = entries.length - 1;
        return entries[cursor];
      }
      if (cursor === 0) return null;
      cursor -= 1;
      return entries[cursor];
    },

    next(): string | null {
      if (cursor === -1) return null;
      if (cursor >= entries.length - 1) {
        cursor = -1;
        return stash;
      }
      cursor += 1;
      return entries[cursor];
    },

    reset(): void {
      cursor = -1;
      stash = "";
    },
  };
}
