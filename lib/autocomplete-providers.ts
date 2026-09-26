/**
 * 插件自动补全（`ctx.ui.addAutocompleteProvider`）的 provider 链 —— issue #101。
 *
 * 为什么单独一层：pi-tui 的补全是**同步**的（编辑器拿到 provider 直接问），而 Web 的输入区
 * 在浏览器里，插件代码在服务端。所以这里只做「链的组装 + 返回值归一化」这部分**纯逻辑**
 * （可单测、不 import SDK），由适配器持有、宿主按命令调用、客户端按触发字符驱动。
 *
 * 与 SDK 的 `setupAutocompleteProvider`（`dist/modes/interactive/interactive-mode.js`）对齐：
 * 每个 factory 拿到**上一个 provider**并返回新的，`triggerCharacters` 取**并集**。
 *
 * 基础 provider（链的底）是 Pidance 自己的等价物：TUI 的底是 `CombinedAutocompleteProvider`
 * （斜杠命令 + `@` 文件路径）。Web 端的 `@` 文件补全在**客户端**（`lib/file-fuzzy.ts` +
 * `components/ChatInput.tsx`），服务端这层没有候选可给，所以基础 provider 的 `getSuggestions`
 * 返回 `null`（= 「我这层没有」），由客户端回退到它自己的文件补全 —— 与 TUI 里
 * 包装 provider 返回 null 时落到基础 provider 的语义一致。`applyCompletion` 则必须实现成
 * **通用的前缀替换**：插件的包装 provider 常常把 `applyCompletion` 直接转发给下层
 * （`@ff-labs/pi-fff` 就是），下层是空实现的话，插件自己的候选就永远应用不上。
 */

/** 与 pi-tui 的 `AutocompleteItem` 同形的纯数据版本（这一层不 import pi-tui）。 */
export interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

/** 与 pi-tui 的 `AutocompleteSuggestions` 同形。 */
export interface CompletionSuggestions {
  items: CompletionItem[];
  /** 要替换掉的、光标前的这段文本（长度决定替换区间）。 */
  prefix: string;
}

export interface CompletionSuggestionOptions {
  signal: AbortSignal;
  force?: boolean;
}

export interface CompletionProvider {
  /** 会在词边界自然触发这个 provider 的字符（并集会写回最终 provider）。 */
  triggerCharacters?: string[];
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: CompletionSuggestionOptions,
  ): Promise<CompletionSuggestions | null>;
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: CompletionItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number };
  shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

/** `addAutocompleteProvider` 收到的工厂形状。 */
export type CompletionProviderFactory = (current: CompletionProvider) => CompletionProvider;

/**
 * 链底：没有候选，但**能应用**候选。
 *
 * `getSuggestions` 恒 `null` —— 候选由客户端的文件补全负责（见文件头）。
 * `applyCompletion` 按前缀长度做替换（与 `CombinedAutocompleteProvider` 同一套：
 * 光标前 `prefix.length` 个字符换成 `item.value`），这样把任务转交给下层的插件
 * （pi-fff 的 `applyCompletion` 就是直接 `return current.applyCompletion(...)`）也能工作。
 */
export function createBaseCompletionProvider(): CompletionProvider {
  return {
    getSuggestions: () => Promise.resolve(null),
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const currentLine = lines[cursorLine] ?? "";
      const removeLength = typeof prefix === "string" ? prefix.length : 0;
      const from = Math.max(0, cursorCol - removeLength);
      const nextLine = currentLine.slice(0, from) + item.value + currentLine.slice(cursorCol);
      return {
        lines: [...lines.slice(0, cursorLine), nextLine, ...lines.slice(cursorLine + 1)],
        cursorLine,
        cursorCol: from + item.value.length,
      };
    },
    shouldTriggerFileCompletion: () => true,
  };
}

/** 把候选归一化：丢掉没有 value 的条目，label 缺失时退回 value（与命令参数补全同一口径）。 */
export function normalizeCompletionItems(value: unknown): CompletionItem[] {
  if (!Array.isArray(value)) return [];
  const items: CompletionItem[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as { value?: unknown; label?: unknown; description?: unknown };
    if (typeof record.value !== "string" || record.value === "") continue;
    const label = typeof record.label === "string" && record.label !== "" ? record.label : record.value;
    items.push({
      value: record.value,
      label,
      ...(typeof record.description === "string" && record.description !== ""
        ? { description: record.description }
        : {}),
    });
  }
  return items;
}

/**
 * 链的返回值 → 三态。
 *
 * - `"none"`：`null` / `undefined`，链说「我这层没有」→ 客户端回退到自己的文件补全
 *   （TUI 里包装 provider 返回 null 时落到基础 provider 的同一语义；pi-fff 在 FFF 不可用或
 *   没命中的时候正是回退给下层）。
 * - `"empty"`：`{ items: [] }`，**明确**「没有候选」→ 不回退（否则会被我们自己的文件补全
 *   盖掉插件刻意给出的空结果）。
 * - `"items"`：有候选。
 * - `"invalid"`：形状不对（插件 bug）→ 当作失败，客户端回退。
 */
export type CompletionSuggestionsOutcome =
  | { kind: "none" }
  | { kind: "empty" }
  | { kind: "items"; items: CompletionItem[]; prefix: string }
  | { kind: "invalid" };

export function classifyCompletionSuggestions(result: unknown): CompletionSuggestionsOutcome {
  if (result === null || result === undefined) return { kind: "none" };
  if (typeof result !== "object") return { kind: "invalid" };
  const record = result as { items?: unknown; prefix?: unknown };
  if (!Array.isArray(record.items)) return { kind: "invalid" };
  const prefix = typeof record.prefix === "string" ? record.prefix : "";
  const items = normalizeCompletionItems(record.items);
  // `items` 非空但归一化后一个都不剩（没有 value）→ 当失败处理，别当成「明确没有候选」：
  // 那是插件输出坏了，此时回退到我们的文件补全比什么都不显示更有用。
  if (items.length === 0) {
    return record.items.length === 0 ? { kind: "empty" } : { kind: "invalid" };
  }
  return { kind: "items", items, prefix };
}

/** 链的 `applyCompletion` 返回值归一化；形状不对返回 null（调用方不动文本）。 */
export function normalizeAppliedCompletion(
  result: unknown,
): { lines: string[]; cursorLine: number; cursorCol: number } | null {
  if (typeof result !== "object" || result === null) return null;
  const record = result as { lines?: unknown; cursorLine?: unknown; cursorCol?: unknown };
  if (!Array.isArray(record.lines) || !record.lines.every((line) => typeof line === "string")) return null;
  if (typeof record.cursorLine !== "number" || typeof record.cursorCol !== "number") return null;
  if (!Number.isFinite(record.cursorLine) || !Number.isFinite(record.cursorCol)) return null;
  const cursorLine = Math.trunc(record.cursorLine);
  if (cursorLine < 0 || cursorLine >= record.lines.length) return null;
  const line = record.lines[cursorLine] as string;
  if (record.cursorCol < 0 || record.cursorCol > line.length) return null;
  return { lines: record.lines as string[], cursorLine, cursorCol: Math.trunc(record.cursorCol) };
}

/**
 * 依次包裹 + `triggerCharacters` 并集（对齐 SDK 的 `setupAutocompleteProvider`）。
 *
 * 工厂抛错（或返回非对象）时**跳过这一个**并继续用上一个：一个坏插件不该让整个补全链断掉。
 */
export function buildCompletionChain(wrappers: readonly CompletionProviderFactory[]): {
  provider: CompletionProvider;
  triggerCharacters: string[];
  /** 组装时跳过的工厂个数（诊断用，不进 UI）。 */
  skipped: number;
} {
  let provider = createBaseCompletionProvider();
  const triggerCharacters: string[] = [];
  let skipped = 0;
  for (const wrap of wrappers) {
    let next: unknown;
    try {
      next = wrap(provider);
    } catch {
      skipped += 1;
      continue;
    }
    if (typeof next !== "object" || next === null) {
      skipped += 1;
      continue;
    }
    provider = next as CompletionProvider;
    for (const char of provider.triggerCharacters ?? []) {
      if (typeof char === "string" && char !== "") triggerCharacters.push(char);
    }
  }
  if (triggerCharacters.length > 0) {
    provider = { ...provider, triggerCharacters: [...new Set(triggerCharacters)] };
  }
  return { provider, triggerCharacters: [...new Set(triggerCharacters)], skipped };
}
