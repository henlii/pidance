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
 *
 * 同一份主题还要装进 **SDK 的全局主题槽位**：SDK 的主题助手（renderDiff 等）读的是
 * globalThis 上按 Symbol.for 挂的单例，不是传进去的主题 —— 不装就没有 diff（issue #69）。
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

// ---------------------------------------------------------------------------
// SDK 全局主题槽位 + 渲染桥告警出口（issue #69）
// ---------------------------------------------------------------------------

/**
 * SDK 的主题助手（`renderDiff` / `getMarkdownTheme` / `getSelectListTheme` …）读的不是
 * 传给它们的主题，而是 SDK 自己在 `globalThis` 上按 `Symbol.for` 挂的**全局单例** ——
 * 取不到就抛 `Theme not initialized. Call n() first.`。内置 edit 渲染器的 diff 正是画在
 * 这条路径上：我们只建了自己的主题（`loadPiTheme`）、从没写过那个槽位，于是它一抛错就被
 * 渲染桥吞掉，调用卡永远只剩头部。
 *
 * SDK 只公开了 `initTheme(name)`（自建实例、颜色模式按终端能力推断），没有公开
 * `setThemeInstance`；但它内部的 `setGlobalTheme` 就是往下面这两个 Symbol 键上写。
 * 这里按**同一约定**写入我们自己的实例，保证头部与 diff 用同一个主题、同一种颜色模式。
 * 键名一旦被 SDK 改掉，自检会报一次可见告警（见 `verifySdkGlobalTheme`）。
 */
const SDK_THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const SDK_THEME_KEY_LEGACY = Symbol.for("@mariozechner/pi-coding-agent:theme");

/** 告警文案：说明**影响**，而不只是「失败了」。 */
const SDK_THEME_WARNING =
  "Extension renderers that rely on the SDK theme helpers will not draw their themed content "
  + "(for example the built-in edit tool's diff): Pidance could not hand its theme to the shared "
  + "pi theme slot.";

/** SDK 主题助手在槽位缺失 / 未初始化时抛错的特征串。 */
const SDK_THEME_UNINITIALIZED_PATTERN = /Theme not initialized/i;

let sdkThemeInstalled = false;
let sdkThemeVerified: boolean | null = null;
const reportedBridgeWarnings = new Set<string>();
const pendingBridgeWarnings: string[] = [];
let bridgeWarningSink: ((message: string) => void) | null = null;

/**
 * 宿主接入告警出口（emit 一条 warning 通知）。接入前产生的告警先缓冲、接入时补发 ——
 * 主题是在宿主构造期装的，若不做缓冲，那条告警会赶在出口就位之前产生而丢掉。
 */
export function setRenderBridgeWarningSink(
  sink: ((message: string) => void) | null,
): void {
  bridgeWarningSink = sink;
  if (!sink) return;
  for (const message of pendingBridgeWarnings.splice(0)) sink(message);
}

/** 测试用：清掉「已报过」与缓冲（不动全局主题槽位）。 */
export function resetRenderBridgeWarningsForTests(): void {
  reportedBridgeWarnings.clear();
  pendingBridgeWarnings.length = 0;
  bridgeWarningSink = null;
}

/**
 * 报一次**宿主配置类**问题（每种原因只报一次）：console.warn + 宿主告警出口。
 * 插件渲染器自身的错误不走这里 —— 那类按既有口径静默回退（见 issue #71/#72）。
 */
function reportBridgeWarning(reason: string, message: string): void {
  if (reportedBridgeWarnings.has(reason)) return;
  reportedBridgeWarnings.add(reason);
  console.warn(`[pidance] ${message}`);
  if (!bridgeWarningSink) {
    pendingBridgeWarnings.push(message);
    return;
  }
  try {
    bridgeWarningSink(message);
  } catch (error) {
    // 告警出口自己抛错不能反过来打断渲染：降级成诊断日志。
    console.warn("[pidance] render bridge warning sink failed:", error);
  }
}

/**
 * 槽位缺失导致的渲染失败要**可见**：识别 SDK 主题助手的特征错并报一次；
 * 其它异常（插件渲染器自己的 bug）保持静默回退，不刷告警。
 */
function reportIfSdkThemeError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (!SDK_THEME_UNINITIALIZED_PATTERN.test(message)) return;
  reportBridgeWarning("sdk-theme-uninitialized", `${SDK_THEME_WARNING} (${message})`);
}

let sdkThemeProbe: (() => void) | null = null;

/**
 * 注入「SDK 主题助手」探针：宿主静态 import SDK 后接一个会读全局主题的调用
 * （例如 `renderDiff("+ a\n- b\n")`）。**渲染桥自己不 import SDK** —— 保持纯逻辑、
 * 可单测，也守住仓库的 SDK import 边界（只有 allowlist 里的 server adapter 能静态 import）。
 */
export function setSdkThemeProbe(probe: (() => void) | null): void {
  sdkThemeProbe = probe;
}

/**
 * 自检：跑一次注入的探针，确认我们写入的槽位真的能被 SDK 的主题助手读到
 * （键名被 SDK 改掉、或槽位被清掉时会抛错）。结果缓存，进程内只跑一次。
 * - `true`：可用；
 * - `false`：不可用，并已报一次可见告警；
 * - `null`：宿主还没接探针，无法判定（调用方稍后再试）。
 */
export function verifySdkGlobalTheme(): boolean | null {
  if (sdkThemeVerified !== null) return sdkThemeVerified;
  if (!sdkThemeProbe) return null;
  try {
    sdkThemeProbe();
    sdkThemeVerified = true;
    return true;
  } catch (error) {
    sdkThemeVerified = false;
    reportBridgeWarning(
      "sdk-theme-verify",
      `${SDK_THEME_WARNING} (self-check failed: ${error instanceof Error ? error.message : String(error)})`,
    );
    return false;
  }
}

/**
 * 幂等地把主题装进 SDK 的全局槽位。写入抛错（例如 globalThis 被冻结）→ 报一次告警并放弃。
 * 可用性由宿主的 `verifySdkGlobalTheme()` 在接好探针后确认（见上）。
 */
function ensureSdkGlobalTheme(theme: Theme): void {
  if (sdkThemeInstalled) return;
  sdkThemeInstalled = true;
  try {
    const slots = globalThis as unknown as Record<symbol, unknown>;
    slots[SDK_THEME_KEY] = theme;
    slots[SDK_THEME_KEY_LEGACY] = theme;
  } catch (error) {
    reportBridgeWarning(
      "sdk-theme-install",
      `${SDK_THEME_WARNING} (install failed: ${error instanceof Error ? error.message : String(error)})`,
    );
    return;
  }
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
    const theme = createThemeFromJson(darkThemeJson);
    cachedPiTheme = theme;
    // SDK 的主题助手读的是它的全局槽位（见上）：装一次，否则插件渲染器里依赖
    // 主题助手的部分（内置 edit 的 diff 等）会静默不显示。可用性由宿主自检。
    ensureSdkGlobalTheme(theme);
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
  } catch (error) {
    reportIfSdkThemeError(error);
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
  width: number = RENDER_WIDTH,
): string[] | null {
  const renderer = getToolRenderResultRenderer(def);
  if (!renderer) return null;
  const theme = loadPiTheme();
  if (!theme) return null;
  try {
    const component = renderer(result, options, theme, context);
    if (component && typeof component === "object") onComponent?.(component);
    return renderToLines(component, width);
  } catch (error) {
    reportIfSdkThemeError(error);
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
  width: number = RENDER_WIDTH,
): string[] | null {
  const renderer = getToolRenderCallRenderer(def);
  if (!renderer) return null;
  const theme = loadPiTheme();
  if (!theme) return null;
  try {
    const component = renderer(args, theme, context);
    if (component && typeof component === "object") onComponent?.(component);
    return renderToLines(component, width);
  } catch (error) {
    reportIfSdkThemeError(error);
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
  } catch (error) {
    reportIfSdkThemeError(error);
    return null;
  }
}

/**
 * 渲染一个**已存在**的组件实例 → ANSI 行数组。
 *
 * 工具槽复读用（issue #69 修复）：SDK 内置 edit 的 `renderResult` 会**就地把 diff/预览
 * 写回 renderCall 建出来的那个组件**（`setEditPreview` 改的就是 `context.state.callComponent`，
 * 与我们记的 `lastCallComponent` 是同一个实例），而那之后它可能返回空容器（
 * `formatEditResult` 在 resultDiff 与预览相同时返回 undefined）—— diff 只存在于调用槽里。
 * 所以重算路径要在 result 之后再读一次调用组件，否则推出去的是旧预览。
 * 失败 / 无 render 方法 / 输出非法或超限 → null（调用方保留上一次的行）。
 */
export function renderComponentLines(
  component: unknown,
  width: number = RENDER_WIDTH,
): string[] | null {
  return renderToLines(component, width);
}

/**
 * 渲染一个**已挂载**的组件实例 → ANSI 行数组。
 *
 * 供工厂形式 setWidget 的热更新路径复用：工厂只调用一次、实例常驻，
 * `requestRender()` 时对该实例重新渲染（见 lib/web-extension-ui.ts）。
 * 失败 / 无 render 方法 / 输出非法或超限 → null（上层保留上一次的行，不推空帧）。
 */
export function renderWidgetComponentLines(
  component: unknown,
  width: number = RENDER_WIDTH,
): string[] | null {
  return renderComponentLines(component, width);
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
  } catch (error) {
    reportIfSdkThemeError(error);
    return null;
  }
}

/**
 * 调用自定义 entry 渲染器（`pi.registerEntryRenderer` 注册，如 pi-subagents 的
 * supervisor reply / watchdog warning）→ headless render → ANSI 行数组。
 *
 * 调用签名与 pi `EntryRenderer` 一致：`renderer(entry, { expanded: true }, theme)`。
 * `expanded: true` 是有意的：entries 没有 Web 侧的展开设置，取内容最多的形态，
 * 折叠由前端的卡片承担（与自定义消息同一取舍）。
 *
 * 失败语义与 `renderCustomMessageLines` 一致：无渲染器 / 非函数 / theme 为 null /
 * 渲染抛错 / 返回 undefined 或非组件 / 输出非法 → null。与 TUI 的差别：TUI 在
 * 渲染器抛错时会画一个错误框，Web 这里只隐藏（见 issue #71 的取舍）。
 */
export function renderCustomEntryLines(
  renderer: unknown,
  entry: unknown,
  theme: Theme | null,
  width: number = RENDER_WIDTH,
): string[] | null {
  if (typeof renderer !== "function") return null;
  if (!theme) return null;
  try {
    const component = (
      renderer as (
        e: unknown,
        options: { expanded: boolean },
        th: Theme,
      ) => unknown
    )(entry, { expanded: true }, theme);
    return renderToLines(component, width);
  } catch (error) {
    reportIfSdkThemeError(error);
    return null;
  }
}
