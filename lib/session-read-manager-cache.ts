/**
 * 只读 SessionManager 视图的进程内缓存。
 *
 * 背景：没有 live 会话时，每次读取（会话详情、分页、大纲、文件引用）都要
 * `SessionManager.open` 全量解析 JSONL——82MB 的会话约 1.1s，而翻页时每页
 * 还会再开一次。本模块按 (path, size, mtimeMs, leaf sidecar 指纹) 复用已解析
 * 的只读视图，读路径不再重复解析。
 *
 * 键为什么必须含 sidecar：导航到非末尾分支只改 `<session>.jsonl.leaf.json`，
 * 正文一个字节都不变；只按正文指纹复用会返回带着旧 leaf 的视图。
 *
 * 上界：解析后的 entries 大致等于会话文件大小（82MB 文件约占 94MB 堆），
 * 只按条数限制会让大文件钉住约 1GB。因此同时限制条数、合计字节与单文件字节；
 * 超过单文件上界的大会话每次现开，不挤掉其它条目。
 *
 * 写路径不得使用本缓存：`SessionManager` 仍是 JSONL 唯一 writer，host 启动、
 * 删除、重命名各自 open（见 pi-session-io.openSessionManager）。
 * 失效入口：`invalidateSessionReadCache()`（删除会话后释放；正文/ sidecar
 * 变化由指纹自动失效）。
 */
import { statSync } from "node:fs";
import { leafSidecarPath } from "./session-leaf-sidecar";
import { openSessionView, type DiskSessionReadView } from "./pi-session-io";

/** 缓存上界；导出供测试缩到能在磁盘上造出来的尺寸。 */
export const SESSION_READ_CACHE_LIMITS = {
  /** 最多缓存的会话文件数 */
  maxEntries: 12,
  /** 缓存合计上界（按会话文件大小计） */
  maxTotalBytes: 256 * 1024 * 1024,
  /** 单文件超过此大小不缓存 */
  maxEntryBytes: 64 * 1024 * 1024,
};

type SessionReadCacheEntry = {
  view: DiskSessionReadView;
  fingerprint: string;
  bytes: number;
};

declare global {
  var __piSessionReadViewCache: Map<string, SessionReadCacheEntry> | undefined;
}

function getCache(): Map<string, SessionReadCacheEntry> {
  if (!globalThis.__piSessionReadViewCache) globalThis.__piSessionReadViewCache = new Map();
  return globalThis.__piSessionReadViewCache;
}

/**
 * 指纹：正文 size/mtime + leaf sidecar size/mtime。
 * 文件不可 stat（不存在/不可读）时返回 null，调用方按未缓存路径处理。
 */
function fingerprintOf(filePath: string): { fingerprint: string; bytes: number } | null {
  let size: number;
  let mtimeMs: number;
  try {
    const st = statSync(filePath);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return null;
  }
  let sidecar = "-";
  try {
    const sc = statSync(leafSidecarPath(filePath));
    sidecar = `${sc.size}:${sc.mtimeMs}`;
  } catch {
    // 无 sidecar：指纹里保持 "-"，sidecar 出现/消失都会改变指纹
  }
  return { fingerprint: `${size}:${mtimeMs}:${sidecar}`, bytes: size };
}

function totalBytes(cache: Map<string, SessionReadCacheEntry>): number {
  let total = 0;
  for (const entry of cache.values()) total += entry.bytes;
  return total;
}

/** 从最旧（Map 插入序，命中会重插到末尾）开始淘汰到上界内。 */
function evictToLimits(cache: Map<string, SessionReadCacheEntry>): void {
  while (
    cache.size > SESSION_READ_CACHE_LIMITS.maxEntries ||
    totalBytes(cache) > SESSION_READ_CACHE_LIMITS.maxTotalBytes
  ) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    cache.delete(oldest.value);
  }
}

/**
 * 打开（或复用）只读会话视图。文件不可 stat 时等价于 `openSessionView(filePath)`，
 * 保持「文件不存在」的既有语义由调用方决定。
 */
export function openCachedSessionReadView(filePath: string): DiskSessionReadView {
  const cache = getCache();
  const statInfo = fingerprintOf(filePath);
  if (!statInfo) {
    cache.delete(filePath);
    return openSessionView(filePath);
  }

  const cached = cache.get(filePath);
  if (cached && cached.fingerprint === statInfo.fingerprint) {
    // 命中即提到末尾，维持 LRU 顺序
    cache.delete(filePath);
    cache.set(filePath, cached);
    return cached.view;
  }

  const view = openSessionView(filePath);
  cache.delete(filePath);
  if (statInfo.bytes <= SESSION_READ_CACHE_LIMITS.maxEntryBytes) {
    cache.set(filePath, { view, fingerprint: statInfo.fingerprint, bytes: statInfo.bytes });
    evictToLimits(cache);
  }
  return view;
}

/** 失效入口：删除会话后释放对应条目；不传路径则整体清空。 */
export function invalidateSessionReadCache(filePath?: string): void {
  const cache = getCache();
  if (filePath === undefined) cache.clear();
  else cache.delete(filePath);
}

/** 仅供测试与排查：当前缓存条目数与合计字节。 */
export function sessionReadCacheStats(): { entries: number; bytes: number } {
  const cache = getCache();
  return { entries: cache.size, bytes: totalBytes(cache) };
}
