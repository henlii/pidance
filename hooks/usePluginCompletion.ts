"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CompletionItem } from "@/lib/autocomplete-providers";
import {
  createCompletionScheduler,
  decideCompletionDisplay,
  type CompletionOutcome,
  type CompletionScheduler,
} from "@/lib/completion-request";

/**
 * 插件补全（`ctx.ui.addAutocompleteProvider`，issue #101）在输入区的状态。
 *
 * 只在 `enabled`（有插件注册了 provider）时才发请求：没注册就一次往返都不付，
 * 直接用 Pidance 自己的 `@` 文件补全。
 *
 * 三种结果：
 * - `plugin`：显示插件的候选，选中后用插件的 `applyCompletion` 决定替换区间；
 * - `none`：插件**明确**说没有候选 → 不显示（也不回退我们的文件补全）；
 * - `null`（本地）：没注册 / 请求失败 / 链没给出结果 → 用我们自己的文件补全。
 */
export interface PluginCompletionState {
  source: "plugin" | "none";
  items: CompletionItem[];
  prefix: string;
}

export function usePluginCompletion(options: {
  enabled: boolean;
  onLoad: (input: {
    lines: string[];
    cursorLine: number;
    cursorCol: number;
    force?: boolean;
    signal: AbortSignal;
  }) => Promise<CompletionOutcome>;
  /** 参数补全的防抖窗口（与命令参数补全一致）。 */
  debounceMs?: number;
}): {
  result: PluginCompletionState | null;
  /** 排一次请求；`null` 表示当前没有触发上下文（会取消在途请求并清空结果）。 */
  schedule: (input: { lines: string[]; cursorLine: number; cursorCol: number } | null) => void;
} {
  const { enabled, onLoad, debounceMs = 120 } = options;
  const [result, setResult] = useState<PluginCompletionState | null>(null);
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;

  const scheduler = useMemo<CompletionScheduler<{ lines: string[]; cursorLine: number; cursorCol: number }>>(
    () => createCompletionScheduler({
      debounceMs,
      request: (input, signal) => onLoadRef.current({ ...input, signal }),
      onOutcome: (outcome, _input, stale) => {
        // 迟到的响应不得覆盖新结果（序号在调度器里保证）。
        if (stale) return;
        const display = decideCompletionDisplay(outcome);
        if (display.source === "local") {
          setResult(null);
          return;
        }
        setResult({ source: display.source, items: display.items, prefix: display.prefix });
      },
    }),
    [debounceMs],
  );

  // 卸载 / 关掉能力时取消在途请求与挂起的计时器（插件侧的原生搜索也随之停下）。
  useEffect(() => () => scheduler.cancel(), [scheduler]);

  const schedule = useCallback((input: { lines: string[]; cursorLine: number; cursorCol: number } | null) => {
    if (!input || !enabled) {
      scheduler.cancel();
      setResult(null);
      return;
    }
    // 换了输入内容：先把上一次的插件结果丢掉，避免旧候选在新 token 上闪一下
    // （新结果回来之前显示本地文件补全）。
    setResult(null);
    scheduler.schedule(input);
  }, [enabled, scheduler]);

  return { result, schedule };
}
