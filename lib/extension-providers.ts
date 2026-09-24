/**
 * 扩展注册的模型服务商（`pi.registerProvider` / 原生 provider）。
 *
 * 背景（issue #88 / 上游 #833）：设置页与登录页原本只认内置目录 + models.json，
 * 扩展（含 pi 的 provider 扩展、模型网关插件）注册进来的 provider 根本不出现，
 * 用户没法给它配 API Key。
 *
 * 来源：SDK 的默认 resource loader 加载扩展后，注册会挂在
 * `extensionsResult.runtime.pendingProviderRegistrations` /
 * `pendingNativeProviderRegistrations`（SDK 在 session 绑定扩展时也是这样读的）。
 *
 * 边界：
 * - **只读**：不执行任何写操作，不读凭据值（只报「有没有配」由调用方决定）。
 * - 加载扩展有固定开销 → 进程内按 (cwd, agentDir) 缓存 + TTL，并导出失效入口。
 * - 任何失败都降级为空列表并把原因带出去，**不得**让设置页整页报错。
 */

import { resolve } from "node:path";

export interface ExtensionProviderEntry {
  id: string;
  displayName: string;
  source: "extension";
  /** 该 provider 在扩展里声明的模型数量（未知为 0）。 */
  modelCount: number;
  /** 注册来源的扩展路径（诊断用；不含凭据）。 */
  extensionPath?: string;
}

export interface RawExtensionProviderRegistrations {
  /** `pi.registerProvider(id, config)` */
  configRegistrations: Array<{ name: string; config?: unknown; extensionPath?: string }>;
  /** 原生 pi-ai provider */
  nativeProviders: Array<{ provider?: unknown; extensionPath?: string }>;
}

export interface ExtensionProvidersResult {
  providers: ExtensionProviderEntry[];
  /** 加载失败原因（有值时 providers 为空数组），供路由带出给界面提示。 */
  error?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function countModels(value: unknown): number {
  const models = asRecord(value)?.models;
  return Array.isArray(models) ? models.filter((m) => asRecord(m) !== null).length : 0;
}

/**
 * 注册记录 → 展示条目（纯函数）。
 *
 * 去重口径：按 provider id，**先到先得**；原生 provider 通常带更完整的 `name`，所以
 * 由调用方决定顺序（默认先原生后配置注册，见 `loadRawExtensionProviders`）。
 */
export function mapExtensionProviders(raw: RawExtensionProviderRegistrations): ExtensionProviderEntry[] {
  const out: ExtensionProviderEntry[] = [];
  const seen = new Set<string>();

  const push = (entry: ExtensionProviderEntry | null) => {
    if (!entry) return;
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    out.push(entry);
  };

  for (const { provider, extensionPath } of raw.nativeProviders ?? []) {
    const record = asRecord(provider);
    const id = asString(record?.id) ?? asString(record?.name);
    if (!id) continue;
    push({
      id,
      displayName: asString(record?.name) ?? id,
      source: "extension",
      modelCount: countModels(record),
      ...(asString(extensionPath) ? { extensionPath: asString(extensionPath) } : {}),
    });
  }

  for (const { name, config, extensionPath } of raw.configRegistrations ?? []) {
    const id = asString(name);
    if (!id) continue;
    const record = asRecord(config);
    push({
      id,
      displayName: asString(record?.name) ?? id,
      source: "extension",
      modelCount: countModels(record),
      ...(asString(extensionPath) ? { extensionPath: asString(extensionPath) } : {}),
    });
  }

  return out.sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }) ||
    a.id.localeCompare(b.id),
  );
}

type ExtensionLoader = () => Promise<RawExtensionProviderRegistrations>;

/** 默认加载器：SDK 的默认 resource loader 加载当前 cwd 的扩展。 */
function createSdkLoader(cwd: string, agentDir: string | undefined): ExtensionLoader {
  return async () => {
    const mod = (await import("@earendil-works/pi-coding-agent")) as unknown as {
      DefaultResourceLoader?: new (options: { cwd: string; agentDir?: string }) => {
        reload: (options?: unknown) => Promise<void>;
        getExtensions: () => { runtime?: unknown };
      };
    };
    if (!mod.DefaultResourceLoader) throw new Error("DefaultResourceLoader is not available");
    const loader = new mod.DefaultResourceLoader(
      agentDir ? { cwd, agentDir } : { cwd },
    );
    await loader.reload();
    const runtime = asRecord(loader.getExtensions()?.runtime) ?? {};
    const configRegistrations = Array.isArray(runtime.pendingProviderRegistrations)
      ? (runtime.pendingProviderRegistrations as RawExtensionProviderRegistrations["configRegistrations"])
      : [];
    const nativeProviders = Array.isArray(runtime.pendingNativeProviderRegistrations)
      ? (runtime.pendingNativeProviderRegistrations as RawExtensionProviderRegistrations["nativeProviders"])
      : [];
    return { configRegistrations, nativeProviders };
  };
}

const CACHE_TTL_MS = 30_000;

interface ExtensionProvidersCacheState {
  entries: Map<string, { value: ExtensionProvidersResult; expiresAt: number }>;
  inFlight: Map<string, Promise<ExtensionProvidersResult>>;
}

declare global {
  var __piPidanceExtensionProvidersCache: ExtensionProvidersCacheState | undefined;
}

function cacheState(): ExtensionProvidersCacheState {
  if (!globalThis.__piPidanceExtensionProvidersCache) {
    globalThis.__piPidanceExtensionProvidersCache = { entries: new Map(), inFlight: new Map() };
  }
  return globalThis.__piPidanceExtensionProvidersCache;
}

/** 失效入口（模型/认证配置变更、插件安装卸载、测试复位时调用）。 */
export function invalidateExtensionProvidersCache(): void {
  const state = globalThis.__piPidanceExtensionProvidersCache;
  if (!state) return;
  state.entries.clear();
  state.inFlight.clear();
}

export interface ListExtensionProvidersOptions {
  cwd: string;
  agentDir?: string;
  /** 注入加载器（测试不触网、不加载真实扩展）。 */
  loaderFactory?: (cwd: string, agentDir: string | undefined) => ExtensionLoader;
  /** 跳过缓存（内部/测试用）。 */
  bypassCache?: boolean;
}

export async function listExtensionProviders(
  options: ListExtensionProvidersOptions,
): Promise<ExtensionProvidersResult> {
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

  const loader = (options.loaderFactory ?? createSdkLoader)(cwd, options.agentDir);
  const loading = Promise.resolve()
    .then(loader)
    .then((raw) => ({ providers: mapExtensionProviders(raw) }) as ExtensionProvidersResult)
    .catch((error: unknown) => ({
      providers: [],
      error: error instanceof Error ? error.message : String(error),
    }) as ExtensionProvidersResult)
    .then((value) => {
      if (!options.bypassCache) {
        state.entries.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
      }
      return value;
    })
    .finally(() => {
      if (state.inFlight.get(key) === loading) state.inFlight.delete(key);
    });

  if (!options.bypassCache) state.inFlight.set(key, loading);
  return loading;
}
