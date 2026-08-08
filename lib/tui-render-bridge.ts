/**
 * TUI 渲染桥（服务端纯逻辑）：headless 调用 pi 插件工具的 renderCall/renderResult，
 * 产出 ANSI 行数组，供 rpc-manager 附加到 SSE 事件。
 *
 * pi 插件的 TUI 显示最终收敛为 `Component.render(width) → string[]`（ANSI 行），
 * 纯函数、无终端依赖。AgentSession 是 in-process 的，插件代码就在本进程，
 * 因此可直接调用 `extensionRunner.getToolDefinition(toolName)` 取回原始
 * ToolDefinition（含 renderCall/renderResult，绕过了 wrapToolDefinition 的剥离）。
 *
 * Theme 加载（AGENTS.md 红线）：**不得**用 import.meta.url / __dirname / 运行时
 * 文件路径解析 node_modules 内的主题 JSON——webpack 产物会嵌入构建机源码绝对路径，
 * 触发发布审计红线。故把 dark.json 复制为 Pidance 自有副本
 * `lib/pi-themes/dark.json`（来源 pi-coding-agent 0.81.1），经 JSON import
 * 打包进产物（无绝对路径），再按 Theme 构造签名解析 vars/colors 构造。
 */

import darkThemeJson from "./pi-themes/dark.json" with { type: "json" };

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = Number.parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function fgAnsi(color: string | number, mode: "truecolor" | "256color"): string {
  if (color === "") return "\x1b[39m";
  if (typeof color === "number") return `\x1b[38;5;${color}m`;
  if (typeof color === "string" && color.startsWith("#")) {
    if (mode === "truecolor") {
      const { r, g, b } = hexToRgb(color);
      return `\x1b[38;2;${r};${g};${b}m`;
    }
    return `\x1b[38;5;7m`;
  }
  throw new Error(`Invalid color value: ${String(color)}`);
}

function bgAnsi(color: string | number, mode: "truecolor" | "256color"): string {
  if (color === "") return "\x1b[49m";
  if (typeof color === "number") return `\x1b[48;5;${color}m`;
  if (typeof color === "string" && color.startsWith("#")) {
    if (mode === "truecolor") {
      const { r, g, b } = hexToRgb(color);
      return `\x1b[48;2;${r};${g};${b}m`;
    }
    return `\x1b[48;5;0m`;
  }
  throw new Error(`Invalid color value: ${String(color)}`);
}

/**
 * 本地 Theme（不依赖 pi-coding-agent）：fg/bg 输出 ANSI，语义对齐官方 Theme。
 */
export class Theme {
  readonly name?: string;
  private readonly fgAnsiMap = new Map<string, string>();
  private readonly bgAnsiMap = new Map<string, string>();
  private readonly mode: "truecolor" | "256color";

  constructor(
    fgColors: Record<string, string | number>,
    bgColors: Record<string, string | number>,
    mode: "truecolor" | "256color" = "truecolor",
    options?: { name?: string },
  ) {
    this.mode = mode;
    this.name = options?.name;
    const colors = {
      ...fgColors,
      thinkingMax: fgColors.thinkingMax ?? fgColors.thinkingXhigh,
    };
    for (const [key, value] of Object.entries(colors)) {
      this.fgAnsiMap.set(key, fgAnsi(value, mode));
    }
    for (const [key, value] of Object.entries(bgColors)) {
      this.bgAnsiMap.set(key, bgAnsi(value, mode));
    }
  }

  fg(color: string, text: string): string {
    const ansi = this.fgAnsiMap.get(color);
    if (!ansi) throw new Error(`Unknown theme color: ${color}`);
    return `${ansi}${text}\x1b[39m`;
  }

  bg(color: string, text: string): string {
    const ansi = this.bgAnsiMap.get(color);
    if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
    return `${ansi}${text}\x1b[49m`;
  }

  bold(text: string): string {
    return `\x1b[1m${text}\x1b[22m`;
  }

  italic(text: string): string {
    return `\x1b[3m${text}\x1b[23m`;
  }

  underline(text: string): string {
    return `\x1b[4m${text}\x1b[24m`;
  }

  inverse(text: string): string {
    return `\x1b[7m${text}\x1b[27m`;
  }

  strikethrough(text: string): string {
    return `\x1b[9m${text}\x1b[29m`;
  }

  getFgAnsi(color: string): string {
    const ansi = this.fgAnsiMap.get(color);
    if (!ansi) throw new Error(`Unknown theme color: ${color}`);
    return ansi;
  }

  getBgAnsi(color: string): string {
    const ansi = this.bgAnsiMap.get(color);
    if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
    return ansi;
  }

  getColorMode(): "truecolor" | "256color" {
    return this.mode;
  }

  getThinkingBorderColor(level: string): (str: string) => string {
    const map: Record<string, string> = {
      off: "thinkingOff",
      minimal: "thinkingMinimal",
      low: "thinkingLow",
      medium: "thinkingMedium",
      high: "thinkingHigh",
      xhigh: "thinkingXhigh",
      max: "thinkingMax",
    };
    const key = map[level] ?? "thinkingOff";
    return (str) => this.fg(key, str);
  }

  getBashModeBorderColor(): (str: string) => string {
    return (str) => this.fg("bashMode", str);
  }
}

/** 固定渲染宽度；前端按 pre-wrap 展示。 */
export const RENDER_WIDTH = 100;

/** 渲染输出上限（P1-6）：最大行数 / 最大单行字符数 / 最大总字符数。 */
export const RENDER_MAX_LINES = 500;
export const RENDER_MAX_LINE_LENGTH = 4000;
export const RENDER_MAX_TOTAL_CHARS = 200 * 1024;

export type RenderedToolRender = { lines: string[] } | null;

/** pi-tui Component 的最小结构（只依赖 render 方法）。 */
interface RenderableComponent {
  render: (width: number) => string[];
}

type RenderResultRenderer = (
  result: unknown,
  options: unknown,
  theme: unknown,
  context: unknown,
) => unknown;

type RenderCallRenderer = (
  args: unknown,
  theme: unknown,
  context: unknown,
) => unknown;

/** 主题 JSON 结构（lib/pi-themes/dark.json 的投影）。 */
interface ThemeJson {
  name?: string;
  vars?: Record<string, string>;
  colors: Record<string, string | number>;
}

/** 背景色语义键（来自 theme.js 的 bgColorKeys）。 */
const BG_COLOR_KEYS = new Set([
  "selectedBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
]);

/**
 * 取工具定义的结果渲染器。
 * ToolDefinition.renderResult 运行时字段可能是 renderResult 或 ln（压缩字段名），双查。
 */
export function getToolRenderResultRenderer(
  def: unknown,
): RenderResultRenderer | undefined {
  if (!def || typeof def !== "object") return undefined;
  const d = def as Record<string, unknown>;
  const renderer = d.renderResult ?? d.ln;
  return typeof renderer === "function" ? (renderer as RenderResultRenderer) : undefined;
}

/** 取工具定义的调用渲染器（renderCall）。 */
export function getToolRenderCallRenderer(
  def: unknown,
): RenderCallRenderer | undefined {
  if (!def || typeof def !== "object") return undefined;
  const d = def as Record<string, unknown>;
  const renderer = d.renderCall;
  return typeof renderer === "function" ? (renderer as RenderCallRenderer) : undefined;
}

/**
 * 解析主题 JSON 的 vars 引用（镜像 theme.js 的 resolveVarRefs）。
 * 引用解析失败抛错，由调用方降级。
 */
function resolveVarRefs(
  value: string | number,
  vars: Record<string, string>,
  visited = new Set<string>(),
): string | number {
  if (typeof value === "number" || value === "" || value.startsWith("#")) return value;
  if (visited.has(value)) {
    throw new Error(`Circular variable reference detected: ${value}`);
  }
  if (!(value in vars)) {
    throw new Error(`Variable reference not found: ${value}`);
  }
  visited.add(value);
  return resolveVarRefs(vars[value], vars, visited);
}

/**
 * 从主题 JSON 构造 Theme（镜像 theme.js 的 createTheme：fallback + vars 解析 +
 * 背景/前景键分类；颜色模式固定 truecolor）。
 */
function createThemeFromJson(themeJson: ThemeJson): Theme {
  const colors = {
    ...themeJson.colors,
    thinkingMax: themeJson.colors.thinkingMax ?? themeJson.colors.thinkingXhigh,
  };
  const vars = themeJson.vars ?? {};
  const fgColors: Record<string, string | number> = {};
  const bgColors: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(colors)) {
    const resolved = resolveVarRefs(value, vars);
    if (BG_COLOR_KEYS.has(key)) bgColors[key] = resolved;
    else fgColors[key] = resolved;
  }
  return new Theme(fgColors, bgColors, "truecolor", { name: themeJson.name });
}

// 模块级缓存：undefined = 尚未加载；null = 加载失败（安全回退，不再重试）。
let cachedPiTheme: Theme | null | undefined;

/**
 * 加载 Pidance 自有副本的 dark 主题；失败返回 null（上层保持 PLAIN_TEXT_THEME 语义，
 * 即不附加渲染行、走原有纯文本展示路径）。
 */
export function loadPiTheme(): Theme | null {
  if (cachedPiTheme !== undefined) return cachedPiTheme;
  try {
    cachedPiTheme = createThemeFromJson(darkThemeJson);
  } catch {
    cachedPiTheme = null;
  }
  return cachedPiTheme;
}

/**
 * 渲染输出严格校验（P2-8 + P1-6）：
 * 非数组 / 空数组 / 混入非字符串元素 / 超行数 / 超单行长度 / 超总字符 → false。
 * 与前端校验语义一致：混合数组不再过滤后当成功，一律判非法。
 */
function isValidRenderOutput(lines: unknown): lines is string[] {
  if (!Array.isArray(lines) || lines.length === 0) return false;
  if (!lines.every((line) => typeof line === "string")) return false;
  if (lines.length > RENDER_MAX_LINES) return false;
  let total = 0;
  for (const line of lines) {
    if (line.length > RENDER_MAX_LINE_LENGTH) return false;
    total += line.length;
    if (total > RENDER_MAX_TOTAL_CHARS) return false;
  }
  return true;
}

/**
 * 渲染器返回值 → ANSI 行数组。
 * 返回非对象 / 无 render 方法 / render 抛错 / 输出非法或超限 → null（安全回退，
 * 超限返回 null 走原始回退，不做截断——截断会掩盖渲染器 bug）。
 */
function renderToLines(component: unknown, width: number = RENDER_WIDTH): string[] | null {
  if (!component || typeof component !== "object") return null;
  const c = component as { render?: unknown };
  if (typeof c.render !== "function") return null;
  try {
    const lines = (c as RenderableComponent).render(width);
    if (!isValidRenderOutput(lines)) return null;
    return lines;
  } catch {
    return null;
  }
}

/**
 * 渲染工具结果：调用渲染器 → Component → component.render(RENDER_WIDTH) → ANSI 行。
 * 渲染器抛错 / 无渲染器 / theme 加载失败 → 返回 null（不污染事件流）。
 * onComponent：渲染器返回组件（非空对象）时回调，供上层记录「上一组件」
 * （镜像 pi tool-renderer 的 renderedResultComponents 更新语义）。
 */
export function renderToolResultLines(
  def: unknown,
  result: unknown,
  options: { expanded: boolean; isPartial: boolean },
  context: Record<string, unknown>,
  onComponent?: (component: unknown) => void,
): string[] | null {
  const renderer = getToolRenderResultRenderer(def);
  if (!renderer) return null;
  const theme = loadPiTheme();
  if (!theme) return null;
  try {
    const component = renderer(result, options, theme, context);
    if (component && typeof component === "object") onComponent?.(component);
    return renderToLines(component);
  } catch {
    return null;
  }
}

/**
 * 渲染工具调用：调用 renderCall 渲染器 → Component → ANSI 行。
 * 失败路径同 renderToolResultLines；onComponent 语义同上（renderCall 槽）。
 */
export function renderToolCallLines(
  def: unknown,
  args: unknown,
  context: Record<string, unknown>,
  onComponent?: (component: unknown) => void,
): string[] | null {
  const renderer = getToolRenderCallRenderer(def);
  if (!renderer) return null;
  const theme = loadPiTheme();
  if (!theme) return null;
  try {
    const component = renderer(args, theme, context);
    if (component && typeof component === "object") onComponent?.(component);
    return renderToLines(component);
  } catch {
    return null;
  }
}

/**
 * 组件工厂形式的小部件渲染：调用 `(tui, theme) => Component` 工厂（如
 * pi-subagents async widget 的 buildWidgetComponent），headless 渲染为
 * ANSI 行数组。tui 参数传 undefined（插件忽略它），theme 传渲染桥主题。
 * 工厂非函数 / theme 为 null / 结果非组件 / 工厂或 render 抛错 / 输出
 * 非法或超限 → null（上层静默，不设置不 emit，保持「工厂失败不显示」现状）。
 *
 * **snapshot-only 范围（P1-7）**：每次调用渲染一次静态行快照，工厂的
 * state/invalidate 生命周期与事件驱动重渲染不支持；动态内容需插件主动
 * 再次 setWidget 才更新。输出同样受 renderToLines 上限约束。
 */
export function renderWidgetFactoryLines(
  factory: unknown,
  theme: Theme | null,
  width: number = RENDER_WIDTH,
): string[] | null {
  if (typeof factory !== "function") return null;
  if (!theme) return null;
  try {
    const component = (factory as (tui: unknown, th: Theme) => unknown)(undefined, theme);
    return renderToLines(component, width);
  } catch {
    return null;
  }
}

/**
 * 调用自定义消息渲染器（pi.registerMessageRenderer 注册，如 pi-subagents 的
 * SubagentControlNoticeComponent）→ headless render → ANSI 行数组。
 * 调用签名与 pi MessageRenderer 一致：`renderer(message, { expanded: true }, theme)`。
 * 无渲染器 / 非函数 / theme 为 null / 返回 undefined 或非组件 / 渲染抛错 /
 * 输出非法 → null（上层事件保持原样，前端回退 CustomMessageView 文本逻辑）。
 */
export function renderCustomMessageLines(
  renderer: unknown,
  message: unknown,
  theme: Theme | null,
  width: number = RENDER_WIDTH,
): string[] | null {
  if (typeof renderer !== "function") return null;
  if (!theme) return null;
  try {
    const component = (
      renderer as (
        msg: unknown,
        options: { expanded: boolean },
        th: Theme,
      ) => unknown
    )(message, { expanded: true }, theme);
    return renderToLines(component, width);
  } catch {
    return null;
  }
}
