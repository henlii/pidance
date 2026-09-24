/**
 * 工具定义的显示元数据解析（issue #75）。
 *
 * 背景：`ToolDefinition` 上有两个只影响显示的字段，Web 端此前都没读：
 * - `label`：人类可读名。pi-mcp-adapter 给 `"MCP"`、pi-lsp 给 `"LSP: Diagnostics"`、
 *   pi-observational-memory 给 `"Recall memory evidence"`；我们一律把工具名首字母大写，
 *   于是这些名字显示成 `Mcp` / `Lsp_diagnostics` / `Recall`。
 * - `renderShell: "self"`：工具自带外壳（TUI 里不进默认 `Box`，所以没有宿主的
 *   内边距与状态底色）。我们一律套 Pidance 卡片边框与底色。
 *
 * 来源：扩展对象的 `tools: Map<name, { definition, sourceInfo }>`。查找顺序与 SDK
 * `AgentSession` 一致：内置工具先注册、扩展工具随后 `set`，**后注册者胜**；
 * SDK 自定义工具（Pidance 自己的 send_file 等）没有 label，不需要在这里解析。
 * 扩展加载走 `lib/loaded-extensions.ts` 的共享缓存——与 entry 渲染器、设置页
 * provider 列表共用同一份结果，不重复加载扩展。
 *
 * 边界：
 * - **只读投影**：只读定义里的展示字段，不改工具执行语义，不写任何东西。
 * - 任何异常/非法形状降级为「没有元数据」（调用方回退既有展示），绝不让会话读取失败。
 */

import {
  loadExtensionsForCwd,
  type LoadedExtensionsLoader,
} from "./loaded-extensions";
import type { ToolDisplayMeta } from "./types";

/** 元数据解析器：工具名 → 显示元数据；null 表示没有（调用方回退既有展示）。 */
export type ToolMetaProvider = (toolName: string) => ToolDisplayMeta | null;

export interface ToolMetaProviderOptions {
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
 * 从已加载的扩展里收集 toolName → 显示元数据。
 *
 * 顺序与 SDK 一致：按扩展顺序遍历，**后注册者胜**（SDK 用 Map.set 覆盖同名的前一份）。
 * 非 Map / 非法条目 / 没有任何展示字段的条目一律跳过：没有可展示信息就不产生条目，
 * 调用方据此走既有回退路径。
 */
export function collectToolDisplayMeta(
  extensions: ReadonlyArray<Record<string, unknown>>,
): Map<string, ToolDisplayMeta> {
  const meta = new Map<string, ToolDisplayMeta>();
  for (const extension of extensions) {
    const record = asRecord(extension);
    if (!record) continue;
    const tools = record.tools;
    if (!(tools instanceof Map)) continue;
    for (const [name, entry] of tools as Map<unknown, unknown>) {
      if (typeof name !== "string" || name === "") continue;
      const definition = asRecord(asRecord(entry)?.definition);
      if (!definition) continue;
      const display: ToolDisplayMeta = {};
      const label = definition.label;
      if (typeof label === "string" && label.trim() !== "") display.label = label.trim();
      if (definition.renderShell === "self") display.renderShell = "self";
      if (display.label === undefined && display.renderShell === undefined) continue;
      meta.set(name, display);
    }
  }
  return meta;
}

/**
 * 解析该 (cwd, agentDir) 的工具显示元数据解析器。
 * 加载失败 / 没有任何工具声明展示字段 → null（调用方按「没有元数据」处理）。
 */
export async function resolveToolMetaProvider(
  options: ToolMetaProviderOptions,
): Promise<ToolMetaProvider | null> {
  const loaded = await loadExtensionsForCwd({
    cwd: options.cwd,
    agentDir: options.agentDir,
    loaderFactory: options.loaderFactory,
    bypassCache: options.bypassCache,
  });
  if (!loaded.ok) return null;
  const meta = collectToolDisplayMeta(loaded.value.extensions);
  if (meta.size === 0) return null;
  return (toolName: string) => meta.get(toolName) ?? null;
}
