/**
 * 插件补全的请求调度（issue #101）：防抖 → 只认最新一次 → 取消上一次。
 *
 * 为什么抽出来：`components/ChatInput.tsx` 里直接写这套时序没法单测（要 DOM + React）。
 * 这里只依赖注入的 `request` / `onOutcome` 与可注入的计时器，所以「连打只发一次」、
 * 「迟到的响应被丢弃」、「被取代的请求真的 abort 了」都能用 `node --test` 覆盖。
 */
import type { CompletionItem } from "./autocomplete-providers";
import { extractAtQuery } from "./file-fuzzy";

/**
 * 词边界（触发字符开启的是「一个词」，词首那个字符决定要不要问插件）。
 *
 * 与 pi-tui 的 `autocompleteSeparatorRegex` 同一套口径（`@earendil-works/pi-tui` 的 utils.js）：
 * 空白，或**CJK 标点**（CJK 文字范围内的标点字符，外加常见全角标点）。只认空格和 Tab 的话
 * `你好，#foo` 这种在 TUI 会触发的输入，在 Web 上词首会被算成 `你` 而永远不触发。
 */
const CJK_BREAK = "[\\p{Script_Extensions=Han}\\p{Script_Extensions=Hiragana}\\p{Script_Extensions=Katakana}\\p{Script_Extensions=Hangul}\\p{Script_Extensions=Bopomofo}]";
const CJK_PUNCTUATION = `(?:(?=\\p{Punctuation})${CJK_BREAK}|[，．：；！？（）［］｛｝“”‘’…—])`;
export const AUTOCOMPLETE_SEPARATOR = new RegExp(`(?:\\s|${CJK_PUNCTUATION})`, "u");

/** 宿主 `completion_suggestions` 返回的结果形状（与适配器的四态一致）。 */
export type CompletionOutcome =
  | { kind: "items"; items: CompletionItem[]; prefix: string }
  | { kind: "empty" }
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "no-provider" }
  | { kind: "error" }
  /** 超时：把插件的搜索叫停，并按失败回退本地（计划里「没注册 / 失败 / 超时」同一档）。 */
  | { kind: "timeout" }
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
 * 插件补全在输入区的状态。
 *
 * `pending` 必须与 `local` 分开：在途期间既不能显示插件的候选（还没有），
 * **也不能**显示我们自己的文件列表 —— 插件明确回 `{ items: [] }` 时那几百毫秒里，
 * 用户会选中并提交一个插件本意要挡掉的候选（issue #101 审查阻断 2）。
 */
export type PluginCompletionState =
  | { status: "local" }
  | { status: "pending" }
  | { status: "none" }
  | { status: "plugin"; items: CompletionItem[]; prefix: string };

/** 初始态：没有插件结果，用我们自己的文件补全（与「没注册 provider」同一表现）。 */
export const LOCAL_PLUGIN_COMPLETION: PluginCompletionState = { status: "local" };

/** 一次结果 → 状态（纯函数，单测覆盖）。 */
export function pluginCompletionStateForOutcome(outcome: CompletionOutcome): PluginCompletionState {
  const display = decideCompletionDisplay(outcome);
  if (display.source === "plugin") {
    return { status: "plugin", items: display.items, prefix: display.prefix };
  }
  if (display.source === "none") return { status: "none" };
  return LOCAL_PLUGIN_COMPLETION;
}

export type CompletionMenuEntry<TFile> =
  | { kind: "plugin"; item: CompletionItem }
  | { kind: "file"; entry: TFile };

/**
 * 菜单里该出现哪些条目。
 *
 * 只有 `plugin`（插件的候选）与 `local`（明确回退到我们自己的文件补全）才给条目；
 * `pending` / `none` 一律为空 —— `none` 是插件**明确**说没有候选，`pending` 是还不知道，
 * 两者都不该让用户提交本地文件项。
 */
export function buildCompletionMenuEntries<TFile>(
  state: PluginCompletionState,
  fileMatches: readonly TFile[],
): CompletionMenuEntry<TFile>[] {
  if (state.status === "plugin") return state.items.map((item) => ({ kind: "plugin" as const, item }));
  if (state.status === "local") return fileMatches.map((entry) => ({ kind: "file" as const, entry }));
  return [];
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
    if (AUTOCOMPLETE_SEPARATOR.test(char)) break;
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
  /**
   * 单次请求的超时（毫秒）：到点 abort 插件的搜索并回 `{ kind: "timeout" }`。
   * 不设的话慢请求会一直停在「在途」态 —— 而计划里超时是要回退本地补全的。
   */
  timeoutMs?: number;
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
  let timeoutTimer: unknown = null;
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

  const clearTimeoutTimer = () => {
    if (timeoutTimer !== null) {
      timers.clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
  };

  const cancel = () => {
    clearTimer();
    clearTimeoutTimer();
    // 作废在途请求：晚到的响应用序号挡住，同时把插件的搜索真的叫停。
    seq += 1;
    controller?.abort();
    controller = null;
    inflight = 0;
  };

  return {
    schedule(input) {
      clearTimer();
      clearTimeoutTimer();
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
        // 一次请求只结算一次：超时先 abort，随后 request 的 rejection 不能再报一遍。
        let settled = false;
        const settle = (outcome: CompletionOutcome) => {
          if (settled) return;
          settled = true;
          clearTimeoutTimer();
          options.onOutcome(outcome, input, mySeq !== seq);
        };
        const timeoutMs = options.timeoutMs ?? 0;
        if (timeoutMs > 0) {
          timeoutTimer = timers.setTimeout(() => {
            timeoutTimer = null;
            myController.abort();
            settle({ kind: "timeout" });
          }, timeoutMs);
        }
        void options
          .request(input, myController.signal)
          .then((outcome) => {
            settle(outcome);
          })
          .catch(() => {
            // 请求本身失败（含 abort）→ 当作「没有插件结果」，调用方回退本地补全。
            settle({ kind: "error" });
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
