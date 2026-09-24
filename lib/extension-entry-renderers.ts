/**
 * 插件自定义 entry 的渲染器解析（issue #71）。
 *
 * 背景：插件通过 `pi.registerEntryRenderer(customType, renderer)` 注册的自定义 entry
 * （**不是**自定义消息）在 Web 里原本完全没有落点：JSONL 里有这条记录，会话读取时
 * 被当成「未知 customType」丢掉，于是 supervisor reply、watchdog warning 这类内容
 * 在时间线里整段消失（原生 TUI 会渲染它们）。
 *
 * 来源：扩展对象的 `entryRenderers: Map<customType, EntryRenderer>`，与 SDK
 * `ExtensionRunner.getEntryRenderer` 的查找顺序一致（按扩展顺序，先注册者胜）。
 * 扩展加载走 `lib/loaded-extensions.ts` 的共享缓存——与设置页的 provider 列表
 * 共用同一份结果，不重复加载扩展。
 *
 * 边界：
 * - **只读投影**：返回的解析器只渲染，不写 JSONL、不执行会话动作。
 * - 渲染失败（无渲染器 / 抛出 / 返回 undefined / 输出非法）一律返回 null，
 *   调用方据此**不显示**该项，而不是把插件私有载荷当文本糊出来。
 * - 加载扩展失败同样降级为 null（保持历史行为：未知 customType 不投影），
 *   绝不让会话读取整体失败。
 */

import { loadPiTheme, renderCustomEntryLines } from "./tui-render-bridge";
import {
  loadExtensionsForCwd,
  type LoadedExtensionsLoader,
} from "./loaded-extensions";
import type { EntryLinesResolver } from "./session-reader";

/** 渲染行解析器：拿到 entry → 渲染行；null 表示不显示。 */
export type EntryLinesProvider = EntryLinesResolver;

export interface EntryLinesProviderOptions {
  cwd: string;
  agentDir?: string;
  /** 注入加载器（测试不加载真实扩展）。 */
  loaderFactory?: (cwd: string, agentDir: string | undefined) => LoadedExtensionsLoader;
  /** 跳过缓存（内部/测试用）。 */
  bypassCache?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 从已加载的扩展里收集 customType → 渲染器。
 *
 * 查找顺序与 SDK `getEntryRenderer` 一致：按扩展顺序，先注册者胜。
 * 非 Map / 非法条目一律跳过（扩展写坏了不能让整个会话读不出来）。
 */
export function collectEntryRenderers(
  extensions: ReadonlyArray<Record<string, unknown>>,
): Map<string, unknown> {
  const renderers = new Map<string, unknown>();
  for (const extension of extensions) {
    const table = extension.entryRenderers;
    if (!(table instanceof Map)) continue;
    for (const [customType, renderer] of table as Map<unknown, unknown>) {
      if (typeof customType !== "string" || customType === "") continue;
      if (typeof renderer !== "function") continue;
      if (renderers.has(customType)) continue;
      renderers.set(customType, renderer);
    }
  }
  return renderers;
}

/**
 * 解析该 (cwd, agentDir) 的 entry 渲染行解析器。
 * 加载失败 / 没有任何 entry 渲染器 → null（调用方按「不投影」处理）。
 */
export async function resolveEntryLinesProvider(
  options: EntryLinesProviderOptions,
): Promise<EntryLinesProvider | null> {
  const loaded = await loadExtensionsForCwd({
    cwd: options.cwd,
    agentDir: options.agentDir,
    loaderFactory: options.loaderFactory,
    bypassCache: options.bypassCache,
  });
  if (!loaded.ok) return null;
  const renderers = collectEntryRenderers(loaded.value.extensions);
  if (renderers.size === 0) return null;
  const theme = loadPiTheme();
  if (!theme) return null;
  return (entry: unknown) => {
    const customType = asRecord(entry)?.customType;
    if (typeof customType !== "string") return null;
    const renderer = renderers.get(customType);
    if (!renderer) return null;
    const lines = renderCustomEntryLines(renderer, entry, theme);
    return lines && lines.length > 0 ? lines : null;
  };
}
