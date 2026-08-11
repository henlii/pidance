/**
 * Pi 内置 provider 模型目录（server-only）。
 *
 * 通过解析已安装的 @earendil-works/pi-coding-agent 依赖树加载 pi-ai providers/all，
 * 避免在生产代码中静态 import @earendil-works/*（SDK allowlist 边界），也不依赖
 * 顶层 hoist 的 pi-ai 包路径。
 *
 * 用途：模型选择器合并「已配置凭据的内置渠道」模型（如 deepseek），补 models.json
 * 只含自定义端点时的缺口。
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CatalogModel } from "./models-catalog";

type BuiltinProvider = {
  id: string;
  getModels?: () => readonly BuiltinModel[];
};

type BuiltinModel = {
  id?: unknown;
  name?: unknown;
  provider?: unknown;
  reasoning?: unknown;
  thinkingLevelMap?: unknown;
  contextWindow?: unknown;
  maxTokens?: unknown;
};

type BuiltinProvidersModule = {
  builtinProviders?: () => readonly BuiltinProvider[];
  getBuiltinProviders?: () => readonly BuiltinProvider[];
};

let cached: CatalogModel[] | null = null;
let loadPromise: Promise<CatalogModel[]> | null = null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从 pi-coding-agent 安装树向上查找 pi-ai providers/all.js */
export function resolvePiAiProvidersAllPath(startDir = process.cwd()): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidates = [
      join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "all.js"),
      join(dir, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "all.js"),
    ];
    for (const cand of candidates) {
      if (existsSync(cand)) return cand;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function toCatalogModel(m: BuiltinModel, providerId: string): CatalogModel | null {
  const id = typeof m.id === "string" ? m.id : "";
  if (!id) return null;
  const name = typeof m.name === "string" && m.name ? m.name : id;
  const provider =
    typeof m.provider === "string" && m.provider ? m.provider : providerId;
  const thinkingLevelMap = isPlainObject(m.thinkingLevelMap)
    ? (m.thinkingLevelMap as Record<string, string | null>)
    : undefined;
  return {
    id,
    name,
    provider,
    reasoning: m.reasoning === true,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(typeof m.contextWindow === "number" && Number.isFinite(m.contextWindow)
      ? { contextWindow: m.contextWindow }
      : {}),
    ...(typeof m.maxTokens === "number" && Number.isFinite(m.maxTokens)
      ? { maxTokens: m.maxTokens }
      : {}),
  };
}

function projectBuiltinCatalog(mod: BuiltinProvidersModule): CatalogModel[] {
  const providers =
    (typeof mod.builtinProviders === "function" ? mod.builtinProviders() : null) ??
    (typeof mod.getBuiltinProviders === "function" ? mod.getBuiltinProviders() : null) ??
    [];
  const out: CatalogModel[] = [];
  for (const p of providers) {
    if (!p || typeof p.id !== "string" || !p.id) continue;
    const models = typeof p.getModels === "function" ? p.getModels() : [];
    for (const m of models ?? []) {
      const entry = toCatalogModel(m, p.id);
      if (entry) out.push(entry);
    }
  }
  return out;
}

/** 加载并缓存内置模型目录；失败返回空数组（不拖垮 /api/models）。 */
export async function listBuiltinCatalogModels(): Promise<CatalogModel[]> {
  if (cached) return cached;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const path = resolvePiAiProvidersAllPath();
      if (!path) {
        cached = [];
        return cached;
      }
      const url = pathToFileURL(path).href;
      let mod: BuiltinProvidersModule | null = null;
      // 1) 原生动态 import（node --test / jiti 可用）
      try {
        mod = (await import(url)) as BuiltinProvidersModule;
      } catch {
        mod = null;
      }
      // 2) Next/webpack 会把表达式 import 打空：用 Function 绕过 bundler
      if (!mod || (typeof mod.builtinProviders !== "function" && typeof mod.getBuiltinProviders !== "function")) {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval -- 故意绕过 bundler
        const importRuntime = new Function("u", "return import(u)") as (
          u: string,
        ) => Promise<BuiltinProvidersModule>;
        mod = await importRuntime(url);
      }
      cached = projectBuiltinCatalog(mod);
      return cached;
    } catch {
      cached = [];
      return cached;
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
}

/** 测试用：重置缓存 */
export function resetBuiltinCatalogModelsCacheForTests(): void {
  cached = null;
  loadPromise = null;
}
