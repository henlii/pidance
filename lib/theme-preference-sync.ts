/**
 * 壳的明暗偏好 ↔ 插件主题的同步（服务端）。
 *
 * 背景（issue #97 审查）：dark/light 在 TUI 里**只有一个主题**。Web 这边拆成了两半 ——
 * 壳的明暗（`theme.mode` 偏好，chunk 由客户端渲染）与插件 ANSI 用的 SDK 主题（进程级）。
 * 插件调 `ctx.ui.setTheme("light")` 会让两半一致，但**重启**后壳按偏好恢复成 light、
 * 插件主题却回到默认的 dark；用户在设置里自己切明暗时插件侧也不会跟着动。
 *
 * 这里补的就是这两条对齐：
 * - 启动时（宿主第一次渲染之前）按 `theme.mode` 把插件主题设成同名内置主题；
 * - 用户改壳明暗（客户端 PUT /api/preferences）后同步插件主题。
 *
 * 不做映射的情况：`theme.mode` 为 `system` 时壳的实际明暗由**客户端**决定
 * （`prefers-color-scheme`），服务端不知道解析结果，故不动插件主题；用户自定义主题
 * （非 dark/light）也没有壳侧的对应外观，同样不动。
 */
import { getPidancePref, readPidancePrefs, type PidancePrefs } from "./pidance-prefs-file";
import { getAgentDir } from "./pi-paths";
import { getCurrentPiTheme, setPiTheme } from "./pi-theme-registry";

/** 能从偏好里读出的、有壳侧对应外观的主题名。 */
type ShellThemeMode = "dark" | "light";

function readShellThemeMode(prefs: PidancePrefs): ShellThemeMode | null {
  const theme = getPidancePref(prefs, "theme");
  if (!theme || typeof theme !== "object") return null;
  const mode = (theme as { mode?: unknown }).mode;
  return mode === "dark" || mode === "light" ? mode : null;
}

/**
 * 把插件主题对齐到壳的明暗偏好（幂等：已经同名就不动，避免无谓的重渲与全局槽位改写）。
 *
 * 返回是否真的切了。读偏好失败按「不动」处理：插件主题保持现状，不影响请求本身。
 */
export function syncPiThemeWithShellPreference(
  prefs: PidancePrefs = readPidancePrefs(),
  agentDir: string = getAgentDir(),
): boolean {
  const mode = readShellThemeMode(prefs);
  if (!mode) return false;
  // 同名就跳过：偏好会被反复写（每次客户端 PUT 都带整包 theme），不能每次都重建实例
  // 并触发一轮全量重渲。
  if (getCurrentPiTheme()?.name === mode) return false;
  const result = setPiTheme(mode, agentDir);
  if (!result.success) {
    // 内置主题一定存在；走到这里说明副本坏了 —— 保持现状并留一条诊断。
    console.warn(`[pidance] could not align pi theme with shell preference: ${result.error}`);
    return false;
  }
  return true;
}

/**
 * 进程内只对齐一次：宿主在第一次真正渲染之前调用。
 *
 * 为什么是「一次」：主题是进程级的，多个会话的宿主要用同一个插件主题；而用户之后的
 * 每次明暗切换都走 {@link syncPiThemeWithShellPreference}（偏好写入路径），不需要重复对齐。
 */
let startupAligned = false;

export function alignPiThemeWithShellPreferenceOnStartup(agentDir: string = getAgentDir()): void {
  if (startupAligned) return;
  startupAligned = true;
  try {
    syncPiThemeWithShellPreference(readPidancePrefs(agentDir), agentDir);
  } catch (error) {
    // 对齐失败不能让宿主构造失败：插件主题停在默认值，其余功能照常。
    console.error("[pidance] failed to align pi theme with shell preference:", error);
  }
}

/** 测试用：允许重新走一次启动对齐。 */
export function resetPiThemeAlignmentForTests(): void {
  startupAligned = false;
}
