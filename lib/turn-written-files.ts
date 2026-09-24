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
  parseApplyPatchInput,
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
 * 优先 `details.result.appliedFiles`（落盘事实，含重命名目标）；有失败且没有 appliedFiles
 * 说明这次什么都没写成；再退到已应用 preview，最后才是补丁文档本身。
 */
function readApplyPatchPaths(input: Record<string, unknown> | undefined, details: unknown): string[] {
  const deleted = collectApplyPatchDeleteTargets(input, details);
  const applied = getApplyPatchAppliedFiles(details);
  if (applied.length > 0) return applied.filter((filePath) => !deleted.has(filePath));
  if (applyPatchResultHasFailures(details)) return [];

  if (isRecord(details)) {
    const fromPreview = writtenPathsFromFiles(applyPatchPreviewToFiles(details.preview));
    if (fromPreview.length > 0) return fromPreview;
  }
  return writtenPathsFromFiles(parseApplyPatchInput(getApplyPatchInputText(input)));
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
