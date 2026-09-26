"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createCompletionScheduler,
  LOCAL_PLUGIN_COMPLETION,
  pluginCompletionStateForOutcome,
  type CompletionOutcome,
  type CompletionScheduler,
  type PluginCompletionState,
} from "@/lib/completion-request";

/**
 * 插件补全（`ctx.ui.addAutocompleteProvider`，issue #101）在输入区的状态。
 *
 * 只在 `enabled`（有插件注册了 provider）时才发请求：没注册就一次往返都不付，
 * 直接用 Pidance 自己的 `@` 文件补全。
 *
 * 状态用 `PluginCompletionState` 的四态表示（见 lib/completion-request.ts）：
 * - `plugin`：显示插件的候选，选中后用插件的 `applyCompletion` 决定替换区间；
 * - `none`：插件**明确**说没有候选 → 什么都不显示（也不回退我们的文件补全）；
 * - `pending`：在途 → 同样**不显示**本地文件项（插件可能正要说「没有」）；
 * - `local`：没注册 / 失败 / 超时 → 回退我们自己那套文件补全。
 */
export function usePluginCompletion(options: {
  enabled: boolean;
  onLoad: (input: {
    lines: string[];
    cursorLine: number;
    cursorCol: number;
    /**
     * TUI 的 `force` 来自 Tab（显式请求补全）。Web 的 Tab 是**焦点遍历**（刻意留给浏览器，
     * 见 lib/extension-panel-keys.ts），没有等价的显式入口，所以这里恒不传 —— 插件拿到
     * `force: false`，正常输入照常给候选（见 docs/ui-vs-tui.md 的有意分叉）。
     */
    force?: boolean;
    signal: AbortSignal;
  }) => Promise<CompletionOutcome>;
  /** 参数补全的防抖窗口（与命令参数补全一致）。 */
  debounceMs?: number;
  /** 单次请求超时：到点叫停插件的搜索并回退本地补全（见 lib/completion-request.ts）。 */
  timeoutMs?: number;
}): {
  state: PluginCompletionState;
  /** 排一次请求；`null` 表示当前没有触发上下文（会取消在途请求并回到 `local`）。 */
  schedule: (input: { lines: string[]; cursorLine: number; cursorCol: number } | null) => void;
  /** 取消在途请求（Esc 关菜单、输入法开始合成时调用）。 */
  cancel: () => void;
} {
  const { enabled, onLoad, debounceMs = 120, timeoutMs = 800 } = options;
  const [state, setState] = useState<PluginCompletionState>(LOCAL_PLUGIN_COMPLETION);
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;

  const scheduler = useMemo<CompletionScheduler<{ lines: string[]; cursorLine: number; cursorCol: number }>>(
    () => createCompletionScheduler({
      debounceMs,
      timeoutMs,
      request: (input, signal) => onLoadRef.current({ ...input, signal }),
      onOutcome: (outcome, _input, stale) => {
        // 迟到的响应不得覆盖新结果（序号在调度器里保证）。
        if (stale) return;
        setState(pluginCompletionStateForOutcome(outcome));
      },
    }),
    [debounceMs, timeoutMs],
  );

  // 卸载 / 关掉能力时取消在途请求与挂起的计时器（插件侧的原生搜索也随之停下）。
  useEffect(() => () => scheduler.cancel(), [scheduler]);

  const cancel = useCallback(() => {
    scheduler.cancel();
    setState(LOCAL_PLUGIN_COMPLETION);
  }, [scheduler]);

  const schedule = useCallback((input: { lines: string[]; cursorLine: number; cursorCol: number } | null) => {
    if (!input || !enabled) {
      cancel();
      return;
    }
    // 在途态：既不给插件项（还没有），也不给本地文件项（插件可能要说「没有」）。
    setState({ status: "pending" });
    scheduler.schedule(input);
  }, [cancel, enabled, scheduler]);

  return { state, schedule, cancel };
}
