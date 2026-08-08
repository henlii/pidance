/**
 * GET /api/models — 自管 models.json + settings + auth-store（不依赖 ModelRuntime）。
 * 仅列出用户 models.json 中的自定义 provider 模型。
 */

import { stat } from "fs/promises";
import { resolve } from "path";
import { getAuthPath, getModelsPath, getSettingsPath } from "@/lib/pi-paths";
import { isProviderConfigured } from "@/lib/auth-store";
import { loadModelsWithCache, type ModelsData } from "@/lib/models-cache";
import {
  buildModelsDataFromDisk,
  listModelsFromModelsJson,
} from "@/lib/models-catalog";
import { loadSettingsFile } from "@/lib/settings-store";

export const dynamic = "force-dynamic";

const modelNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareModelEntries(
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

function stripThinkingSuffix(modelRef: string): string {
  const trimmed = modelRef.trim();
  const colonIndex = trimmed.lastIndexOf(":");
  if (colonIndex === -1) return trimmed;
  const suffix = trimmed.substring(colonIndex + 1);
  return THINKING_SUFFIXES.has(suffix) ? trimmed.substring(0, colonIndex) : trimmed;
}

function filterByExactEnabledModels<T extends { id: string; provider: string }>(
  available: readonly T[],
  enabledModels: string[] | undefined,
): readonly T[] {
  if (!enabledModels || enabledModels.length === 0) return available;

  const refs = new Set(enabledModels.map(stripThinkingSuffix).filter(Boolean));
  const visible = available.filter(
    (m) => refs.has(`${m.provider}/${m.id}`) || refs.has(m.id),
  );
  return visible.length > 0 ? visible : available;
}

async function loadModels(_cwd: string): Promise<ModelsData> {
  const modelsPath = getModelsPath();
  const settingsPath = getSettingsPath();
  const authPath = getAuthPath();
  const settings = loadSettingsFile(settingsPath);
  const enabledModels = Array.isArray(settings.enabledModels)
    ? (settings.enabledModels as string[])
    : undefined;

  const catalog = listModelsFromModelsJson(modelsPath);
  const authConfigured: Record<string, boolean> = {};
  for (const m of catalog) {
    if (authConfigured[m.provider] === undefined) {
      authConfigured[m.provider] = isProviderConfigured(m.provider, {
        authPath,
        modelsPath,
      });
    }
  }

  const base = buildModelsDataFromDisk({
    modelsPath,
    settingsPath,
    authConfigured,
  });

  // enabledModels 过滤
  const available = base.modelList;
  const visible = filterByExactEnabledModels(available, enabledModels);
  const visibleKeys = new Set(visible.map((m) => `${m.provider}:${m.id}`));

  const models: Record<string, string> = {};
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};
  for (const m of visible) {
    const key = `${m.provider}:${m.id}`;
    models[key] = base.models[key] ?? m.name;
    if (base.thinkingLevels[key]) thinkingLevels[key] = base.thinkingLevels[key];
    if (base.thinkingLevelMaps[key]) thinkingLevelMaps[key] = base.thinkingLevelMaps[key];
  }

  let defaultModel = base.defaultModel;
  if (
    defaultModel &&
    !visibleKeys.has(`${defaultModel.provider}:${defaultModel.modelId}`)
  ) {
    defaultModel = null;
  }

  return {
    models,
    modelList: [...visible].sort(compareModelEntries),
    defaultModel,
    thinkingLevels,
    thinkingLevelMaps,
    authConfigured: base.authConfigured,
  };
}

const EMPTY_MODELS: ModelsData = {
  models: {},
  modelList: [],
  defaultModel: null,
  thinkingLevels: {},
  thinkingLevelMaps: {},
  authConfigured: {},
};

export async function GET(req: Request) {
  const requestedCwd = new URL(req.url).searchParams.get("cwd") || process.cwd();
  const cwd = resolve(requestedCwd);

  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
  }
  if (!cwdStat.isDirectory()) {
    return Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 });
  }

  try {
    return Response.json(await loadModelsWithCache(cwd, () => loadModels(cwd)));
  } catch {
    return Response.json(EMPTY_MODELS);
  }
}
