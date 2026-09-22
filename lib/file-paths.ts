export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

export function normalizeFilePathSlashes(filePath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\")) {
    return filePath.replace(/\\/g, "/");
  }
  return filePath;
}

export function shortenPath(filePath: string): string {
  return filePath.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

export function encodeFilePathForApi(filePath: string): string {
  return normalizeFilePathSlashes(filePath)
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

/**
 * 从 `/api/files/<encodedPath>?type=download...` 这类 API URL 反解出文件路径。
 * 「另存为」用的就是下载按钮同一个源，所以复用同一个 href，而不是再传一份路径。
 * 口径与路由侧 `filePathFromSegments` 一致：POSIX 补回前导斜杠，Windows 盘符原样。
 * 不是该形态（或解不出）返回 null。
 */
export function filePathFromApiUrl(href: string): string | null {
  if (typeof href !== "string") return null;
  const marker = "/api/files/";
  const at = href.indexOf(marker);
  if (at < 0) return null;
  const rest = href.slice(at + marker.length);
  const pathPart = rest.split("?")[0].split("#")[0];
  if (!pathPart) return null;
  const segments = pathPart.split("/").filter((segment) => segment.length > 0).map(safeDecode);
  if (segments.length === 0) return null;
  const joined = normalizeSlashes(segments.join("/"));
  if (isWindowsDrivePath(joined)) return joined;
  return `/${joined.replace(/^\/+/, "")}`;
}

/** 形如 `C:/...` 或 `//server/share` 的绝对路径（与 file-access 的 Windows 判定同口径）。 */
function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:\//.test(value) || value.startsWith("//");
}

export function getFileName(filePath: string): string {
  const normalized = normalizeFilePathSlashes(filePath).replace(/\/+$/, "");
  return normalized.split("/").pop() ?? normalized;
}

export function getFileDirectory(filePath: string): string {
  const normalized = normalizeFilePathSlashes(filePath).replace(/\/+$/, "");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) return "";
  if (lastSlash === 0) return "/";
  if (lastSlash === 2 && /^[a-zA-Z]:\//.test(normalized)) return normalized.slice(0, 3);
  return normalized.slice(0, lastSlash);
}

export function getRelativeFilePath(filePath: string, cwd?: string): string {
  if (!cwd) return filePath;

  const normalizedFile = normalizeFilePathSlashes(filePath);
  const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
  if (normalizedFile.startsWith(normalizedCwd + "/")) {
    return normalizedFile.slice(normalizedCwd.length + 1);
  }
  return filePath;
}

export function joinFilePath(parent: string, child: string): string {
  return `${normalizeFilePathSlashes(parent).replace(/\/$/, "")}/${child}`;
}
