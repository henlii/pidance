/**
 * 主题注册表（服务端）：内置主题 + 用户主题目录，以及「当前主题」的切换。
 *
 * 为什么要自己这一层：SDK 的主题加载函数（`getThemeByName` / `getAvailableThemesWithPaths` /
 * `loadThemeFromPath`）**没有从包入口导出**（`exports` 只允许 `.`、`./rpc-entry`、`./client`、
 * `./experimental/plugin`），而且它们按 node_modules 里的文件路径找主题 JSON —— 那既过不了
 * 本仓库「产物不得引用构建机路径」的红线，也不保证打包后文件还在。所以：
 * 内置主题用打包进产物的 JSON 副本（`lib/pi-themes/`），用户主题目录按 SDK 的同一约定
 * （`<agentDir>/themes/*.json`）扫描，实例化统一交给渲染桥注入的 SDK `Theme` 类。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./pi-paths";
import {
  createPiThemeFromJson,
  getBuiltinPiThemeJson,
  listBuiltinPiThemes,
  loadPiTheme,
  setCurrentPiTheme,
  type PiTheme,
} from "./tui-render-bridge";

/** 用户主题目录名（与 SDK `getCustomThemesDir()` 同约定：`<agentDir>/themes`）。 */
export const USER_THEMES_DIRNAME = "themes";

/** 单个用户主题文件的大小上限：主题是纯配置，超过这个体积的一定不是主题文件。 */
export const MAX_USER_THEME_BYTES = 256 * 1024;

/** 主题名不允许含 "/"（SDK 的 assertThemeNameIsValid：斜杠留给「亮/暗自动」设置）。 */
function isValidThemeName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && !name.includes("/");
}

export interface PiThemeInfo {
  name: string;
  /** 用户主题是磁盘上的真文件；内置主题没有再分文件，故缺省。 */
  path?: string;
}

/**
 * 读一个用户主题文件。坏文件（读不了 / 太大 / 不是 JSON / 形状不对 / 构造抛错）→ null。
 * 与 SDK 一致：清单里静默忽略，不在渲染路径上抛错。
 */
function loadUserTheme(themePath: string): PiTheme | null {
  try {
    const stat = statSync(themePath);
    if (!stat.isFile() || stat.size > MAX_USER_THEME_BYTES) return null;
    return createPiThemeFromJson(JSON.parse(readFileSync(themePath, "utf8")), themePath);
  } catch {
    return null;
  }
}

function listUserThemes(agentDir: string): PiThemeInfo[] {
  const dir = join(agentDir, USER_THEMES_DIRNAME);
  let entries: string[];
  try {
    if (!existsSync(dir)) return [];
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: PiThemeInfo[] = [];
  for (const file of entries) {
    if (!file.endsWith(".json")) continue;
    const themePath = join(dir, file);
    const theme = loadUserTheme(themePath);
    // 主题名取 JSON 里的 `name`（SDK 同：文件名不参与命名），没有名字的忽略。
    if (isValidThemeName(theme?.name)) out.push({ name: theme.name, path: themePath });
  }
  return out;
}

/**
 * 全部可见主题（内置 + 用户），按名字排序。
 * 内置优先：同名用户主题不覆盖内置（与 SDK 的 addTheme 先内置后用户一致）。
 */
export function listPiThemes(agentDir: string = getAgentDir()): PiThemeInfo[] {
  const seen = new Set<string>();
  const out: PiThemeInfo[] = [];
  for (const info of [...listBuiltinPiThemes(), ...listUserThemes(agentDir)]) {
    if (seen.has(info.name)) continue;
    seen.add(info.name);
    out.push(info);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 按名加载主题，**不切换**（对齐 SDK 的 `getTheme(name)`：只加载）。未知名字 → undefined。 */
export function loadPiThemeByName(
  name: unknown,
  agentDir: string = getAgentDir(),
): PiTheme | undefined {
  if (!isValidThemeName(name)) return undefined;
  const builtin = getBuiltinPiThemeJson(name);
  if (builtin !== undefined) return createPiThemeFromJson(builtin) ?? undefined;
  for (const info of listUserThemes(agentDir)) {
    if (info.name !== name || !info.path) continue;
    return loadUserTheme(info.path) ?? undefined;
  }
  return undefined;
}

/** 当前主题（与渲染桥同一份；首次调用加载内置 dark）。 */
export function getCurrentPiTheme(): PiTheme | null {
  return loadPiTheme();
}

export interface PiThemeSwitchResult {
  success: boolean;
  error?: string;
  /** 切成功时的主题名（实例可能没有名字）。 */
  name?: string;
}

/**
 * 切换当前主题。
 *
 * - 字符串：按名加载；未知名字 → `{success:false, error}`，**当前主题保持不变**。
 * - 实例：直接切（插件把 `ui.theme` 拿到的实例传回来时走这条）。判定是**鸭子类型**
 *   （有 `fg` 与 `bg` 两个函数），不是 `instanceof` —— 本模块不能 import SDK（SDK 的
 *   `Theme` 类只在 allowlist 的宿主模块里注入，见 lib/tui-render-bridge.ts），而 SDK 的
 *   `setTheme` 认的是它自己的类。收成「有取色方法」既能让真实例通过，也不会把随便一个
 *   带 `fg` 的对象装进全局槽位。
 *
 * 与 TUI 的一处**有意分叉**：SDK 的 `setTheme` 遇到坏名字会静默退回 dark 主题；
 * 这里不换用户的主题、只回报失败并由上层给一次可见提示 —— 静默把主题换成 dark
 * 比报错更糟（用户会以为是自己点的）。
 */
export function setPiTheme(
  target: unknown,
  agentDir: string = getAgentDir(),
): PiThemeSwitchResult {
  if (typeof target === "string") {
    const theme = loadPiThemeByName(target, agentDir);
    if (!theme) return { success: false, error: `Unknown theme: ${target}` };
    setCurrentPiTheme(theme);
    return { success: true, name: target };
  }
  const candidate = target as Partial<PiTheme> | null;
  if (candidate && typeof candidate === "object"
    && typeof candidate.fg === "function" && typeof candidate.bg === "function") {
    const theme = candidate as PiTheme;
    setCurrentPiTheme(theme);
    return { success: true, name: theme.name };
  }
  return { success: false, error: "Expected a theme name or a Theme instance" };
}
