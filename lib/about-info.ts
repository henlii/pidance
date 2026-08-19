/**
 * 从 package.json 形状构造 About 只读信息（纯函数，无 IO）。
 */

export interface AboutInfo {
  name: string;
  version: string;
  /** 内置 @earendil-works/pi-coding-agent 版本 */
  piSdkVersion: string | null;
  homepage: string | null;
  repository: string | null;
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

  // 内置 Pi SDK 版本：从 dependencies 精确读取（SDK 为必需运行时依赖，基线见 AGENTS.md）
  const piSdkVersion = readDependencyVersion(record, "@earendil-works/pi-coding-agent");

  return {
    name: displayName,
    version,
    piSdkVersion,
    homepage,
    repository,
  };
}

function readDependencyVersion(pkg: Record<string, unknown>, name: string): string | null {
  for (const key of ["dependencies", "optionalDependencies"] as const) {
    const block = pkg[key];
    if (!block || typeof block !== "object") continue;
    const raw = (block as Record<string, unknown>)[name];
    if (typeof raw === "string" && raw.trim()) {
      // 精确版本或带前缀的范围均原样返回；About 展示用
      return raw.trim().replace(/^[=v]/, "");
    }
  }
  return null;
}
