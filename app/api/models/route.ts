/**
 * GET /api/models — models.json 自定义模型 + 已配置凭据的内置渠道模型，套 enabledModels 过滤。
 * 不依赖 ModelRuntime；目录口径与「每模型开关」（app/api/models/enabled）共用 lib/models-available。
 */

import { resolve } from "path";
import { getSettingsPath } from "@/lib/pi-paths";
import { loadModelsWithCache, type ModelsData } from "@/lib/models-cache";
import { applyEnabledModelsFilter, loadAvailableModels } from "@/lib/models-available";
import { loadSettingsFile } from "@/lib/settings-store";

export const dynamic = "force-dynamic";

async function loadModels(_cwd: string): Promise<ModelsData> {
  const settings = loadSettingsFile(getSettingsPath());
  const enabledModels = Array.isArray(settings.enabledModels)
    ? (settings.enabledModels as string[])
    : undefined;

  const base = await loadAvailableModels();
  return applyEnabledModelsFilter(base, enabledModels);
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
  // cwd 只作缓存键；loadModels 不读该目录。会话 cwd 已删时仍须返回目录，
  // 否则 ChatInput 因 modelList 为空把模型选择器整栏卸掉。
  try {
    return Response.json(await loadModelsWithCache(cwd, () => loadModels(cwd)));
  } catch {
    return Response.json(EMPTY_MODELS);
  }
}
