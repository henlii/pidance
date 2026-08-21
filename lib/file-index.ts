/**
 * /api/file-index 业务实现：项目文件索引/搜索。
 *
 * Route 只保留参数校验与状态码；缓存、git/readdir 枚举、匹配全部下沉到 lib。
 * 各项上限从服务端持久化配置读取（文件管理器顶部齿轮可调）。
 */
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { buildEntriesFromFiles, filterFileEntries, type FileIndexEntry } from "./file-fuzzy";
import { readFileConfig } from "./file-config";

const execFileAsync = promisify(execFile);

/** 查询参数长度上限（非用户可调安全值） */
const MAX_QUERY_LENGTH = 500;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 20;

interface FileListing {
  /** Full listing up to the hard cap (not the client cap) */
  files: string[];
  /** True when even the hard cap was exceeded */
  hardTruncated: boolean;
}

interface CacheEntry {
  listing: FileListing;
  /** Derived lazily on the first ?q= search against this listing */
  entries?: FileIndexEntry[];
  expiresAt: number;
}

// Per-cwd cache on globalThis so it survives Next.js hot-reload; the @ menu
// re-requests on every open and searches on every keystroke, so listings must
// not be recomputed within a short window.
declare global {
  var __piFileIndexCache: Map<string, CacheEntry> | undefined;
}

function getIndexCache(): Map<string, CacheEntry> {
  if (!globalThis.__piFileIndexCache) globalThis.__piFileIndexCache = new Map();
  return globalThis.__piFileIndexCache;
}

async function listWithGit(cwd: string): Promise<FileListing | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
    );
    const all = stdout.split("\0").filter(Boolean);
    const config = readFileConfig();
    if (all.length > config.indexGitHardCap) {
      return { files: all.slice(0, config.indexGitHardCap), hardTruncated: true };
    }
    return { files: all, hardTruncated: false };
  } catch {
    // Not a git repo (or git unavailable) — caller falls back to readdir walk.
    return null;
  }
}

function listWithWalk(cwd: string): FileListing {
  const files: string[] = [];
  const config = readFileConfig();
  // BFS so shallow files win when the cap truncates the listing.
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: cwd, rel: "", depth: 0 }];
  while (queue.length > 0) {
    const { abs, rel, depth } = queue.shift()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (depth + 1 <= config.indexMaxWalkDepth) {
          queue.push({ abs: path.join(abs, d.name), rel: childRel, depth: depth + 1 });
        }
      } else if (d.isFile()) {
        if (files.length >= config.indexWalkHardCap) {
          return { files, hardTruncated: true };
        }
        files.push(childRel);
      }
    }
  }
  return { files, hardTruncated: false };
}

export type FileIndexResult =
  | { matches: ReturnType<typeof filterFileEntries> }
  | { files: string[]; truncated: boolean };

export async function getFileIndex(cwd: string, query: string): Promise<FileIndexResult> {
  const cache = getIndexCache();
  const now = Date.now();
  let cached = cache.get(cwd);
  if (!cached || cached.expiresAt <= now) {
    const listing = (await listWithGit(cwd)) ?? listWithWalk(cwd);
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(key);
    }
    if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
    cached = { listing, expiresAt: now + CACHE_TTL_MS };
    cache.set(cwd, cached);
  }

  const config = readFileConfig();
  if (query) {
    cached.entries ??= buildEntriesFromFiles(cached.listing.files);
    return { matches: filterFileEntries(cached.entries, query, config.atResultLimit) };
  }

  const { files, hardTruncated } = cached.listing;
  return {
    files: files.slice(0, config.indexMaxFiles),
    truncated: hardTruncated || files.length > config.indexMaxFiles,
  };
}
