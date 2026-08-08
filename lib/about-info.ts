/**
 * 从 package.json 形状构造 About 只读信息（纯函数，无 IO）。
 */

export interface AboutInfo {
  name: string;
  version: string;
  piSdkVersion: string | null;
  homepage: string | null;
  repository: string | null;
  /** 外部 RPC runtime 版本；inprocess 时与 piSdkVersion 同或 null */
  runtimePiVersion?: string | null;
  /** inprocess | rpc */
  agentRuntimeMode?: "inprocess" | "rpc";
  runtimePath?: string | null;
  runtimeCompatible?: boolean;
}

const DEFAULT_NAME = "Pidance";

/** 将 package.json 的 repository 字段规范为 https 浏览 URL。 */
export function normalizeRepositoryUrl(repository: unknown): string | null {
  if (typeof repository === "string") {
    return cleanGitUrl(repository);
  }
  if (repository && typeof repository === "object" && "url" in repository) {
    const url = (repository as { url?: unknown }).url;
    if (typeof url === "string") return cleanGitUrl(url);
  }
  return null;
}

function cleanGitUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url = trimmed;
  if (url.startsWith("git+")) url = url.slice(4);
  if (url.startsWith("git://")) url = `https://${url.slice("git://".length)}`;
  if (url.endsWith(".git")) url = url.slice(0, -4);
  return url || null;
}

function isProductPackageName(name: string): boolean {
  return name === "@henlii/pidance";
}

/**
 * 从已解析的 package.json 对象构造 About 载荷。
 * 字段缺失时使用安全默认值，不抛错。
 */
export function buildAboutInfo(pkg: unknown): AboutInfo {
  const record = pkg && typeof pkg === "object" ? (pkg as Record<string, unknown>) : {};
  const rawName = typeof record.name === "string" && record.name.trim()
    ? record.name.trim()
    : DEFAULT_NAME;
  // 包名 @henlii/pidance 对外展示统一为 Pidance
  const displayName = isProductPackageName(rawName) ? DEFAULT_NAME : rawName;

  const version = typeof record.version === "string" && record.version.trim()
    ? record.version.trim()
    : "0.0.0";

  const homepage = typeof record.homepage === "string" && record.homepage.trim()
    ? record.homepage.trim()
    : null;

  const repository = normalizeRepositoryUrl(record.repository);

  // 不再从 package.json dependencies 读 pi npm 版本（产品默认只用外部 pi）
  return {
    name: displayName,
    version,
    piSdkVersion: null,
    homepage,
    repository,
  };
}
