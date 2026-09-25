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
 * 触发发布审计红线。故把 SDK 的主题复制为 Pidance 自有副本（`lib/pi-themes/*.json`），
 * 经 JSON import 打包进产物（无绝对路径），再按 Theme 构造签名解析 vars/colors 构造。
 *
 * 主题**实例**是 SDK 的 `Theme` 类：渲染桥自己不 import SDK（保持纯逻辑、可单测，
 * 也守住 SDK import 边界），由宿主静态 import 后经 `setPiThemeConstructor` 注入 ——
 * 这样 `ui.theme` / `getTheme()` 返回的是**真 Theme**，插件的 `instanceof Theme`
 * 判定与 SDK 自己的 `setTheme(Theme 实例)` 分支都能成立（issue #97）。
 *
 * 同一份主题还要装进 **SDK 的全局主题槽位**：SDK 的主题助手（renderDiff 等）读的是
 * globalThis 上按 Symbol.for 挂的单例，不是传进去的主题 —— 不装就没有 diff（issue #69）。
 * 槽位随主题切换一起改写（见 setCurrentPiTheme）。
 */

import darkThemeJson from "./pi-themes/dark.json" with { type: "json" };
import lightThemeJson from "./pi-themes/light.json" with { type: "json" };

/**
 * 主题实例的最小结构：只声明渲染桥与插件实际用到的成员。
 * 真实实例是 SDK 的 `Theme`（见 setPiThemeConstructor），子类只改五个文本样式方法。
 */
export interface PiTheme {
  name?: string;
  sourcePath?: string;
  sourceInfo?: unknown;
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  underline(text: string): string;
  inverse(text: string): string;
  strikethrough(text: string): string;
  getFgAnsi(color: string): string;
  getBgAnsi(color: string): string;
  getColorMode(): "truecolor" | "256color";
  getThinkingBorderColor(level: string): (text: string) => string;
  getBashModeBorderColor(): (text: string) => string;
}

/** SDK `Theme` 的构造签名（宿主注入用）。 */
export type PiThemeConstructor = new (
  fgColors: Record<string, string | number>,
  bgColors: Record<string, string | number>,
  mode: "truecolor" | "256color",
  options?: { name?: string; sourcePath?: string; sourceInfo?: unknown },
) => PiTheme;

let ThemeClass: PiThemeConstructor | null = null;

/**
 * 给文本套一层样式转义，**与 chalk level 3（TUI 的取值）逐字节一致**。
 *
 * 为什么不是简单首尾包一层：chalk 对**多行**文本会在每个换行处先关后开
 * （`"a\nb"` → `\x1b[1ma\x1b[22m\n\x1b[1mb\x1b[22m`）。浏览器侧是**逐行**解析 ANSI 的，
 * 只包首尾的话第二行起就丢了样式；非 TTY 进程里 chalk 本身又不输出样式（见下），
 * 所以这里必须自己按 chalk 的规则重开。
 *
 * 与 chalk 的已知边界：只有**多行**这一处需要重开；chalk 对文本里已有的 ESC 不会重开
 * （`bold("a\x1b[31mb")` = `\x1b[1ma\x1b[31mb\x1b[22m`），这里也一致。
 */
function wrapTextStyle(open: string, close: string, text: string): string {
  return `${open}${text.replace(/\r?\n/g, `${close}$&${open}`)}${close}`;
}

/**
 * 注入 SDK 的 `Theme` 类（宿主静态 import SDK 后传入；渲染桥自己不 import SDK）。
 *
 * 子类只替换五个**文本样式**方法，其余（fg/bg/getFgAnsi/getThinkingBorderColor/…）
 * 全部沿用 SDK 实现 —— 包括构造器里的颜色回退（scrollbarTrack/scrollbarThumb/
 * searchMatchBg/searchMatchText/thinkingMax）。
 *
 * 为什么必须替换这五个：SDK 的 `Theme.bold/italic/…` 走 chalk，而 chalk 在**非 TTY**
 * 进程（我们的服务端就是）判定 `level = 0` 并直接返回纯文本 —— 我们真正的渲染出口
 * 是浏览器（解析 ANSI），这些样式会静默丢掉。这里输出的转义序列与 TUI（chalk level 3）
 * 逐字节相同。
 */
export function setPiThemeConstructor(base: PiThemeConstructor | null): void {
  if (!base) {
    ThemeClass = null;
    return;
  }
  ThemeClass = class extends base {
    bold(text: string): string {
      return wrapTextStyle("\x1b[1m", "\x1b[22m", text);
    }
    italic(text: string): string {
      return wrapTextStyle("\x1b[3m", "\x1b[23m", text);
    }
    underline(text: string): string {
      return wrapTextStyle("\x1b[4m", "\x1b[24m", text);
    }
    inverse(text: string): string {
      return wrapTextStyle("\x1b[7m", "\x1b[27m", text);
    }
    strikethrough(text: string): string {
      return wrapTextStyle("\x1b[9m", "\x1b[29m", text);
    }
  };
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

/** 背景色语义键（镜像 SDK theme.js 的 bgColorKeys，7 个都要有：漏一个就会被当成前景色）。 */
const BG_COLOR_KEYS = new Set([
  "selectedBg",
  "searchMatchBg",
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
 * 从主题 JSON 构造 Theme 实例（镜像 SDK theme.js 的 createTheme：vars 解析 +
 * 前景/背景键分类；颜色模式固定 truecolor，颜色回退由 SDK 构造器自己补）。
 *
 * 主题 JSON 是**外部数据**（用户主题目录里的文件会走到这里），所以整个解析按未知
 * 输入对待：形状不对 / vars 引用解析不了 / 构造抛错 → null（调用方忽略该主题）。
 */
export function createPiThemeFromJson(themeJson: unknown, sourcePath?: string): PiTheme | null {
  if (!ThemeClass) return null;
  const json = themeJson as ThemeJson | null | undefined;
  if (!json || typeof json !== "object" || !json.colors || typeof json.colors !== "object") {
    return null;
  }
  try {
    const vars = json.vars ?? {};
    const fgColors: Record<string, string | number> = {};
    const bgColors: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(json.colors)) {
      const resolved = resolveVarRefs(value, vars);
      if (BG_COLOR_KEYS.has(key)) bgColors[key] = resolved;
      else fgColors[key] = resolved;
    }
    return new ThemeClass(fgColors, bgColors, "truecolor", {
      name: typeof json.name === "string" ? json.name : undefined,
      sourcePath,
    });
  } catch {
    return null;
  }
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
 * （键名被 SDK 改掉、或槽位被清掉时会抛错）。
 *
 * - `true`：可用（进程内只跑一次成功即缓存）；
 * - `false`：不可用，并已报一次可见告警（**不缓存** —— 槽位可能是稍后才装上的，
 *   下次自检要能转好，否则「还没装」会被永久记成「装不进去」）；
 * - `null`：宿主还没接探针、或主题实例还没建起来（宿主还没注入 `Theme` 类），无法判定。
 *
 * **自检前先装槽位**：宿主在 `bindExtensions` 期间就调用这里，而那次调用可能早于
 * 任何一次渲染（槽位只在 `loadPiTheme` / `setCurrentPiTheme` 里写）。不先装就会把
 * 「还没装」误判成「装不进去」，并给用户报一条「diff 画不出来」的假告警（issue #97 审查）。
 * `installSdkGlobalTheme` 是幂等的，重复装同一个实例无害。
 */
export function verifySdkGlobalTheme(): boolean | null {
  if (sdkThemeVerified === true) return true;
  if (!sdkThemeProbe) return null;
  const theme = loadPiTheme();
  if (!theme) return null;
  installSdkGlobalTheme(theme);
  try {
    sdkThemeProbe();
    sdkThemeVerified = true;
    return true;
  } catch (error) {
    reportBridgeWarning(
      "sdk-theme-verify",
      `${SDK_THEME_WARNING} (self-check failed: ${error instanceof Error ? error.message : String(error)})`,
    );
    return false;
  }
}

/**
 * 把主题装进 SDK 的全局槽位（幂等：同一个实例重复装无害，切主题时改写为新实例）。
 * 写入抛错（例如 globalThis 被冻结）→ 报一次告警并放弃。
 * 可用性由宿主的 `verifySdkGlobalTheme()` 在接好探针后确认（见上）。
 */
function installSdkGlobalTheme(theme: PiTheme): void {
  try {
    const slots = globalThis as unknown as Record<symbol, unknown>;
    slots[SDK_THEME_KEY] = theme;
    slots[SDK_THEME_KEY_LEGACY] = theme;
  } catch (error) {
    reportBridgeWarning(
      "sdk-theme-install",
      `${SDK_THEME_WARNING} (install failed: ${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** 测试用：清掉自检结果缓存（不动槽位、不清告警去重），让「自检 → 装槽位 → 再自检」可重跑。 */
export function resetSdkThemeVerificationForTests(): void {
  sdkThemeVerified = null;
}

/**
 * 测试用：当前的主题变化订阅者数量。
 *
 * 订阅者是**常驻资源**（每个 live host / 适配器一个）：宿主回收时没退订就会越攒越多，
 * 每次切主题都要白跑一遍已死会话的重渲。
 */
export function piThemeChangeListenerCountForTests(): number {
  return themeChangeListeners.size;
}

/** 内置主题（副本 JSON 打包进产物，无运行时文件路径）。 */
const BUILTIN_THEME_JSON: Record<string, unknown> = {
  dark: darkThemeJson,
  light: lightThemeJson,
};

/**
 * 内置主题清单。
 *
 * `path` 一律 undefined：内置主题是**打包进产物的 JSON 副本**，磁盘上没有可读文件，
 * 给一个不存在的路径比不给更坑（插件会拿它去 readFileSync）。用户主题目录里的主题
 * 有真路径，由上层（宿主/适配器）补齐。
 */
export function listBuiltinPiThemes(): { name: string; path?: string }[] {
  return Object.keys(BUILTIN_THEME_JSON).map((name) => ({ name }));
}

/** 内置主题 JSON（按名取；未知名字返回 undefined）。 */
export function getBuiltinPiThemeJson(name: string): unknown {
  return BUILTIN_THEME_JSON[name];
}

// 模块级当前主题：undefined = 尚未加载；null = 加载失败（安全回退，不再重试）。
let currentTheme: PiTheme | null | undefined;

/** 主题切换订阅者（每个 live host 一个，用于重渲已渲染的插件产出）。 */
const themeChangeListeners = new Set<() => void>();

/**
 * 当前主题；首次调用时加载内置 dark（与切换前行为一致）。
 *
 * 失败返回 null（上层保持 PLAIN_TEXT_THEME 语义，即不附加渲染行、走原有纯文本展示路径）。
 */
export function loadPiTheme(): PiTheme | null {
  if (currentTheme !== undefined) return currentTheme;
  // 宿主还没注入 SDK 的 `Theme` 类时**不缓存** null：否则会把「还没接好」误记成
  // 「主题坏了」，以后永远返回 null（关掉渲染桥）。
  if (!ThemeClass) return null;
  const theme = createPiThemeFromJson(BUILTIN_THEME_JSON.dark);
  currentTheme = theme;
  // SDK 的主题助手读的是它的全局槽位（见上）：装一次，否则插件渲染器里依赖
  // 主题助手的部分（内置 edit 的 diff 等）会静默不显示。可用性由宿主自检。
  if (theme) installSdkGlobalTheme(theme);
  return currentTheme;
}

/** 切成另一个主题实例（全局槽位同步改写），并通知订阅者重渲。 */
export function setCurrentPiTheme(theme: PiTheme): void {
  currentTheme = theme;
  installSdkGlobalTheme(theme);
  for (const listener of [...themeChangeListeners]) {
    try {
      listener();
    } catch (error) {
      // 订阅者（某个会话的重渲）抛错不能阻断其它会话：降级成诊断日志。
      console.error("[pidance] theme change listener failed:", error);
    }
  }
}

/**
 * 订阅主题切换。
 *
 * 主题是**进程级**的（与 SDK/TUI 一致），所以一个会话切主题影响所有会话；
 * 已渲染的插件行要在切后重算，否则它会保留旧主题的颜色。
 */
export function onPiThemeChange(listener: () => void): () => void {
  themeChangeListeners.add(listener);
  return () => {
    themeChangeListeners.delete(listener);
  };
}

/**
 * 插件组件（widget / custom 面板）拿到的主题：**每次属性访问都解析当前主题**。
 *
 * 为什么必须是视图而不是实例：组件实例是**常驻**的（widget 由工厂建一次、之后靠
 * `requestRender` 重渲），主题实例的颜色在构造时就进了 Map —— 把当时的实例闭进工厂，
 * 之后切主题只会让组件用旧颜色重画一遍。TUI 传给工厂的也是**会读全局槽位的 Proxy**
 * （`interactive-mode.js` 的 widget/custom 路径），不是快照。
 *
 * 与 issue #72 的旧 Proxy 的区别（那次是 bug）：旧 Proxy 对**所有**属性一律返回可调用
 * 透传，把 `theme.sourcePath` 这类数据字段也变成函数；这里返回的是真主题上的原值，
 * 只有函数才绑到当前实例上。
 */
export function createLivePiTheme(fallback?: () => unknown): PiTheme {
  return new Proxy({} as PiTheme, {
    get(_target, property) {
      // 主题读不到时用调用方给的回退（适配器传的是存根：老行为是「永远有个主题可读」）——
      // 没给回退就返回 undefined，由调用方的 try/catch 处理。
      const theme = (loadPiTheme() ?? fallback?.()) as PiTheme | null | undefined;
      if (!theme) return undefined;
      const value = Reflect.get(theme as object, property);
      // 方法要绑到**当前**实例：直接把方法取出来再调用会让 `this` 丢成 Proxy。
      return typeof value === "function" ? value.bind(theme) : value;
    },
    has(_target, property) {
      const theme = loadPiTheme();
      return theme ? Reflect.has(theme as object, property) : false;
    },
  });
}

/** 测试用：清空主题状态（不动 SDK 全局槽位，方便重测首次加载）。 */
export function resetPiThemeForTests(): void {
  currentTheme = undefined;
  themeChangeListeners.clear();
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
  theme: PiTheme | null,
  width: number = RENDER_WIDTH,
): string[] | null {
  if (typeof factory !== "function") return null;
  if (!theme) return null;
  try {
    const component = (factory as (tui: unknown, th: PiTheme) => unknown)(undefined, theme);
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
  theme: PiTheme | null,
  width: number = RENDER_WIDTH,
): string[] | null {
  if (typeof renderer !== "function") return null;
  if (!theme) return null;
  try {
    const component = (
      renderer as (
        msg: unknown,
        options: { expanded: boolean },
        th: PiTheme,
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
  theme: PiTheme | null,
  width: number = RENDER_WIDTH,
): string[] | null {
  if (typeof renderer !== "function") return null;
  if (!theme) return null;
  try {
    const component = (
      renderer as (
        e: unknown,
        options: { expanded: boolean },
        th: PiTheme,
      ) => unknown
    )(entry, { expanded: true }, theme);
    return renderToLines(component, width);
  } catch (error) {
    reportIfSdkThemeError(error);
    return null;
  }
}
