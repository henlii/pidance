/**
 * 远端刷新的 provider 目录（`models-store.json`）读入与合并。
 *
 * 背景：pi 的 `ModelRuntime.refresh()` 会把每个 provider 的远端目录持久化到
 * `<agentDir>/models-store.json`（`FileModelsStore`，见 SDK `core/models-store.js`），
 * 并在组合 provider 时用 `withRemoteCatalog` 的语义把它叠在静态内置目录之上。
 *
 * 我们的模型目录（`/api/models`、模型选择器、可用模型面板）读的是静态内置目录，
 * 所以「刷新目录」以前对界面没有任何影响 —— 刷新写进 store，界面读的却不是它。
 * 这里把 store 按 pi 的同一套规则读进来，让刷新真正端到端可见。
 *
 * 与 pi 对齐的语义：
 * - 只有 store 条目的 `lastModified` 比本地内置目录新时才采用（否则内置目录更权威）；
 * - 按模型 id 合并：store 里的同名条目覆盖内置，多出来的追加；
 * - 任何解析失败都降级为空覆盖（绝不因为一个坏文件把整份目录清空）。
 *
 * 缓存按 (路径, mtime, size) 键控：刷新会改写该文件，下一次请求自然拿到新内容，
 * 不需要额外挂失效入口。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectCatalogModel, type CatalogModel } from "./models-catalog";
import { getModelsPath } from "./pi-paths";

/** SDK 的 FileModelsStore 默认把目录存在 models.json 同目录下。 */
export function modelsStorePathFor(modelsPath: string): string {
  return join(dirname(modelsPath), "models-store.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * pi 的 `remoteModels(entry, localGeneratedAt)`：远端条目只有在比本地生成时间新时才作数。
 * `localGeneratedAt` 缺失（拿不到内置目录的生成时间）时不设新鲜度门槛。
 */
function isFreshEnough(lastModified: unknown, localGeneratedAt: number | undefined): boolean {
  if (localGeneratedAt === undefined) return true;
  if (typeof lastModified !== "number" || !Number.isFinite(lastModified)) return false;
  return lastModified > localGeneratedAt;
}

/**
 * store 内容 → providerId → 模型列表。
 *
 * `localGeneratedAt` 是内置目录的生成时间（`getBuiltinModelDataGeneratedAt()`）；
 * 远端条目不比它新时**整体丢弃**，与 pi 的组合规则一致。
 */
export function projectModelsStoreOverlay(
  raw: unknown,
  localGeneratedAt?: number,
): Map<string, CatalogModel[]> {
  const out = new Map<string, CatalogModel[]>();
  if (!isPlainObject(raw)) return out;

  for (const [providerId, entry] of Object.entries(raw)) {
    if (!providerId || !isPlainObject(entry)) continue;
    if (!isFreshEnough(entry.lastModified, localGeneratedAt)) continue;
    const models = Array.isArray(entry.models) ? entry.models : [];
    const projected: CatalogModel[] = [];
    for (const model of models) {
      const projectedModel = projectCatalogModel(model, providerId);
      if (projectedModel) projected.push(projectedModel);
    }
    if (projected.length > 0) out.set(providerId, projected);
  }
  return out;
}

/**
 * pi 的 `mergeModels(baseline, dynamic)`：按 id 覆盖，多出来的追加。
 *
 * 远端目录是**按 provider 整体**取代该 provider 的静态条目（同名 id 覆盖、新 id 追加），
 * 其它 provider 的原样保留。
 */
export function mergeCatalogWithOverlay(
  baseline: readonly CatalogModel[],
  overlay: ReadonlyMap<string, CatalogModel[]>,
): CatalogModel[] {
  if (overlay.size === 0) return [...baseline];

  const merged = baseline.filter((model) => !overlay.has(model.provider));
  for (const models of overlay.values()) {
    merged.push(...models);
  }
  return merged;
}

interface OverlayCacheEntry {
  path: string;
  mtimeMs: number;
  size: number;
  value: Map<string, CatalogModel[]>;
}

let overlayCache: OverlayCacheEntry | null = null;

/**
 * 读 `models-store.json` 并投影成覆盖表。
 *
 * 不抛错：文件不存在/读不动/解析失败/形状不认识，一律返回空表（内置目录照常工作）。
 * 缓存按 mtime+size 重校验，刷新写盘后自动生效。
 */
export function readModelsStoreOverlay(options: {
  modelsPath?: string;
  storePath?: string;
  localGeneratedAt?: number;
} = {}): Map<string, CatalogModel[]> {
  // 没给路径时按真实 agent 目录找：models-store.json 与 models.json 同目录（SDK 的 FileModelsStore 约定）。
  const path = options.storePath ?? modelsStorePathFor(options.modelsPath ?? getModelsPath());
  if (!path || !existsSync(path)) return new Map();

  let mtimeMs = 0;
  let size = 0;
  try {
    const stat = statSync(path);
    mtimeMs = stat.mtimeMs;
    size = stat.size;
  } catch {
    return new Map();
  }

  // 新鲜度门槛参与缓存键：同一份文件在不同 generatedAt 下结果不同（测试会传不同值）。
  const cacheKey = `${path}:${options.localGeneratedAt ?? ""}`;
  if (
    overlayCache &&
    overlayCache.path === cacheKey &&
    overlayCache.mtimeMs === mtimeMs &&
    overlayCache.size === size
  ) {
    return overlayCache.value;
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    parsed = null;
  }
  const value = projectModelsStoreOverlay(parsed, options.localGeneratedAt);
  overlayCache = { path: cacheKey, mtimeMs, size, value };
  return value;
}

/** 测试用：清空覆盖表缓存。 */
export function resetModelsStoreOverlayCacheForTests(): void {
  overlayCache = null;
}
