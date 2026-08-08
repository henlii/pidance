export interface ModelsData {
  models: Record<string, string>;
  modelList: { id: string; name: string; provider: string }[];
  defaultModel: { provider: string; modelId: string } | null;
  thinkingLevels: Record<string, string[]>;
  thinkingLevelMaps: Record<string, Record<string, string | null>>;
  /** providerId → 该 provider 是否已有可用凭据（AuthStorage / runtime / models.json / 环境变量）。 */
  authConfigured: Record<string, boolean>;
}

interface ModelsCacheState {
  entries: Map<string, { data: ModelsData; expiresAt: number }>;
  inFlight: Map<string, Promise<ModelsData>>;
  generation: number;
}

/** 进程级 runtime 复用缓存（按 agentDir 键控；T 由调用方注入，不绑 pi npm）。 */
interface ModelRuntimeCacheState {
  /** agentDir → 创建中的 Promise（复用中 / 创建失败自动移除） */
  runtimes: Map<string, Promise<unknown>>;
}

declare global {
  var __piModelsCacheState: ModelsCacheState | undefined;
  var __piModelRuntimeCache: ModelRuntimeCacheState | undefined;
}

const MODELS_CACHE_TTL_MS = 60_000;
const MAX_MODELS_CACHE_ENTRIES = 32;

function getModelsCacheState(): ModelsCacheState {
  if (!globalThis.__piModelsCacheState) {
    globalThis.__piModelsCacheState = {
      entries: new Map(),
      inFlight: new Map(),
      generation: 0,
    };
  }
  return globalThis.__piModelsCacheState;
}

function getModelRuntimeCacheState(): ModelRuntimeCacheState {
  if (!globalThis.__piModelRuntimeCache) {
    globalThis.__piModelRuntimeCache = { runtimes: new Map() };
  }
  return globalThis.__piModelRuntimeCache;
}

/**
 * 进程级复用 ModelRuntime（按 agentDir 键控）。
 *
 * SDK 的 createAgentSessionServices 每次调用都会重建全部服务，其中
 * ModelRuntime.create + 首次 provider 组合有固定开销；而模型运行时只依赖
 * agentDir 下的 auth.json / models.json（与 cwd 无关），因此按 agentDir
 * 复用一份即可。settingsManager / resourceLoader 仍由调用方按 cwd 新建
 * （SDK cwd-bound 语义不可省）。
 *
 * 生命周期：键挂在 globalThis（Next.js 热重载下保留），模型/认证配置变更
 * 时 invalidateModelsCache() 清空本缓存，下次请求重建；创建失败自动移除
 * 以便重试；并发请求共享同一个创建 Promise（in-flight 去重）。
 */
export function getOrCreateModelRuntime<T>(
  agentDir: string,
  create: () => Promise<T>,
): Promise<T> {
  const state = getModelRuntimeCacheState();
  const existing = state.runtimes.get(agentDir);
  if (existing) return existing as Promise<T>;

  const creating = Promise.resolve().then(create);
  // 只在创建失败时移除（成功保留供复用）；catch 返回的新 Promise 正常 resolve，
  // 原 creating 的 rejection 仍会传给调用方 await。
  creating.catch(() => {
    if (state.runtimes.get(agentDir) === creating) state.runtimes.delete(agentDir);
  });
  state.runtimes.set(agentDir, creating as Promise<unknown>);
  return creating;
}

export function invalidateModelsCache(): void {
  const state = getModelsCacheState();
  state.generation += 1;
  state.entries.clear();
  state.inFlight.clear();
  // 模型/认证配置变更：进程级 ModelRuntime 一并失效，下次请求重建。
  globalThis.__piModelRuntimeCache?.runtimes.clear();
}

export function loadModelsWithCache(cwd: string, loader: () => Promise<ModelsData>): Promise<ModelsData> {
  const state = getModelsCacheState();
  const cached = state.entries.get(cwd);
  if (cached) {
    if (cached.expiresAt > Date.now()) return Promise.resolve(cached.data);
    state.entries.delete(cwd);
  }

  const existingLoad = state.inFlight.get(cwd);
  if (existingLoad) return existingLoad;

  const generation = state.generation;
  const loadPromise: Promise<ModelsData> = Promise.resolve()
    .then(loader)
    .then((data) => {
      if (state.generation === generation && state.inFlight.get(cwd) === loadPromise) {
        const now = Date.now();
        for (const [key, entry] of state.entries) {
          if (entry.expiresAt <= now) state.entries.delete(key);
        }
        while (state.entries.size >= MAX_MODELS_CACHE_ENTRIES) {
          const oldestKey = state.entries.keys().next().value;
          if (oldestKey === undefined) break;
          state.entries.delete(oldestKey);
        }
        state.entries.set(cwd, { data, expiresAt: now + MODELS_CACHE_TTL_MS });
      }
      return data;
    })
    .finally(() => {
      if (state.inFlight.get(cwd) === loadPromise) state.inFlight.delete(cwd);
    });

  state.inFlight.set(cwd, loadPromise);
  return loadPromise;
}
