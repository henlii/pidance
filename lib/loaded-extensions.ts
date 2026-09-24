/**
 * 扩展加载的共享缓存。
 *
 * 背景：同一个 (cwd, agentDir) 下，多个只读消费者都要「加载一遍扩展」才能拿到注册信息：
 * - `lib/extension-providers.ts`：扩展注册的模型服务商（issue #88）；
 * - `lib/extension-entry-renderers.ts`：`registerEntryRenderer` 的 entry 渲染器（issue #71）。
 *
 * 加载扩展会跑扩展工厂（有副作用与固定开销），所以两处必须**共用同一份加载结果**，
 * 不能各加载一遍。本模块只负责「加载 + 缓存 + 失效」，不解释内容。
 *
 * 边界：
 * - **只读**：不写任何文件、不执行会话动作。
 * - 加载失败一律降级为带 error 的结果，**不得**抛给调用方（调用方自己决定降级行为）。
 * - 缓存按 (cwd, agentDir) 键、30s TTL、in-flight 去重，并有失效代数防止
 *   「失效后旧加载写回」（与 extension-providers 同一套语义）。
 */

import { resolve } from "node:path";

export interface LoadedExtensions {
  /** SDK `LoadExtensionsResult.extensions`：每个扩展带着自己的渲染器注册表。 */
  extensions: Array<Record<string, unknown>>;
  /** SDK `LoadExtensionsResult.runtime`：共享运行时（pending provider 注册等）。 */
  runtime: Record<string, unknown>;
  /** 加载过程中的扩展错误（SDK 收集的），诊断用。 */
  errors: Array<{ path: string; error: string }>;
}

export type LoadedExtensionsLoader = () => Promise<LoadedExtensions>;

export type LoadedExtensionsResult =
  | { ok: true; value: LoadedExtensions }
  | { ok: false; error: string };

export const LOADED_EXTENSIONS_CACHE_TTL_MS = 30_000;

interface LoadedExtensionsCacheState {
  entries: Map<string, { value: LoadedExtensionsResult; expiresAt: number }>;
  inFlight: Map<string, Promise<LoadedExtensionsResult>>;
  /** 失效代数：失效时 +1，正在飞的旧加载回来时不再写回。 */
  generation: number;
}

declare global {
  var __piPidanceLoadedExtensionsCache: LoadedExtensionsCacheState | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cacheState(): LoadedExtensionsCacheState {
  if (!globalThis.__piPidanceLoadedExtensionsCache) {
    globalThis.__piPidanceLoadedExtensionsCache = {
      entries: new Map(),
      inFlight: new Map(),
      generation: 0,
    };
  }
  return globalThis.__piPidanceLoadedExtensionsCache;
}

/**
 * 失效入口：插件安装/卸载、模型或认证配置变更、测试复位时调用。
 * 依赖它的消费者（extension-providers / extension-entry-renderers）也应各自失效。
 */
export function invalidateLoadedExtensionsCache(): void {
  const state = globalThis.__piPidanceLoadedExtensionsCache;
  if (!state) return;
  state.entries.clear();
  state.inFlight.clear();
  state.generation += 1;
}

/** 默认加载器：SDK 的默认 resource loader 加载该 cwd 的扩展（全局 + 项目，按 pi 的信任规则）。 */
export function createSdkExtensionsLoader(cwd: string, agentDir: string | undefined): LoadedExtensionsLoader {
  return async () => {
    const mod = (await import("@earendil-works/pi-coding-agent")) as unknown as {
      DefaultResourceLoader?: new (options: { cwd: string; agentDir?: string }) => {
        reload: (options?: unknown) => Promise<void>;
        getExtensions: () => { extensions?: unknown; errors?: unknown; runtime?: unknown };
      };
    };
    if (!mod.DefaultResourceLoader) throw new Error("DefaultResourceLoader is not available");
    const loader = new mod.DefaultResourceLoader(agentDir ? { cwd, agentDir } : { cwd });
    await loader.reload();
    const result = loader.getExtensions();
    const extensions = Array.isArray(result?.extensions)
      ? (result.extensions.filter((ext) => asRecord(ext) !== null) as Array<Record<string, unknown>>)
      : [];
    const errors = Array.isArray(result?.errors)
      ? (result.errors as Array<{ path: string; error: string }>)
      : [];
    return { extensions, runtime: asRecord(result?.runtime) ?? {}, errors };
  };
}

export interface LoadExtensionsOptions {
  cwd: string;
  agentDir?: string;
  /** 注入加载器（测试不加载真实扩展）。 */
  loaderFactory?: (cwd: string, agentDir: string | undefined) => LoadedExtensionsLoader;
  /** 跳过缓存（内部/测试用）。 */
  bypassCache?: boolean;
}

/**
 * 加载（或取缓存的）扩展结果。
 * 任何失败都返回 `{ ok: false, error }`，调用方据此降级；本函数不抛。
 */
export async function loadExtensionsForCwd(options: LoadExtensionsOptions): Promise<LoadedExtensionsResult> {
  const cwd = resolve(options.cwd);
  const key = `${cwd}\0${options.agentDir ? resolve(options.agentDir) : ""}`;
  const state = cacheState();

  if (!options.bypassCache) {
    const cached = state.entries.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) state.entries.delete(key);
    const existing = state.inFlight.get(key);
    if (existing) return existing;
  }

  const loader = (options.loaderFactory ?? createSdkExtensionsLoader)(cwd, options.agentDir);
  const generationAtStart = state.generation;
  const loading = Promise.resolve()
    .then(loader)
    .then((value) => ({ ok: true, value }) as LoadedExtensionsResult)
    .catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }) as LoadedExtensionsResult)
    .then((value) => {
      if (!options.bypassCache && state.generation === generationAtStart) {
        state.entries.set(key, { value, expiresAt: Date.now() + LOADED_EXTENSIONS_CACHE_TTL_MS });
      }
      return value;
    })
    .finally(() => {
      if (state.inFlight.get(key) === loading) state.inFlight.delete(key);
    });

  if (!options.bypassCache) state.inFlight.set(key, loading);
  return loading;
}
