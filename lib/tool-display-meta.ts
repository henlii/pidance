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
 * 来源：**只认扩展声明的定义**——活路径查会话的 `ExtensionRunner.getToolDefinition`（它
 * 只汇总扩展注册的工具），历史路径查扩展对象的 `tools: Map<name, { definition, sourceInfo }>`，
 * 两边都**按扩展顺序先注册者胜**（与 runner 同一规则）。
 *
 * 为什么不读 `session.getToolDefinition`：那条路会把 SDK **内置**定义也带进来，而内置工具的
 * `label` 就是小写工具名（`bash`/`edit`/`read`），`edit` 还带 `renderShell: "self"`。那些不是
 * 给人看的名字（采纳后标题会从 `Bash` 变 `bash`，并在有快照/无快照之间跳动），而内置工具的
 * 外壳声明属于 TUI 内部样式：我们的卡片是宿主壳，同时承载运行状态色与折叠入口，不能因为
 * 一条内部声明就丢掉它们。因此内置定义的展示字段一律不采纳；同名前缀的 label 也在
 * `readDisplayMeta` 里被拦下来作为双保险。
 *
 * 边界：
 * - **只读投影**：只读定义里的展示字段，不改工具执行语义，不写任何东西。
 * - 任何异常/非法形状降级为「没有元数据」（调用方回退既有展示），绝不让会话读取失败。
 */

import {
  loadExtensionsForCwd,
  type LoadedExtensionsLoader,
} from "./loaded-extensions";
import { SEND_FILE_TO_USER_TOOL_LABEL, SEND_FILE_TO_USER_TOOL_NAME } from "./send-file-to-user";
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
 * 读一个工具定义的展示字段。
 *
 * `label` **精确等于**工具名视为没声明名字：SDK 内置工具就是这么写的
 * （`bash`/`edit`/`read` 的 label 就是那个小写工具名），采纳它只会把标题从 `Bash`
 * 变成 `bash`，并且随快照有无在两者之间跳动。
 * 只比精确相等、不比忽略大小写：真插件会故意用大小写做显示改进（pi-mcp-adapter 给
 * 工具 `mcp` 的 label 就是 `MCP`），那种名字必须保留。
 * `renderShell` 独立判定：只认 `"self"`。
 */
function readDisplayMeta(
  toolName: string,
  definition: Record<string, unknown> | null,
): ToolDisplayMeta | null {
  if (!definition) return null;
  const display: ToolDisplayMeta = {};
  const label = definition.label;
  if (typeof label === "string") {
    const trimmed = label.trim();
    if (trimmed !== "" && trimmed !== toolName) display.label = trimmed;
  }
  if (definition.renderShell === "self") display.renderShell = "self";
  return display.label === undefined && display.renderShell === undefined ? null : display;
}

/**
 * 从已加载的扩展里收集 toolName → 显示元数据。
 *
 * 顺序与 SDK 的 `ExtensionRunner.getToolDefinition` 一致：按扩展顺序遍历，**先注册者胜**
 * —— 活路径就是查那张表，两条路径必须用同一个先后规则，否则同一张卡片在刷新前后会换名字。
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
      if (typeof name !== "string" || name === "" || meta.has(name)) continue;
      const display = readDisplayMeta(name, asRecord(asRecord(entry)?.definition));
      if (display) meta.set(name, display);
    }
  }
  // Pidance 自己的工具：宿主用 inline extension 注册，只活在运行中的会话里，读盘时
  // 不在扩展表里。显式登记（名字与宿主共用同一个常量），否则同一张卡片在刷新后会
  // 从「Send file to user」退回「Send_file_to_user」。
  if (!meta.has(SEND_FILE_TO_USER_TOOL_NAME)) {
    const own = readDisplayMeta(SEND_FILE_TO_USER_TOOL_NAME, { label: SEND_FILE_TO_USER_TOOL_LABEL });
    if (own) meta.set(SEND_FILE_TO_USER_TOOL_NAME, own);
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
