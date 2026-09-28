/**
 * 扩展面板正文的「行级语义」识别（issue #114 第 2 层）。
 *
 * 插件画的是终端界面：边框用 `─│┌┐└┘`、选中项靠反显、标题靠加粗。这里从**已经拿到的 ANSI 行**
 * 推断语义，交给前端换成网页样式；**识别不到就整块按原样渲染**，绝不猜、绝不改内容。
 *
 * 刻意的边界：
 * - 只做行级识别，不从组件树读原语（那需要碰 pi-tui 的私有字段，另立 issue）；
 * - 交互只能**合成按键**：插件状态机由键驱动，没有"选第 N 项"的接口；
 * - 边框行会被换成 CSS 细线 —— 这正是本次要的观感变化，「切回原样」随时能看到原始字符。
 */

import { stripAnsi } from "./ansi";

/** 整行只由制表边框字符与空格组成（用于识别边框/分隔行）。 */
const BOX_DRAWING_CHARS = /^[\s─│┌┐└┘├┤┬┴┼┏┓┗┛┣┫┳┻╋━┃]+$/;

/** 光标标记：pi-tui 的选择列表用 ❯ / ▶ 或 > 表示当前项。 */
const CURSOR_MARKERS = ["❯", "▶", ">"];

/** 选项行前缀：编号（1. / 2) / (3)）或项目符号（- / * / •）。 */
const OPTION_PREFIX = /^\s*(?:[❯▶>]\s*)?(?:\(?\d+[).、]|[-*•])\s+\S/;

export type PanelBlockKind = "border" | "heading" | "text";

export interface PanelBlock {
  kind: PanelBlockKind;
  /** 原始行（含 ANSI），渲染时按既有 ANSI 机制处理。 */
  lines: string[];
  /** 去 ANSI 后的纯文本，用于内容完整性断言。 */
  plainLines: string[];
}

export interface PanelOptionItem {
  /** 在下拉/列表里的序号（0 起）—— 合成按键时要按它算步数。 */
  index: number;
  /** 去 ANSI 后的标签（用于可读性与断言）。 */
  label: string;
  /** 原始行（含 ANSI），供网页化渲染保留插件配色。 */
  line: string;
  /** 是否当前光标所在项。 */
  cursor: boolean;
}

export interface PanelOptionList {
  items: PanelOptionItem[];
  cursorIndex: number;
}

export interface PanelView {
  /** 按原文顺序切出的块（内容一行不少，顺序不变）。 */
  blocks: PanelBlock[];
  /** 识别出的选项列表；识别不到就是 null（调用方按原样渲染）。 */
  options: PanelOptionList | null;
}

/** 该行是不是「整行制表符」的边框行。 */
export function isBorderRow(line: string): boolean {
  const plain = stripAnsi(line);
  if (plain.trim() === "") return false;
  return BOX_DRAWING_CHARS.test(plain) && /[─│┌┐└┘├┤┬┴┼┏┓┗┛┣┫┳┻╋━┃]/.test(plain);
}

/** 该行是不是标题行：去 ANSI 后为加粗（SGR 1）且短。 */
export function isHeadingRow(line: string): boolean {
  const plain = stripAnsi(line).trim();
  if (plain.length === 0 || plain.length > 40) return false;
  if (isBorderRow(line)) return false;
  // 加粗：任意 1; / ;1 的 SGR 参数里带 1
  return /\x1b\[[0-9;]*1(?:[;m])/.test(line);
}

/** 该行是否带背景色（反显 = 插件用背景色画选中项）。 */
function hasBackgroundColor(line: string): boolean {
  return /\x1b\[(?:4[0-7]|48;[0-9;]+|10[0-7])m/.test(line);
}
function cursorIndexOf(line: string): number {
  const plain = stripAnsi(line);
  for (const marker of CURSOR_MARKERS) {
    const at = plain.indexOf(marker);
    if (at >= 0) return at;
  }
  return -1;
}

/**
 * 识别选项列表。保守：必须有 ≥2 个同形前缀的候选行、且**恰好一行**带光标标记。
 * 像表格的面板（含制表边框行或列间隙很大的行）一律判否 —— 宁可不识别，也不能把表格当选项。
 */
export function detectPanelOptionList(lines: string[]): PanelOptionList | null {
  const candidates: { index: number; line: string; label: string; cursor: boolean; indent: number }[] = [];
  for (const line of lines) {
    const plain = stripAnsi(line);
    if (isBorderRow(line)) return null; // 有边框 → 更像表格/框，不猜
    if (!OPTION_PREFIX.test(plain)) continue;
    // 光标标记占的正是缩进位，算缩进时必须先把它去掉（否则第 2 项起差 2 格就被判成不齐）
    // 光标标记**占一格**（TUI 里它替掉首列），所以量缩进时把它换成空格而不是删掉，
    // 否则「❯ 1.」与「  2.」会差 2 格，同形前缀判据直接判否。
    const indent = plain.replace(/^(\s*)[❯▶>]/, "$1 ").match(/^\s*/)?.[0].length ?? 0;
    const cursor = cursorIndexOf(line) >= 0 || hasBackgroundColor(line);
    const label = plain.replace(/^\s*(?:[❯▶>]\s*)?/, "").trim();
    candidates.push({ index: candidates.length, line, label, cursor, indent });
  }
  if (candidates.length < 2) return null;
  // 同形前缀：缩进一致（容 1 格误差），否则可能是散落在正文里的编号
  const baseIndent = candidates[0].indent;
  if (candidates.some((c) => Math.abs(c.indent - baseIndent) > 1)) return null;
  const cursorRows = candidates.filter((c) => c.cursor);
  if (cursorRows.length !== 1) return null;
  if (candidates.some((c) => c.label.length === 0)) return null;
  return {
    items: candidates.map((c) => ({ index: c.index, label: c.label, line: c.line, cursor: c.cursor })),
    cursorIndex: cursorRows[0].index,
  };
}

/** 把 ANIS 行切成块：边框 / 标题 / 正文，同时附带选项识别结果。 */
export function buildPanelView(lines: string[]): PanelView {
  const blocks: PanelBlock[] = [];
  for (const line of lines) {
    const kind: PanelBlockKind = isBorderRow(line) ? "border" : isHeadingRow(line) ? "heading" : "text";
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind) {
      last.lines.push(line);
      last.plainLines.push(stripAnsi(line));
    } else {
      blocks.push({ kind, lines: [line], plainLines: [stripAnsi(line)] });
    }
  }
  return { blocks, options: detectPanelOptionList(lines) };
}

/**
 * 网页化视图是否值得启用：只有识别出选项、标题或边框才换样式；
 * 全是正文时保持原样（不做无意义的结构改变）。
 */
export function shouldRenderPanelWebView(view: PanelView): boolean {
  if (view.options) return true;
  return view.blocks.some((b) => b.kind !== "text");
}

/**
 * 点击第 targetIndex 项需要合成的按键步数（相对当前光标）。
 * 返回 null 表示「不要动」—— 目标就是当前项时只按回车。
 */
export function optionStepKeys(fromIndex: number, targetIndex: number, count: number): string[] | null {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(targetIndex) || count <= 1) return null;
  if (targetIndex < 0 || targetIndex >= count) return null;
  if (fromIndex < 0 || fromIndex >= count) return null;
  const down = targetIndex > fromIndex;
  const steps = Math.abs(targetIndex - fromIndex);
  return Array.from({ length: steps }, () => (down ? "\x1b[B" : "\x1b[A"));
}


/**
 * 点击某个选项时**发键前**的决策（issue #114 硬限制 3：点击与插件状态可能漂移）。
 *
 * 用户看到的是 `seenLines`，真正发键时面板可能已经重渲染过（`currentLines`）。两边的
 * 选项标签必须逐项一致才敢按 —— 对不上就 give-up，让调用方退回原样渲染而不是点错项。
 */
export function planOptionClick(
  seenLines: string[],
  currentLines: string[],
  targetIndex: number,
): { kind: "noop" | "send" | "give-up"; keys: string[] } {
  const seen = detectPanelOptionList(seenLines);
  const current = detectPanelOptionList(currentLines);
  if (!seen || !current) return { kind: "give-up", keys: [] };
  if (seen.items.length !== current.items.length) return { kind: "give-up", keys: [] };
  if (seen.items.some((item, i) => item.label !== current.items[i].label)) return { kind: "give-up", keys: [] };
  const keys = optionStepKeys(current.cursorIndex, targetIndex, current.items.length);
  if (keys === null) return { kind: "give-up", keys: [] };
  return { kind: "send", keys };
}

/**
 * 发完方向键后再确认光标真的到了目标项；没到就不要按回车（否则会在错误的项上确认）。
 */
export function verifyOptionCursor(lines: string[], targetIndex: number): boolean {
  const list = detectPanelOptionList(lines);
  return Boolean(list && list.cursorIndex === targetIndex);
}
