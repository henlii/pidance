/**
 * 从 models.json 构建模型列表（不依赖 ModelRuntime）。
 * 自定义 provider 来自 models.json；已配置凭据的内置渠道由 pi-builtin-models 合并。
 */

import { existsSync, readFileSync } from "node:fs";
import { getModelsPath, getSettingsPath } from "./pi-paths";
import { loadSettingsFile } from "./settings-store";
import type { ModelsData } from "./models-cache";
import { thinkingLevelsFromMap } from "./thinking-levels";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type CatalogModel = {
  id: string;
  name: string;
  provider: string;
  thinkingLevelMap?: Record<string, string | null>;
  reasoning?: boolean;
  /** models.json 配置的上下文窗口（token） */
  contextWindow?: number;
  /** 最大输出 token */
  maxTokens?: number;
};

function loadModelsJson(modelsPath: string): Record<string, unknown> {
  if (!existsSync(modelsPath)) return { providers: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(modelsPath, "utf8"));
    return isPlainObject(parsed) ? parsed : { providers: {} };
  } catch {
    return { providers: {} };
  }
}

/** 解析 models.json → 扁平模型列表 */
export function listModelsFromModelsJson(modelsPath?: string): CatalogModel[] {
  const path = modelsPath ?? getModelsPath();
  const data = loadModelsJson(path);
  const providers = isPlainObject(data.providers) ? data.providers : {};
  const out: CatalogModel[] = [];
  for (const [providerId, raw] of Object.entries(providers)) {
    if (!isPlainObject(raw)) continue;
    const models = Array.isArray(raw.models) ? raw.models : [];
    for (const m of models) {
      if (!isPlainObject(m)) continue;
      const id = typeof m.id === "string" ? m.id : "";
      if (!id) continue;
      const name = typeof m.name === "string" && m.name ? m.name : id;
      const thinkingLevelMap = isPlainObject(m.thinkingLevelMap)
        ? (m.thinkingLevelMap as Record<string, string | null>)
        : undefined;
      out.push({
        id,
        name,
        provider: providerId,
        thinkingLevelMap,
        reasoning: m.reasoning === true,
        ...(typeof m.contextWindow === "number" && Number.isFinite(m.contextWindow)
          ? { contextWindow: m.contextWindow }
          : {}),
        ...(typeof m.maxTokens === "number" && Number.isFinite(m.maxTokens)
          ? { maxTokens: m.maxTokens }
          : {}),
      });
    }
  }
  return out;
}

/** 仅 map[level]===null 禁用；省略（含 xhigh/max）视为可用。 */
export function thinkingLevelsFor(model: CatalogModel): string[] {
  return thinkingLevelsFromMap(model.reasoning === true, model.thinkingLevelMap);
}

/**
 * 合并 models.json 自定义模型与已配置凭据的内置渠道模型。
 * 同 provider:id 时 models.json 覆盖内置（用户自定义端点优先）。
 */
export function mergeCatalogModels(
  custom: readonly CatalogModel[],
  builtins: readonly CatalogModel[],
  authConfigured: Record<string, boolean>,
): CatalogModel[] {
  const keys = new Set(custom.map((m) => `${m.provider}:${m.id}`));
  const out: CatalogModel[] = [...custom];
  for (const m of builtins) {
    const key = `${m.provider}:${m.id}`;
    if (keys.has(key)) continue;
    // 仅纳入已配置凭据的内置渠道，避免把全部 40+ 供应商模型塞进选择器
    if (authConfigured[m.provider] === true) {
      out.push(m);
      keys.add(key);
    }
  }
  return out;
}

/**
 * 从已合并 catalog + settings 构建 ModelsData。
 * authConfigured 由调用方注入（auth-store）。
 */
export function buildModelsDataFromCatalog(
  catalog: readonly CatalogModel[],
  options: {
    settingsPath?: string;
    authConfigured?: Record<string, boolean>;
  } = {},
): ModelsData {
  const settings = loadSettingsFile(options.settingsPath ?? getSettingsPath());
  const defaultProvider =
    typeof settings.defaultProvider === "string" ? settings.defaultProvider : null;
  const defaultModelId =
    typeof settings.defaultModel === "string" ? settings.defaultModel : null;

  const models: Record<string, string> = {};
  const modelList: ModelsData["modelList"] = [];
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};
  const authConfigured = { ...(options.authConfigured ?? {}) };

  for (const m of catalog) {
    const key = `${m.provider}:${m.id}`;
    models[key] = m.name;
    modelList.push({
      id: m.id,
      name: m.name,
      provider: m.provider,
      contextWindow:
        typeof m.contextWindow === "number" && Number.isFinite(m.contextWindow)
          ? m.contextWindow
          : undefined,
      maxTokens:
        typeof m.maxTokens === "number" && Number.isFinite(m.maxTokens)
          ? m.maxTokens
          : undefined,
    });
    thinkingLevels[key] = thinkingLevelsFor(m);
    if (m.thinkingLevelMap) thinkingLevelMaps[key] = m.thinkingLevelMap;
    if (authConfigured[m.provider] === undefined) {
      // 调用方未提供时：catalog 有 provider 即先标 false，由上层补全
      authConfigured[m.provider] = false;
    }
  }

  modelList.sort((a, b) => {
    const p = a.provider.localeCompare(b.provider);
    return p !== 0 ? p : a.id.localeCompare(b.id);
  });

  let defaultModel: ModelsData["defaultModel"] = null;
  if (
    defaultProvider &&
    defaultModelId &&
    modelList.some((m) => m.provider === defaultProvider && m.id === defaultModelId)
  ) {
    defaultModel = { provider: defaultProvider, modelId: defaultModelId };
  }

  return {
    models,
    modelList,
    defaultModel,
    thinkingLevels,
    thinkingLevelMaps,
    authConfigured,
  };
}

/**
 * 仅从 models.json + settings 构建 ModelsData（不含内置 provider catalog）。
 * authConfigured 由调用方注入（auth-store）。
 */
export function buildModelsDataFromDisk(options: {
  modelsPath?: string;
  settingsPath?: string;
  authConfigured?: Record<string, boolean>;
}): ModelsData {
  return buildModelsDataFromCatalog(listModelsFromModelsJson(options.modelsPath), {
    settingsPath: options.settingsPath,
    authConfigured: options.authConfigured,
  });
}
