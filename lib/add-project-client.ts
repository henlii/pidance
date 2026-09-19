// 添加项目弹窗的客户端逻辑（UI 层消费）。
//
// 服务端 app/api/cwd/{browse,validate,create} 为权威：本模块只做 fetch 封装与结果
// 分类（列表解析、校验结果归类、创建结果归类），不判断路径合法性。
// fetch 可注入便于测试；分类结果里带出服务端规范化后的绝对路径。

export type BrowseEntry = { name: string; path: string };
export type BrowseGitInfo = { isRepo: boolean; branch: string | null };

export interface DirectoryListing {
  /** 服务端列目录成功；false = 不存在/不可读（UI 显示「目录不存在」，不弹窗） */
  ok: boolean;
  /** 列出的目录（服务端规范化的绝对路径）；ok=false 时为 null */
  path: string | null;
  parentPath: string | null;
  entries: BrowseEntry[];
  git: BrowseGitInfo | null;
}

function isEntry(value: unknown): value is BrowseEntry {
  const entry = value as BrowseEntry | null;
  return typeof entry?.name === "string" && typeof entry?.path === "string";
}

function isGitInfo(value: unknown): value is BrowseGitInfo {
  const git = value as BrowseGitInfo | null;
  return typeof git?.isRepo === "boolean";
}

const EMPTY_LISTING: DirectoryListing = { ok: false, path: null, parentPath: null, entries: [], git: null };

/** 列出目录子目录 + git 状态；不存在/不可读/解析失败一律 ok=false。 */
export async function browseProjectDirectory(
  rawPath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DirectoryListing> {
  try {
    const res = await fetchImpl(`/api/cwd/browse?path=${encodeURIComponent(rawPath)}`);
    if (!res.ok) return EMPTY_LISTING;
    const data = (await res.json().catch(() => null)) as {
      path?: string;
      parentPath?: string | null;
      entries?: unknown;
      git?: unknown;
    } | null;
    if (!data || typeof data !== "object") return EMPTY_LISTING;
    return {
      ok: true,
      path: typeof data.path === "string" && data.path ? data.path : rawPath,
      parentPath: typeof data.parentPath === "string" ? data.parentPath : null,
      entries: Array.isArray(data.entries) ? data.entries.filter(isEntry) : [],
      git: isGitInfo(data.git) ? data.git : null,
    };
  } catch {
    return EMPTY_LISTING;
  }
}

export type ValidateProjectResult =
  | { kind: "ok"; cwd: string }
  /** 路径不存在：UI 据此弹「是否创建」，cwd 为服务端规范化后的候选路径 */
  | { kind: "notFound"; cwd: string }
  | { kind: "error"; message: string };

/**
 * 校验候选项目路径。只有服务端明确回 NOT_FOUND 才归为 notFound；
 * 其它失败（非目录、权限、服务端错误）一律按错误文案展示，不提示创建。
 */
export async function validateProjectPath(
  rawPath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ValidateProjectResult> {
  try {
    const res = await fetchImpl("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: rawPath }),
    });
    const data = (await res.json().catch(() => ({}))) as { cwd?: string; error?: string; code?: string };
    if (!res.ok || data.error) {
      if (data.code === "NOT_FOUND") return { kind: "notFound", cwd: data.cwd ?? rawPath };
      return { kind: "error", message: data.error ?? `HTTP ${res.status}` };
    }
    return { kind: "ok", cwd: data.cwd ?? rawPath };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

export type CreateProjectResult = { ok: true; cwd: string } | { ok: false; message: string };

/** 按用户确认创建缺失的项目目录（递归），返回服务端规范化路径。 */
export async function createProjectPath(
  cwd: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CreateProjectResult> {
  try {
    const res = await fetchImpl("/api/cwd/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    const data = (await res.json().catch(() => ({}))) as { cwd?: string; error?: string };
    if (!res.ok || data.error) return { ok: false, message: data.error ?? `HTTP ${res.status}` };
    return { ok: true, cwd: data.cwd ?? cwd };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
