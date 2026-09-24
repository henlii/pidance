/**
 * `settings.json` 的 `enabledModels`：读、最小编辑、写。
 *
 * 语义（与 models-available.ts 的过滤口径必须一致）：
 * - 缺失或空数组 = **不过滤**（全部可用）。因此「关掉全部」无法表达 —— 见下。
 * - 每项可写 `provider/model` 或裸 `model`；带思考后缀（`:high`）按同一条模型处理。
 *
 * 三条硬约束：
 * 1. **最小编辑**：只增删目标引用，其它键的取值逐字节不变（不允许整份重写语义）。
 * 2. **读不出就不写**：settings.json 存在但解析失败时**拒绝写**（与 models.json 的
 *    GET 422 / PUT 409 同一条产品原则：宁可不改，也不要覆盖别人的文件）。
 * 3. **项目级覆盖时为只读**：`<cwd>/.pi/settings.json` 定义了 enabledModels 时，
 *    改全局没有意义（项目级合并覆盖），对外报只读。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { getSettingsPath } from "./pi-paths";
import { getProjectSettingsPath, saveSettingsFile, type SettingsObject } from "./settings-store";
import { stripThinkingSuffix } from "./models-available";

export const ENABLED_MODELS_KEY = "enabledModels";

export type EnabledModelsErrorCode =
  | "bad-request"
  | "unreadable"
  | "project-override"
  | "last-model"
  /** 文件形状无法安全做文本手术（顶层不是对象等）——拒写，不整份重写。 */
  | "unsupported-shape";

export class EnabledModelsError extends Error {
  readonly code: EnabledModelsErrorCode;

  constructor(code: EnabledModelsErrorCode, message: string) {
    super(message);
    this.name = "EnabledModelsError";
    this.code = code;
  }
}

export interface EnabledModelsState {
  /** 当前全局 enabledModels；null = 未过滤（全部可用）。 */
  enabledModels: string[] | null;
  /** 项目级 settings.json 覆盖了该键 → 界面只读。 */
  projectOverride: boolean;
  /** 全局 settings.json 存在但解析失败 → 只读且拒写。 */
  unreadable: boolean;
}

type StrictRead =
  | { exists: false }
  | { exists: true; ok: true; data: SettingsObject }
  | { exists: true; ok: false };

/** 读取上限：settings.json 再大也不该整份读进内存（与 /api/settings/raw 同一上限）。 */
const MAX_SETTINGS_BYTES = 1_000_000;

function readSettingsStrict(path: string): StrictRead {
  if (!existsSync(path)) return { exists: false };
  try {
    if (statSync(path).size > MAX_SETTINGS_BYTES) return { exists: true, ok: false };
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { exists: true, ok: false };
    }
    return { exists: true, ok: true, data: { ...(parsed as SettingsObject) } };
  } catch {
    return { exists: true, ok: false };
  }
}

function readEnabledModelsArray(data: SettingsObject | undefined): string[] | null {
  const raw = data?.[ENABLED_MODELS_KEY];
  if (!Array.isArray(raw)) return null;
  const list = raw.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  return list.length > 0 ? list : null;
}

/** 读全局 + 项目级状态（项目级只看是否覆盖该键）。 */
export function readEnabledModelsState(options: {
  settingsPath?: string;
  projectSettingsPath?: string;
} = {}): EnabledModelsState {
  const settingsPath = options.settingsPath ?? getSettingsPath();
  const global = readSettingsStrict(settingsPath);
  const projectPath =
    options.projectSettingsPath !== undefined && options.projectSettingsPath !== ""
      ? options.projectSettingsPath
      : null;
  const project = projectPath ? readSettingsStrict(projectPath) : { exists: false as const };

  return {
    enabledModels: global.exists && global.ok ? readEnabledModelsArray(global.data) : null,
    projectOverride:
      project.exists && project.ok ? Array.isArray(project.data[ENABLED_MODELS_KEY]) : false,
    unreadable: global.exists && !global.ok,
  };
}

/** 项目级 settings.json 路径（cwd 为空时返回 null）。 */
export function projectSettingsPathFor(cwd: string | null | undefined): string | null {
  if (typeof cwd !== "string" || cwd.trim() === "") return null;
  return getProjectSettingsPath(cwd);
}

/**
 * 目录里的裸 id → 唯一引用；多个 provider 用同一个 id 时返回 null（说不清是哪一个）。
 */
function uniqueRefForBareId(bare: string, allRefs: readonly string[]): string | null {
  const hits = allRefs
    .map(stripThinkingSuffix)
    .filter((entry) => entry !== "" && (entry.split("/").pop() ?? entry) === bare);
  const unique = [...new Set(hits)];
  return unique.length === 1 ? unique[0]! : null;
}

/** 目标引用归一：`provider/model` 直接用；裸 id 只在目录里唯一时才认。 */
function canonicalTarget(target: string, allRefs: readonly string[]): string {
  if (allRefs.some((entry) => stripThinkingSuffix(entry) === target)) return target;
  const bare = target.split("/").pop() ?? "";
  return (bare ? uniqueRefForBareId(bare, allRefs) : null) ?? target;
}

/**
 * 条目是否指向目标模型（重叠语义）：裸 id 只要 id 相同就算重叠 —— 它可能同时指向别的 provider 的同名模型，
 * 所以调用方在删它时必须把其它同名模型显式补回来（见 disable 分支）。
 */
function overlapsTarget(entry: string, target: string): boolean {
  const a = stripThinkingSuffix(entry);
  if (a === target) return true;
  const bare = target.split("/").pop() ?? "";
  return bare !== "" && a === bare;
}

/**
 * 计算开关后的 enabledModels（纯函数，便于单测）。
 *
 * @param current 当前值；null/空 = 不过滤
 * @param ref 目标引用（`provider/model` 或裸 `model`）
 * @param enabled true=启用，false=停用
 * @param allRefs 当前可用模型的完整引用集合（停用且当前未过滤时要物化）
 */
export function computeNextEnabledModels(
  current: string[] | null,
  ref: string,
  enabled: boolean,
  allRefs: readonly string[],
): string[] | null {
  const target = canonicalTarget(stripThinkingSuffix(ref.trim()), allRefs);
  if (!target) throw new EnabledModelsError("bad-request", "model reference is empty");

  const currentList = current && current.length > 0 ? current : null;
  // 重叠语义：裸 id 覆盖到的模型也算「已经是这个状态」，否则开关会看起来没反应
  // （面板说关了、实际还在）。
  const has = (list: readonly string[]) => list.some((entry) => overlapsTarget(entry, target));

  if (enabled) {
    // 未过滤时已经是「全开」，无需写盘（写进去反而会收窄成只有一个）。
    if (!currentList) return null;
    if (has(currentList)) return currentList;
    return [...currentList, target];
  }

  if (!currentList) {
    const base = allRefs.filter((entry) => entry.trim() !== "");
    if (base.length === 0) return null;
    const remaining = base.filter((entry) => !overlapsTarget(entry, target));
    // 目标不在可用集里（例如已删模型）：不动
    if (remaining.length === base.length) return null;
    // 空数组 = 不过滤，无法表达「全关」，明确拒绝而不是静默变成全开
    if (remaining.length === 0) {
      throw new EnabledModelsError("last-model", "cannot disable the last available model");
    }
    return remaining;
  }

  if (!has(currentList)) return currentList;

  // 逐条决定：命中目标的那条去掉。
  // 如果命中的是一条**裸 id**（可能同时指向同 id 的其它 provider 模型），
  // 就要把那些模型显式补回来 —— 否则「只关这一个」会把它们一起关掉。
  const remaining: string[] = [];
  for (const entry of currentList) {
    if (!overlapsTarget(entry, target)) {
      remaining.push(entry);
      continue;
    }
    const normalized = stripThinkingSuffix(entry);
    if (!normalized.includes("/")) {
      for (const other of allRefs) {
        const otherRef = stripThinkingSuffix(other);
        if (otherRef === target || !otherRef) continue;
        if ((otherRef.split("/").pop() ?? otherRef) === normalized && !remaining.includes(otherRef)) {
          remaining.push(otherRef);
        }
      }
    }
  }
  if (remaining.length === 0) {
    throw new EnabledModelsError("last-model", "cannot disable the last enabled model");
  }
  return remaining;
}

/**
 * 在**原文**上只改 `enabledModels` 一处，其余字节原样保留。
 *
 * 为什么不能整份 `JSON.stringify` 回写：settings.json 里还有别人的键（含其它运行时写的
 * 配置），重新序列化会把整个文件的排版（数组换行、内联对象）改写一遍 —— 值虽然没丢，
 * 但文件被我们重写了。这里是纯文本手术：定位顶层该属性的值区间，只替换/插入/删除它。
 *
 * 返回 null 表示无法安全手术（例如顶层不是对象、找不到可靠的插入点），调用方决定回退。
 */
export function applyEnabledModelsEdit(raw: string, next: string[] | null): string | null {
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const span = findTopLevelPropertySpan(raw, ENABLED_MODELS_KEY);
  const valueText = next === null ? null : JSON.stringify([...next]);

  if (span) {
    if (valueText !== null) {
      return raw.slice(0, span.valueStart) + valueText + raw.slice(span.valueEnd);
    }
    return removeTopLevelProperty(raw, span);
  }
  if (valueText === null) return raw; // 本来就没有这个键

  const insertAt = findTopLevelInsertPoint(raw);
  if (insertAt === null) return null;
  const indent = detectIndent(raw) ?? "  ";
  const { index, needsComma, emptyObject } = insertAt;
  // 空对象不引入换行/缩进（保持它原本的紧凑形状）；非空则另起一行并沿用文件缩进
  const entry = `${needsComma ? "," : ""}${emptyObject ? "" : newline + indent}"${ENABLED_MODELS_KEY}": ${valueText}`;
  return raw.slice(0, index) + entry + raw.slice(index);
}

interface PropertySpan {
  /** 键名（含引号）起始位置 */
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

/**
 * 在顶层对象里找 `key` 的值区间。只认深度 1 的同名键（settings.json 是单层对象，
 * 嵌套同名键不应当被我们改）。
 */
function findTopLevelPropertySpan(raw: string, key: string): PropertySpan | null {
  const target = `"${key}"`;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      // 只在深度 1 才可能是「顶层对象的键」
      if (depth === 1 && raw.startsWith(target, i)) {
        const afterKey = skipWhitespace(raw, i + target.length);
        if (raw[afterKey] === ":") {
          const valueStart = skipWhitespace(raw, afterKey + 1);
          const valueEnd = findValueEnd(raw, valueStart);
          if (valueEnd === null) return null;
          return { keyStart: i, valueStart, valueEnd };
        }
      }
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth < 0) return null;
    }
  }
  return null;
}

function skipWhitespace(raw: string, from: number): number {
  let i = from;
  while (i < raw.length && /\s/.test(raw[i]!)) i += 1;
  return i;
}

/** 从值起点扫到该值结束（不含尾随空白）；遇到顶层逗号/右花括号即止。 */
function findValueEnd(raw: string, valueStart: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = valueStart;

  for (let i = valueStart; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      end = i + 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      end = i + 1;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
      end = i + 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (depth === 0) return end; // 顶层对象的收尾
      depth -= 1;
      end = i + 1;
      continue;
    }
    if (depth === 0 && ch === ",") return end;
    if (!/\s/.test(ch)) end = i + 1;
  }
  return end > valueStart ? end : null;
}

/** 删除顶层某个属性（含它的缩进/换行与相邻逗号）。 */
function removeTopLevelProperty(raw: string, span: PropertySpan): string {
  let start = span.keyStart;
  // 吃掉键名所在行的缩进
  while (start > 0 && (raw[start - 1] === " " || raw[start - 1] === "\t")) start -= 1;

  let end = span.valueEnd;
  // 优先吃掉**后面**的逗号（说明它不是最后一个属性，后面还有行）
  const afterValue = skipWhitespace(raw, end);
  if (raw[afterValue] === ",") {
    end = afterValue + 1;
    // 吃掉后续换行，避免在「逗号 + 换行」的位置留下空行；下一行自己的缩进保留
    while (end < raw.length && (raw[end] === "\r" || raw[end] === "\n")) end += 1;
  } else {
    // 它是最后一个属性：回头吃掉**前面**的逗号；它到 `}` 之间的换行与缩进属于排版，保留
    let before = start;
    while (before > 0 && /\s/.test(raw[before - 1]!)) before -= 1;
    if (raw[before - 1] === ",") start = before - 1;
  }
  return raw.slice(0, start) + raw.slice(end);
}

interface InsertPoint {
  /** 在哪个下标前插入 */
  index: number;
  needsComma: boolean;
  /** 顶层对象当前为空（`{}` / `{ }` / `{\n}`） */
  emptyObject: boolean;
}

/**
 * 追加属性的插入点：
 * - 空对象：直接在右花括号前；
 * - 非空：**最后一个非空白字符之后**（不是 `}` 之前）—— 否则逗号会落在「值 + 换行」
 *   之间，写出 `"tools": ["bash"]\n,\n  "enabledModels"` 这种形状。
 */
function findTopLevelInsertPoint(raw: string): InsertPoint | null {
  const open = raw.indexOf("{");
  if (open === -1) return null;
  const close = raw.lastIndexOf("}");
  if (close === -1 || close < open) return null;
  // 右花括号之后只允许空白（否则顶层不是「单个对象」形状，不碰）
  if (raw.slice(close + 1).trim() !== "") return null;

  const body = raw.slice(open + 1, close);
  if (body.trim() === "") return { index: close, needsComma: false, emptyObject: true };

  let lastNonSpace = close - 1;
  while (lastNonSpace > open && /\s/.test(raw[lastNonSpace]!)) lastNonSpace -= 1;
  if (lastNonSpace <= open) return null;
  return {
    index: lastNonSpace + 1,
    needsComma: raw[lastNonSpace] !== ",",
    emptyObject: false,
  };
}

function detectIndent(raw: string): string | null {
  const match = raw.match(/\r?\n([ \t]+)\S/);
  return match ? match[1]! : null;
}

function writeTextAtomic(path: string, text: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

/**
 * 写回全局 settings.json：只改 enabledModels，其它键保持原值。
 *
 * `next === null` 表示恢复「不过滤」——删除该键，而不是写空数组（两者语义相同，
 * 但删除更贴近「没有这个设置」的原状）。
 */
export function writeEnabledModels(
  next: string[] | null,
  options: { settingsPath?: string } = {},
): void {
  const settingsPath = options.settingsPath ?? getSettingsPath();
  const read = readSettingsStrict(settingsPath);
  if (read.exists && !read.ok) {
    throw new EnabledModelsError(
      "unreadable",
      "settings.json is not valid JSON; refusing to overwrite it",
    );
  }

  if (!read.exists) {
    // 文件不存在：从空对象开始（与 saveSettingsFile 同一份排版惯例）
    const empty = next === null ? {} : { [ENABLED_MODELS_KEY]: [...next] };
    saveSettingsFile(settingsPath, empty);
    return;
  }

  const raw = readFileSync(settingsPath, "utf8");
  const edited = applyEnabledModelsEdit(raw, next);
  if (edited !== null) {
    writeTextAtomic(settingsPath, edited);
    return;
  }

  // 手术失败（形状罕见，如顶层不是对象）：**拒写**。这里曾经退回「整份 JSON 序列化重写」
  // ——那会把用户 settings.json 的排版和其它运行时写的键一起规范化，代价比一个小开关大得多。
  throw new EnabledModelsError(
    "unsupported-shape",
    "settings.json has a shape this editor cannot patch safely; refusing to rewrite it",
  );
}

export interface ToggleResult {
  enabledModels: string[] | null;
}

/**
 * 一次开关：读状态 → 计算 → 写回。项目级覆盖或文件读不出时抛出对应错误。
 */
export function toggleEnabledModel(
  ref: string,
  enabled: boolean,
  allRefs: readonly string[],
  options: { settingsPath?: string; projectSettingsPath?: string } = {},
): ToggleResult {
  const state = readEnabledModelsState(options);
  if (state.unreadable) {
    throw new EnabledModelsError(
      "unreadable",
      "settings.json is not valid JSON; refusing to overwrite it",
    );
  }
  if (state.projectOverride) {
    throw new EnabledModelsError(
      "project-override",
      "this project defines enabledModels; the global list is read-only here",
    );
  }
  const next = computeNextEnabledModels(state.enabledModels, ref, enabled, allRefs);
  writeEnabledModels(next, options);
  return { enabledModels: next };
}
