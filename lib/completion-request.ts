/**
 * 插件补全的请求调度（issue #101）：防抖 → 只认最新一次 → 取消上一次。
 *
 * 为什么抽出来：`components/ChatInput.tsx` 里直接写这套时序没法单测（要 DOM + React）。
 * 这里只依赖注入的 `request` / `onOutcome` 与可注入的计时器，所以「连打只发一次」、
 * 「迟到的响应被丢弃」、「被取代的请求真的 abort 了」都能用 `node --test` 覆盖。
 */
import type { CompletionItem } from "./autocomplete-providers";
import { extractAtQuery } from "./file-fuzzy";

/** 宿主 `completion_suggestions` 返回的结果形状（与适配器的四态一致）。 */
export type CompletionOutcome =
  | { kind: "items"; items: CompletionItem[]; prefix: string }
  | { kind: "empty" }
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "no-provider" }
  | { kind: "error" }
  | { kind: "unavailable" }
  | { kind: "superseded" }
  | { kind: "invalid-request" };

/**
 * 这次结果该显示什么。
 *
 * - `items`：插件给了候选 → 用插件的（插件自己决定要不要落到下层补全）。
 * - `empty`：插件**明确**说没有候选 → 什么都不显示。
 *   **不回退**我们自己的文件补全：否则插件刻意给的空结果会被我们盖掉
 *   （例如插件按它的配置决定此刻不给 `@` 补全）。
 * - 其余（链没注册 / 抛错 / 形状坏 / 请求失败 / 结果被取代 / 旧 Host 不认识）→ `local`：
 *   回退到 Pidance 自己的文件补全。这与 TUI 里「包装 provider 返回 null 时落到基础
 *   provider」是同一语义（`@ff-labs/pi-fff` 在 FFF 不可用或没命中时正是回退给下层）。
 */
export function decideCompletionDisplay(outcome: CompletionOutcome): {
  source: "plugin" | "local" | "none";
  items: CompletionItem[];
  prefix: string;
} {
  if (outcome.kind === "items") {
    return { source: "plugin", items: outcome.items, prefix: outcome.prefix };
  }
  if (outcome.kind === "empty") return { source: "none", items: [], prefix: "" };
  return { source: "local", items: [], prefix: "" };
}

/**
 * 这次输入该不该问插件补全。
 *
 * 两条都要成立：注册过 provider（`providerCount > 0`，否则**一次往返都不付**，直接用我们
 * 自己的文件补全），以及光标处确实有触发上下文（`@` token，或插件声明的触发字符）。
 */
export function buildCompletionRequest(input: {
  text: string;
  /** 光标位置（textarea 的 selectionStart）。 */
  cursor: number;
  /** 已注册的 provider 数量（状态投影来的门槛）。 */
  providerCount: number;
  /** provider 声明的触发字符并集。 */
  triggerCharacters: readonly string[];
  /** 没有 cwd 时 `@` 那条路不成立（与本地 @ 菜单同一口径）。 */
  cwd: string | null | undefined;
}): { lines: string[]; cursorLine: number; cursorCol: number } | null {
  if (input.providerCount <= 0) return null;
  const cursor = Math.max(0, Math.min(input.cursor, input.text.length));
  const before = input.text.slice(0, cursor);
  const lineStart = before.lastIndexOf("\n") + 1;
  const atToken = input.cwd ? extractAtQuery(before) : null;
  // 触发字符开启的是**一个词**，光标随后落在词中间：所以要找当前词的起点，
  // 而不是只看光标前那一个字符（`/mc` 这种输入，光标前是 `c` 而词首才是 `/`）。
  let tokenStart = lineStart;
  for (let index = cursor - 1; index >= lineStart; index -= 1) {
    const char = input.text[index] ?? "";
    if (char === " " || char === "\t") break;
    tokenStart = index;
  }
  const triggerChar = tokenStart < cursor ? input.text[tokenStart] ?? "" : "";
  const triggered = atToken !== null || (triggerChar !== "" && input.triggerCharacters.includes(triggerChar));
  if (!triggered) return null;
  const cursorLine = before.split("\n").length - 1;
  return { lines: input.text.split("\n"), cursorLine, cursorCol: cursor - lineStart };
}

export interface CompletionSchedulerOptions<TInput> {
  /** 连续输入时的合并窗口（毫秒）。 */
  debounceMs: number;
  request: (input: TInput, signal: AbortSignal) => Promise<CompletionOutcome>;
  /** 结果回调：`stale` 为真表示它已被更晚的一次请求取代（调用方应丢弃）。 */
  onOutcome: (outcome: CompletionOutcome, input: TInput, stale: boolean) => void;
  /** 计时器注入（单测用假计时器）。 */
  timers?: {
    setTimeout: (handler: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}

export interface CompletionScheduler<TInput> {
  /** 排一次请求（同一窗口内重复调用只保留最后一次）。 */
  schedule(input: TInput): void;
  /** 取消在途请求与挂起的计时器（关菜单 / 卸载时调用）。 */
  cancel(): void;
  /** 在途请求数（单测用：验证上一次真的被 abort 掉了）。 */
  inflightCount(): number;
  /** 已发出的请求次数（单测用：验证防抖确实合并了连打）。 */
  sentCount(): number;
}

export function createCompletionScheduler<TInput>(
  options: CompletionSchedulerOptions<TInput>,
): CompletionScheduler<TInput> {
  const timers = options.timers ?? {
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let timer: unknown = null;
  let controller: AbortController | null = null;
  let seq = 0;
  let inflight = 0;
  let sent = 0;

  const clearTimer = () => {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  };

  const cancel = () => {
    clearTimer();
    // 作废在途请求：晚到的响应用序号挡住，同时把插件的搜索真的叫停。
    seq += 1;
    controller?.abort();
    controller = null;
    inflight = 0;
  };

  return {
    schedule(input) {
      clearTimer();
      // 新的一次排进来就作废上一次：避免旧候选在新输入上闪一下。
      seq += 1;
      controller?.abort();
      controller = null;
      const mySeq = seq;
      timer = timers.setTimeout(() => {
        timer = null;
        const myController = new AbortController();
        controller = myController;
        inflight += 1;
        sent += 1;
        void options
          .request(input, myController.signal)
          .then((outcome) => {
            options.onOutcome(outcome, input, mySeq !== seq);
          })
          .catch(() => {
            // 请求本身失败（含 abort）→ 当作「没有插件结果」，调用方回退本地补全。
            options.onOutcome({ kind: "error" }, input, mySeq !== seq);
          })
          .finally(() => {
            inflight -= 1;
          });
      }, options.debounceMs);
    },
    cancel,
    inflightCount: () => inflight,
    sentCount: () => sent,
  };
}
