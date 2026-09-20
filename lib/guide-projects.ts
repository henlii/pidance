/**
 * 新会话引导页项目下拉的纯逻辑。
 *
 * 项目来源唯一 = 侧栏项目列表（`projectRoots`）：引导页与侧栏项目区是同一个列表，
 * 不再按「最近会话 cwd」聚合出侧栏没显示的目录。
 */

/**
 * 下拉候选项：项目列表原样，外加当前目标。
 *
 * 目标不在列表里（刷新恢复的上次目标、`?session=` 深链进来的目录）时补一个临时项，
 * 保证「下拉显示的目标 = 新会话真正落在的目录」；临时项只用于展示，不写入项目列表。
 */
export function guideProjectOptions(
  projectRoots: readonly string[],
  targetCwd: string | null,
): string[] {
  if (!targetCwd || projectRoots.includes(targetCwd)) return [...projectRoots];
  return [targetCwd, ...projectRoots];
}
