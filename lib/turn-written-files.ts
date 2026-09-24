/**
 * 本轮（turn）写入的文件汇总。
 *
 * 数据只来自写入类工具**成功**的调用：`edit` / `write` 的参数路径，`apply_patch` 的
 * `details.result.appliedFiles`（含重命名的新路径）。失败、删除、重命名的旧路径都不算。
 * **回复正文从不做路径扫描** —— 模型在总结里写出的路径不是事实来源。
 *
 * 纯逻辑（无 React、无 IO），服务端投影与浏览器渲染共用同一份判定。
 */

import type { AgentMessage, ToolCallContent, ToolResultMessage } from "./types";
import {
  applyPatchPreviewToFiles,
  applyPatchResultHasFailures,
  getApplyPatchAppliedFiles,
  getApplyPatchInputText,
} from "./apply-patch";
import { isApplyPatchToolName, isFileWritingToolName } from "./tool-names";
import { joinFilePath, normalizeFilePathSlashes } from "./file-paths";
import type { SplitDiffFile } from "./patch";

export interface TurnWrittenFile {
  /** 已解析的路径：绝对路径原样，相对路径按会话 cwd 拼接。 */
  filePath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `edit` / `write` 的目标路径：参数是 `path`（内置）或 `file_path`（兼容变体）。 */
function readToolPath(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  const value = input.path ?? input.file_path;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** 删除没有 newPath —— 被删的文件不是「本轮写入的文件」。 */
function writtenPathsFromFiles(files: SplitDiffFile[] | null): string[] {
  if (!files) return [];
  return files
    .map((file) => file.newPath)
    .filter((filePath): filePath is string => typeof filePath === "string" && filePath.length > 0);
}

/** apply_patch 里被删除的目标：preview 的 delete 操作 + V4A 文档里的 Delete File 段。 */
function collectApplyPatchDeleteTargets(input: Record<string, unknown> | undefined, details: unknown): Set<string> {
  const deleted = new Set<string>();
  if (isRecord(details) && isRecord(details.preview) && Array.isArray(details.preview.files)) {
    for (const raw of details.preview.files) {
      if (!isRecord(raw)) continue;
      if (raw.operation === "delete" && typeof raw.filePath === "string" && raw.filePath.length > 0) {
        deleted.add(raw.filePath);
      }
    }
  }
  for (const match of getApplyPatchInputText(input).matchAll(/^\*\*\* Delete File: (.+)$/gm)) {
    const filePath = (match[1] ?? "").trim();
    if (filePath) deleted.add(filePath);
  }
  return deleted;
}

/**
 * 一次 apply_patch 真正写入的路径。
 *
 * 写入事实只有两处，且都在**工具结果**侧：`details.result.appliedFiles`（落盘事实，
 * 含重命名目标）与 `details.preview`（扩展产出的逐文件已应用 diff）。
 * 有失败且没有 appliedFiles 说明这次什么都没写成。
 *
 * **不回退到补丁文档**：`input` 里的 V4A 补丁只说明请求过哪些路径（可能整体失败、
 * 可能只成功一部分），把它当已写入就是谎报。宁可不显示，也不显示错的。
 */
function readApplyPatchPaths(input: Record<string, unknown> | undefined, details: unknown): string[] {
  const deleted = collectApplyPatchDeleteTargets(input, details);
  const applied = getApplyPatchAppliedFiles(details);
  if (applied.length > 0) return applied.filter((filePath) => !deleted.has(filePath));
  if (applyPatchResultHasFailures(details)) return [];

  if (isRecord(details)) return writtenPathsFromFiles(applyPatchPreviewToFiles(details.preview));
  return [];
}

/**
 * 单次工具调用写入的路径（未按 cwd 解析）。
 *
 * `result` 缺失表示这次调用仍在执行；`isError` 表示没写成 —— 两种情况都不算写入。
 * 非写入类工具一律空数组。
 */
export function extractWrittenPathsFromToolCall(
  toolName: string,
  input: Record<string, unknown> | undefined,
  result: ToolResultMessage | undefined,
): string[] {
  if (!isFileWritingToolName(toolName)) return [];
  if (!result || result.isError === true) return [];
  if (isApplyPatchToolName(toolName)) return readApplyPatchPaths(input, result.details);
  const filePath = readToolPath(input);
  return filePath ? [filePath] : [];
}

/**
 * 相对路径按 cwd 拼接（工具实际几乎都给绝对路径，这里是兜底）。
 *
 * 只去掉开头的 `./`，不做 `..` 折叠：路径归一只有 `lib/file-paths.ts` 一处口径，
 * 这里再实现一套会与文件面板的 tab 身份对不上。
 */
export function resolveWrittenFilePath(rawPath: string, cwd?: string): string {
  const normalized = normalizeFilePathSlashes(rawPath.trim());
  if (!normalized) return "";
  const isAbsolute = normalized.startsWith("/") || normalized.startsWith("//") || /^[a-zA-Z]:\//.test(normalized);
  if (isAbsolute) return normalized;
  if (!cwd) return normalized;
  return joinFilePath(cwd, normalized.replace(/^(\.\/)+/, ""));
}

/** 该 assistant 消息是不是本轮的收尾消息：到下一个 user 之间没有别的 assistant。 */
export function isTurnFinalAssistantMessage(messages: readonly AgentMessage[], index: number): boolean {
  if (messages[index]?.role !== "assistant") return false;
  for (let i = index + 1; i < messages.length; i += 1) {
    const role = messages[i]?.role;
    if (role === "user") break;
    if (role === "assistant") return false;
  }
  return true;
}

/** 该下标之后还有没有 user 消息（即这一轮是否已经翻页）。 */
function hasUserMessageAfter(messages: readonly AgentMessage[], index: number): boolean {
  for (let i = index + 1; i < messages.length; i += 1) {
    if (messages[i]?.role === "user") return true;
  }
  return false;
}

/**
 * 这条消息要不要渲染「本轮写入的文件」卡片。
 *
 * 同一轮只出一张卡：
 * - 流式项（`index === null`）：它就是正在跑的那一步，出卡并随内容增长。
 * - 磁盘项：必须是本轮收尾助手消息（`isTurnFinalAssistantMessage`），**且同一段
 *   没有流式助手消息在跑**。
 *
 * 为什么需要后半个条件：多步轮次里，上一步的助手消息在 `message_end` 就已入库、
 * 下一步仍在 live 槽（`lib/browser-session-runtime-registry.ts` 的 `emptyStream()`）。
 * 此时磁盘上那条「暂时最后一条」既是收尾又是同段，两处各自出卡 → 同一轮两张卡，
 * 而 live 那张还会把上一步的文件一起列出来。所以同段有流式助手时，让流式那项出卡。
 */
export function shouldRenderTurnWrittenFiles(input: {
  messages: readonly AgentMessage[];
  /** 磁盘下标；流式（未落盘）传 null。 */
  index: number | null;
  /** 渲染计划里是否存在流式中的助手消息（同一会话同一时刻至多一条）。 */
  liveAssistantActive: boolean;
}): boolean {
  const { messages, index, liveAssistantActive } = input;
  if (index === null) return true;
  if (!isTurnFinalAssistantMessage(messages, index)) return false;
  if (!liveAssistantActive) return true;
  // 同段还有流式助手：这一轮的卡归它。已经翻页（后面有 user）的磁盘消息不受影响，
  // 那段自有它的收尾消息。
  return hasUserMessageAfter(messages, index);
}

/**
 * 汇总本轮写入的文件：从最近一条 user 消息之后，到 `index`（或数组末尾）为止的所有
 * assistant 工具调用，按出现顺序去重。`liveMessage` 是流式中那条尚未落盘的 assistant
 * 消息，按顺序接在末尾。
 */
export function collectTurnWrittenFiles(input: {
  messages: readonly AgentMessage[];
  /** 收尾 assistant 消息的磁盘下标；流式（未落盘）传 null。 */
  index: number | null;
  liveMessage?: AgentMessage | null;
  toolResults: ReadonlyMap<string, ToolResultMessage>;
  cwd?: string;
}): TurnWrittenFile[] {
  const { messages, index, liveMessage = null, toolResults, cwd } = input;
  const end = index ?? messages.length - 1;

  let start = 0;
  for (let i = end; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      start = i + 1;
      break;
    }
  }

  const sources: AgentMessage[] = [];
  for (let i = start; i <= end && i < messages.length; i += 1) {
    const message = messages[i];
    if (message) sources.push(message);
  }
  if (liveMessage) sources.push(liveMessage);

  const seen = new Set<string>();
  const files: TurnWrittenFile[] = [];
  for (const message of sources) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const call = block as ToolCallContent;
      for (const raw of extractWrittenPathsFromToolCall(call.toolName, call.input, toolResults.get(call.toolCallId))) {
        const filePath = resolveWrittenFilePath(raw, cwd);
        if (!filePath || seen.has(filePath)) continue;
        seen.add(filePath);
        files.push({ filePath });
      }
    }
  }
  return files;
}
