/**
 * 从 models.json 构建模型列表（不依赖 ModelRuntime）。
 * 仅覆盖用户 models.json 中的自定义 provider；内置 pi 模型 catalog 仍可由外部 pi 提供。
 */

import { existsSync, readFileSync } from "node:fs";
import { getModelsPath, getSettingsPath } from "./pi-paths";
import { loadSettingsFile } from "./settings-store";
import type { ModelsData } from "./models-cache";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type CatalogModel = {
  id: string;
  name: string;
  provider: string;
  thinkingLevelMap?: Record<string, string | null>;
  reasoning?: boolean;
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
      });
    }
  }
  return out;
}

/** 默认 thinking levels（无 pi-ai 时的保守集合） */
const DEFAULT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

function thinkingLevelsFor(model: CatalogModel): string[] {
  if (model.thinkingLevelMap && Object.keys(model.thinkingLevelMap).length > 0) {
    return Object.keys(model.thinkingLevelMap);
  }
  if (model.reasoning) return DEFAULT_THINKING_LEVELS;
  return ["off"];
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
  const catalog = listModelsFromModelsJson(options.modelsPath);
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
    modelList.push({ id: m.id, name: m.name, provider: m.provider });
    thinkingLevels[key] = thinkingLevelsFor(m);
    if (m.thinkingLevelMap) thinkingLevelMaps[key] = m.thinkingLevelMap;
    if (authConfigured[m.provider] === undefined) {
      // 调用方未提供时：models.json 有 provider 即先标 false，由上层补全
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
