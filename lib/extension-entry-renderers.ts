/**
 * 插件自定义 entry / 自定义消息的渲染器解析（issue #71、#76）。
 *
 * 背景：
 * - 自定义 **entry**（`pi.registerEntryRenderer(customType, renderer)`，JSONL 里
 *   `type:"custom"`）在 Web 里原本完全没有落点：会话读取时被当成「未知 customType」
 *   丢掉，于是 supervisor reply、watchdog warning 这类内容在时间线里整段消失
 *   （原生 TUI 会渲染它们）。
 * - 自定义 **消息**（`pi.registerMessageRenderer(customType, renderer)`，JSONL 里
 *   `type:"custom_message"`）在实时路径上有渲染（宿主在 message_start/end 里调
 *   渲染器），但**读盘路径没有**：刷新/重开会话后退回 `content` 原文，而 TUI 重开
 *   会照样重画（issue #76）。这里补上读盘侧，两条路径共用同一批渲染器。
 *
 * 来源：扩展对象的 `entryRenderers` / `messageRenderers`（都是 `Map<customType, renderer>`），
 * 查找顺序与 SDK `ExtensionRunner.getEntryRenderer` / `getMessageRenderer` 一致
 * （按扩展顺序，先注册者胜）。扩展加载走 `lib/loaded-extensions.ts` 的共享缓存——
 * 与设置页的 provider 列表共用同一份结果，不重复加载扩展。
 *
 * 边界：
 * - **只读投影**：返回的解析器只渲染，不写 JSONL、不执行会话动作。
 * - 渲染失败（无渲染器 / 抛出 / 返回 undefined / 输出非法）一律返回 null：
 *   entry 侧调用方据此**不显示**该项（插件载荷不能当文本糊出来），消息侧退回原文
 *   （消息本来就有 content，不丢信息）。
 * - 加载扩展失败同样降级为 null，绝不让会话读取整体失败。
 */

import { loadPiTheme, renderCustomEntryLines, renderCustomMessageLines } from "./tui-render-bridge";
import {
  loadExtensionsForCwd,
  type LoadedExtensionsLoader,
} from "./loaded-extensions";
import type { EntryLinesResolver, MessageLinesResolver } from "./session-reader";

/** entry 渲染行解析器：拿到 entry → 渲染行；null 表示不显示。 */
export type EntryLinesProvider = EntryLinesResolver;

/** 自定义消息渲染行解析器：拿到消息 → 渲染行；null 表示退回原文。 */
export type MessageLinesProvider = MessageLinesResolver;

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
 * 从已加载的扩展里收集 customType → 自定义消息渲染器。
 * 来源与查找顺序同 `collectEntryRenderers`，只是换 `messageRenderers` 表。
 */
export function collectMessageRenderers(
  extensions: ReadonlyArray<Record<string, unknown>>,
): Map<string, unknown> {
  const renderers = new Map<string, unknown>();
  for (const extension of extensions) {
    const table = extension.messageRenderers;
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

async function loadExtensions(
  options: EntryLinesProviderOptions,
): Promise<ReadonlyArray<Record<string, unknown>> | null> {
  const loaded = await loadExtensionsForCwd({
    cwd: options.cwd,
    agentDir: options.agentDir,
    loaderFactory: options.loaderFactory,
    bypassCache: options.bypassCache,
  });
  return loaded.ok ? loaded.value.extensions : null;
}

/**
 * 解析该 (cwd, agentDir) 的 entry 渲染行解析器。
 * 加载失败 / 没有任何 entry 渲染器 → null（调用方按「不投影」处理）。
 */
export async function resolveEntryLinesProvider(
  options: EntryLinesProviderOptions,
): Promise<EntryLinesProvider | null> {
  const extensions = await loadExtensions(options);
  if (!extensions) return null;
  const renderers = collectEntryRenderers(extensions);
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

/**
 * 解析该 (cwd, agentDir) 的自定义消息渲染行解析器（issue #76）。
 * 加载失败 / 没有消息渲染器 / 主题不可用 → null（调用方按「退回原文」处理）。
 *
 * 宽度用 `tui-render-bridge` 的默认 RENDER_WIDTH：读盘侧没有视口信息，而实时侧在
 * #70 上报前用的也是这个值——历史渲染与「没有上报过的实时渲染」一致。
 */
export async function resolveMessageLinesProvider(
  options: EntryLinesProviderOptions,
): Promise<MessageLinesProvider | null> {
  const extensions = await loadExtensions(options);
  if (!extensions) return null;
  const renderers = collectMessageRenderers(extensions);
  if (renderers.size === 0) return null;
  const theme = loadPiTheme();
  if (!theme) return null;
  return (message: unknown) => {
    const customType = asRecord(message)?.customType;
    if (typeof customType !== "string") return null;
    const renderer = renderers.get(customType);
    if (!renderer) return null;
    const lines = renderCustomMessageLines(renderer, message, theme);
    return lines && lines.length > 0 ? lines : null;
  };
}
