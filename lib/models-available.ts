/**
 * 可用模型目录（不依赖 ModelRuntime）：models.json + 已配置凭据的内置渠道。
 *
 * 从 app/api/models/route.ts 抽出：`GET /api/models` 与「每模型启用开关」两处必须
 * 用同一份口径算可用集 —— 开关要把「全部启用」（enabledModels 缺失/空）物化成显式
 * 列表时，必须知道当前有哪些模型可用，不能拿客户端传来的清单当依据。
 *
 * enabledModels 的过滤单独一步（applyEnabledModelsFilter）：调用方先拿完整目录，
 * 再按需过滤。
 */

import { getAuthPath, getModelsPath, getSettingsPath } from "./pi-paths";
import { isProviderConfigured, listCredentialProviders } from "./auth-store";
import type { ModelsData } from "./models-cache";
import {
  buildModelsDataFromCatalog,
  listModelsFromModelsJson,
  mergeCatalogModels,
} from "./models-catalog";
import type { CatalogModel } from "./models-catalog";
import { listBuiltinCatalogModels } from "./pi-builtin-models";

const modelNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareModelEntries(
  a: { id: string; name: string; provider: string },
  b: { id: string; name: string; provider: string },
): number {
  return (
    modelNameCollator.compare(a.name || a.id, b.name || b.id) ||
    modelNameCollator.compare(a.provider, b.provider) ||
    modelNameCollator.compare(a.id, b.id)
  );
}

const THINKING_SUFFIXES = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** `provider/model:high` → `provider/model`；非思考后缀原样返回。 */
export function stripThinkingSuffix(modelRef: string): string {
  const trimmed = modelRef.trim();
  const colonIndex = trimmed.lastIndexOf(":");
  if (colonIndex === -1) return trimmed;
  const suffix = trimmed.substring(colonIndex + 1);
  return THINKING_SUFFIXES.has(suffix) ? trimmed.substring(0, colonIndex) : trimmed;
}

/** 模型的稳定引用：优先 `provider/id`（settings.json 里的 enabledModels 两种写法都认）。 */
export function modelRefOf(m: { id: string; provider: string }): string {
  return `${m.provider}/${m.id}`;
}

/**
 * 单个模型是否在 enabledModels 允许范围内。
 *
 * 与过滤口径同一实现：缺失/空列表 = 全部允许；每项认 `provider/model` 与裸 `model`，
 * 带思考后缀按同一条模型处理。开关面板与选择器必须用这一份判断。
 */
export function isModelEnabled(
  model: { id: string; provider: string },
  enabledModels: string[] | undefined | null,
): boolean {
  if (!enabledModels || enabledModels.length === 0) return true;
  const refs = new Set(enabledModels.map(stripThinkingSuffix).filter(Boolean));
  return refs.has(`${model.provider}/${model.id}`) || refs.has(model.id);
}

function filterByExactEnabledModels<T extends { id: string; provider: string }>(
  available: readonly T[],
  enabledModels: string[] | undefined,
): readonly T[] {
  if (!enabledModels || enabledModels.length === 0) return available;

  const visible = available.filter((m) => isModelEnabled(m, enabledModels));
  // 全部被排除（例如 enabledModels 里全是不存在的引用）时退回不过滤：宁可多显示，
  // 也不要把模型选择器整栏卸掉。
  return visible.length > 0 ? visible : available;
}

export interface AvailableModelsPaths {
  modelsPath?: string;
  settingsPath?: string;
  authPath?: string;
}

/**
 * 完整可用目录（**未**套 enabledModels 过滤），排序与 `GET /api/models` 一致。
 *
 * cwd 只作缓存键用途由调用方负责；本函数不读该目录。
 */
export async function loadAvailableModels(options: AvailableModelsPaths = {}): Promise<ModelsData> {
  const modelsPath = options.modelsPath ?? getModelsPath();
  const settingsPath = options.settingsPath ?? getSettingsPath();
  const authPath = options.authPath ?? getAuthPath();

  const custom = listModelsFromModelsJson(modelsPath);
  const authConfigured: Record<string, boolean> = {};
  // 先登记 auth.json 已有凭据的 provider（含 deepseek 等内置渠道）
  for (const providerId of listCredentialProviders(authPath)) {
    authConfigured[providerId] = isProviderConfigured(providerId, {
      authPath,
      modelsPath,
    });
  }
  for (const m of custom) {
    if (authConfigured[m.provider] === undefined) {
      authConfigured[m.provider] = isProviderConfigured(m.provider, {
        authPath,
        modelsPath,
      });
    }
  }

  const builtins = await listBuiltinCatalogModels();
  const catalog = mergeCatalogModels(custom, builtins, authConfigured);
  const base = buildModelsDataFromCatalog(catalog, {
    settingsPath,
    authConfigured,
  });

  const models: Record<string, string> = {};
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};
  for (const m of base.modelList) {
    const key = `${m.provider}:${m.id}`;
    models[key] = base.models[key] ?? m.name;
    if (base.thinkingLevels[key]) thinkingLevels[key] = base.thinkingLevels[key];
    if (base.thinkingLevelMaps[key]) thinkingLevelMaps[key] = base.thinkingLevelMaps[key];
  }

  return {
    ...base,
    models,
    modelList: [...base.modelList].sort(compareModelEntries),
    thinkingLevels,
    thinkingLevelMaps,
    authConfigured: base.authConfigured,
  };
}

/**
 * 套用 enabledModels（settings.json）：
 * - 缺失或空数组 = 不过滤（全部可用）；
 * - defaultModel 不在可见集里时置空（避免选中一个不可见的模型）。
 */
export function applyEnabledModelsFilter(
  data: ModelsData,
  enabledModels: string[] | undefined,
): ModelsData {
  const visible = filterByExactEnabledModels(data.modelList, enabledModels);
  const visibleKeys = new Set(visible.map((m) => `${m.provider}:${m.id}`));

  const models: Record<string, string> = {};
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};
  for (const m of visible) {
    const key = `${m.provider}:${m.id}`;
    models[key] = data.models[key] ?? m.name;
    if (data.thinkingLevels[key]) thinkingLevels[key] = data.thinkingLevels[key];
    if (data.thinkingLevelMaps[key]) thinkingLevelMaps[key] = data.thinkingLevelMaps[key];
  }

  let defaultModel = data.defaultModel;
  if (defaultModel && !visibleKeys.has(`${defaultModel.provider}:${defaultModel.modelId}`)) {
    defaultModel = null;
  }

  return {
    models,
    modelList: [...visible].sort(compareModelEntries),
    defaultModel,
    thinkingLevels,
    thinkingLevelMaps,
    authConfigured: data.authConfigured,
  };
}

/** 供测试与调用方复用：把 catalog 模型列表转成可用引用集合。 */
export function modelRefsOf(entries: readonly { id: string; provider: string }[]): string[] {
  return entries.map(modelRefOf);
}

export type { CatalogModel };
