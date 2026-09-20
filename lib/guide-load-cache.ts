/**
 * 新会话引导页（NewSessionGuide）的纯逻辑：项目列表聚合与「已添加项目」合并。
 *
 * 项目 = 目录，一对一：每个候选项目就是会话 cwd 本身，不再按 worktree 归并。
 * 抽为纯模块以便 node:test 覆盖；组件只负责 UI 状态映射。
 */

export interface GuideProject {
  cwd: string;
  count: number;
  latest: number;
}

export function aggregateGuideProjects(
  sessions: ReadonlyArray<{ cwd?: string; created?: string; modified?: string }>,
  limit = 12,
  extraRoots: readonly string[] = [],
): GuideProject[] {
  const byCwd = new Map<string, { count: number; latest: number }>();
  for (const s of sessions) {
    if (!s.cwd) continue;
    const ts = s.modified
      ? Date.parse(s.modified)
      : s.created
        ? Date.parse(s.created)
        : 0;
    const entry = byCwd.get(s.cwd) ?? { count: 0, latest: 0 };
    entry.count += 1;
    if (ts > entry.latest) entry.latest = ts;
    byCwd.set(s.cwd, entry);
  }
  const projects = [...byCwd.entries()]
    .map(([cwd, v]) => ({ cwd, count: v.count, latest: v.latest }))
    .sort((a, b) => b.latest - a.latest)
    .slice(0, limit);
  return mergeAddedProjectRoots(projects, extraRoots, limit);
}

/**
 * 目标目录不在列表内时补一个临时项（count=0），返回新数组（无变化时原引用）。
 * 下拉显示的目标必须等于新会话真正落在的目录；临时项只用于展示，
 * 绝不写入 projectRoots。
 */
export function withTargetProject(projects: GuideProject[], targetCwd: string | null): GuideProject[] {
  if (!targetCwd || projects.some((project) => project.cwd === targetCwd)) return projects;
  return [{ cwd: targetCwd, count: 0, latest: 0 }, ...projects];
}

/**
 * 把「无会话的已添加项目」并入项目列表：置顶便于刚添加即可见
 * （与侧栏空项目置顶语义一致），已知项目不重复，仍受 limit 约束。
 */
export function mergeAddedProjectRoots(
  projects: GuideProject[],
  extraRoots: readonly string[],
  limit = 12,
): GuideProject[] {
  const known = new Set(projects.map((p) => p.cwd));
  const extra = extraRoots.filter((root) => !known.has(root)).map((cwd) => ({ cwd, count: 0, latest: 0 }));
  // 无新增时返回原数组（调用方按引用判等，避免无谓重渲染）。
  return extra.length > 0 ? [...extra, ...projects].slice(0, limit) : projects;
}
