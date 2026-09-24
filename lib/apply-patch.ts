/**
 * Codex 风格 `apply_patch` 工具的渲染支持（如 pi-apply-patch 扩展）。
 *
 * 这类调用有两处数据源描述改动，都不是标准 unified diff：
 *
 * 1. 工具调用参数——一份 V4A 补丁文档，一次调用可含多个文件操作：
 *
 *    *** Begin Patch
 *    *** Add File: new.ts
 *    +line
 *    *** Update File: old.ts
 *    *** Move to: renamed.ts
 *    @@ 可选的上下文标记
 *     上下文
 *    -removed
 *    +added
 *    *** Delete File: gone.ts
 *    *** End Patch
 *
 * 2. 工具结果 `details.preview`——扩展产出的逐文件已应用 diff，行首标记后紧跟行号
 *    （`+12 text` / `-3 text` / ` 7 text`）。
 *
 * 两者都转成 ./patch 的共享 `SplitDiffFile[]` 模型，复用内置 edit 工具那套左右对照渲染。
 * 移植自上游 pi-web `e70c367`（`lib/apply-patch.ts`），保持同名以便后续同步。
 */

import type { SplitDiffCell, SplitDiffFile, SplitDiffRow } from "./patch";

interface ApplyPatchPreviewFile {
  filePath?: string;
  movePath?: string;
  operation?: string;
  diff?: string;
}

/** 按顺序取出 V4A 补丁文档涉及的文件路径（去重）。 */
export function extractApplyPatchPaths(patchText: string): string[] {
  const paths: string[] = [];
  for (const match of patchText.matchAll(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/gm)) {
    const filePath = (match[1] ?? "").trim();
    if (filePath && !paths.includes(filePath)) paths.push(filePath);
  }
  return paths;
}

/** 从 apply_patch 调用参数里取出补丁文档。 */
export function getApplyPatchInputText(input: unknown, rawInput?: string): string {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const value = (input as Record<string, unknown>).input;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return typeof rawInput === "string" ? rawInput : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * pi-apply-patch 把逐文件失败挂在正常工具结果上（`details.result.failures`），
 * 不设 `isError`，所以调用方要单独判一次。
 */
export function applyPatchResultHasFailures(details: unknown): boolean {
  return getApplyPatchFailures(details).length > 0;
}

/** 逐文件失败（`details.result.failures`）：`{ filePath, message }`，容忍字符串条目。 */
export interface ApplyPatchFailure {
  filePath: string;
  message?: string;
}

/**
 * 读逐文件失败清单。
 *
 * 为什么要读出来：pi-apply-patch 把失败挂在**正常结果**上（不设 isError），而调用方
 * 一旦把对照 diff 画出来就不会再画结果正文 —— 不单独列出来的话，失败原因就静默消失了。
 */
export function getApplyPatchFailures(details: unknown): ApplyPatchFailure[] {
  if (!isRecord(details) || !isRecord(details.result)) return [];
  const failures = details.result.failures;
  if (!Array.isArray(failures)) return [];
  const out: ApplyPatchFailure[] = [];
  for (const raw of failures) {
    if (typeof raw === "string") {
      const filePath = raw.trim();
      if (filePath) out.push({ filePath });
      continue;
    }
    if (!isRecord(raw)) continue;
    const filePath = typeof raw.filePath === "string" ? raw.filePath.trim() : "";
    const message = typeof raw.message === "string" && raw.message.trim() ? raw.message.trim() : undefined;
    if (!filePath && !message) continue;
    out.push(message ? { filePath, message } : { filePath });
  }
  return out;
}

/** 实际写入的文件（`details.result.appliedFiles`）；重命名给的是新路径。 */
export function getApplyPatchAppliedFiles(details: unknown): string[] {
  if (!isRecord(details) || !isRecord(details.result)) return [];
  const applied = details.result.appliedFiles;
  if (!Array.isArray(applied)) return [];
  const out: string[] = [];
  for (const raw of applied) {
    if (typeof raw !== "string") continue;
    const filePath = raw.trim();
    if (filePath && !out.includes(filePath)) out.push(filePath);
  }
  return out;
}

// ── 共享行构建 ───────────────────────────────────────────────────────────────

interface RowSink {
  rows: SplitDiffRow[];
  context(text: string, lineNo: number | null): void;
  removed(text: string, lineNo: number | null): void;
  added(text: string, lineNo: number | null): void;
  finish(): void;
}

function createRowSink(): RowSink {
  const rows: SplitDiffRow[] = [];
  let pendingRemoved: SplitDiffCell[] = [];
  let pendingAdded: SplitDiffCell[] = [];

  const emptyCell = (): SplitDiffCell => ({ lineNo: null, text: "", type: "empty" });

  const flushChanges = () => {
    const count = Math.max(pendingRemoved.length, pendingAdded.length);
    for (let i = 0; i < count; i++) {
      rows.push({
        type: "line",
        left: pendingRemoved[i] ?? emptyCell(),
        right: pendingAdded[i] ?? emptyCell(),
      });
    }
    pendingRemoved = [];
    pendingAdded = [];
  };

  return {
    rows,
    context(text, lineNo) {
      flushChanges();
      rows.push({
        type: "line",
        left: { lineNo, text, type: "context" },
        right: { lineNo, text, type: "context" },
      });
    },
    removed(text, lineNo) {
      pendingRemoved.push({ lineNo, text, type: "removed" });
    },
    added(text, lineNo) {
      pendingAdded.push({ lineNo, text, type: "added" });
    },
    finish() {
      flushChanges();
      // 丢弃没有可渲染行的文件（例如流式中途的空 Add 段）；原地改，调用方已持有该数组。
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].type !== "line") rows.splice(i, 1);
      }
    },
  };
}

// ── 数据源 1：V4A 补丁文档（工具调用参数） ──────────────────────────────────

/**
 * 把 V4A 补丁文档解析成左右对照的文件列表。
 *
 * 容忍被截断的输入（流式）：已解析完整的部分照常返回。
 * V4A 的头行不带行号，因此 update 部分的行号一律留空（不编造）。
 */
export function parseApplyPatchInput(patchText: string): SplitDiffFile[] | null {
  if (!patchText.includes("*** Begin Patch") && !/\*\*\* (?:Add|Delete|Update) File: /.test(patchText)) {
    return null;
  }

  const files: SplitDiffFile[] = [];
  let sink: RowSink | null = null;
  let current: SplitDiffFile | null = null;
  // add / delete 的正文是无前缀内容行；update 的正文带前缀。分开放到正确一侧。
  let operation: "add" | "delete" | "update" | null = null;

  for (const rawLine of patchText.split(/\r?\n/)) {
    const header = rawLine.match(/^\*\*\* (Add|Delete|Update) File: (.+)$/);
    if (header) {
      const op = (header[1]?.toLowerCase() ?? "update") as "add" | "delete" | "update";
      const filePath = (header[2] ?? "").trim();
      sink?.finish();
      operation = op;
      sink = createRowSink();
      current = {
        oldPath: op === "add" ? undefined : filePath,
        newPath: op === "delete" ? undefined : filePath,
        rows: sink.rows,
      };
      files.push(current);
      continue;
    }

    if (/^\*\*\* Move to: /.test(rawLine)) {
      const movePath = rawLine.replace(/^\*\*\* Move to: /, "").trim();
      if (current && operation === "update") current.newPath = movePath;
      continue;
    }

    if (!sink || !current) continue;
    const body: RowSink = sink;
    if (rawLine.startsWith("*** ")) continue; // Begin/End Patch 标记
    if (operation === "update" && rawLine.startsWith("@@")) continue; // 上下文标记不带行号

    if (operation === "update") {
      const prefix = rawLine[0];
      const content = rawLine.slice(1);
      if (prefix === "+") body.added(content, null);
      else if (prefix === "-") body.removed(content, null);
      else if (prefix === " ") body.context(content, null);
      else if (rawLine !== "") body.context(rawLine, null); // 兜底：无前缀的上下文行
    } else if (operation === "add") {
      if (rawLine === "") continue;
      body.added(rawLine.startsWith("+") ? rawLine.slice(1) : rawLine, null);
    } else if (operation === "delete") {
      if (rawLine === "") continue;
      body.removed(rawLine.startsWith("-") ? rawLine.slice(1) : rawLine, null);
    }
  }
  sink?.finish();

  const parsed = files.filter((file) => file.rows.length > 0);
  return parsed.length > 0 ? parsed : null;
}

// ── 数据源 2：已应用结果的 preview（details.preview） ───────────────────────

/**
 * 把扩展的已应用结果 preview 转成左右对照文件列表。
 * 其逐文件 `diff` 的行形如 `+12 text` / `-3 text` / ` 7 text`，带真实行号，因此保留。
 */
export function applyPatchPreviewToFiles(preview: unknown): SplitDiffFile[] | null {
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) return null;
  const rawFiles = (preview as Record<string, unknown>).files;
  if (!Array.isArray(rawFiles)) return null;

  const files: SplitDiffFile[] = [];
  for (const rawFile of rawFiles) {
    if (!rawFile || typeof rawFile !== "object" || Array.isArray(rawFile)) continue;
    const entry = rawFile as ApplyPatchPreviewFile;
    if (typeof entry.filePath !== "string" || typeof entry.diff !== "string") continue;

    const sink = createRowSink();
    for (const line of entry.diff.split(/\r?\n/)) {
      const match = line.match(/^([+\- ])\s*(\d+) (.*)$/);
      if (!match) continue;
      const [, marker, num, text] = match;
      const lineNo = Number(num);
      if (marker === "+") sink.added(text, lineNo);
      else if (marker === "-") sink.removed(text, lineNo);
      else sink.context(text, lineNo);
    }
    sink.finish();

    const isAdd = entry.operation === "add";
    const isDelete = entry.operation === "delete";
    files.push({
      oldPath: isAdd ? undefined : entry.filePath,
      newPath: isDelete ? undefined : (entry.movePath ?? entry.filePath),
      rows: sink.rows,
    });
  }

  const parsed = files.filter((file) => file.rows.length > 0);
  return parsed.length > 0 ? parsed : null;
}
