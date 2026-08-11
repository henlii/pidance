/**
 * API-key provider 列表：内置目录 + models.json 中已有供应商 + auth 状态。
 * 不依赖 ModelRuntime；OAuth 供应商走 /api/auth/providers。
 */

import { isProviderConfigured } from "@/lib/auth-store";
import { BUILTIN_API_KEY_PROVIDERS } from "@/lib/builtin-api-key-providers";
import { OAUTH_PROVIDER_IDS } from "@/lib/oauth-providers";
import { listModelsFromModelsJson } from "@/lib/models-catalog";
import { listBuiltinCatalogModels } from "@/lib/pi-builtin-models";
import { getModelsPath } from "@/lib/pi-paths";
import { existsSync, readFileSync } from "node:fs";

export const dynamic = "force-dynamic";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** models.json 中有 apiKey 的 provider（自定义端点，由 Models 页管理） */
function providersWithModelsJsonKey(): Set<string> {
  const path = getModelsPath();
  const out = new Set<string>();
  if (!existsSync(path)) return out;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isPlainObject(parsed) || !isPlainObject(parsed.providers)) return out;
    for (const [id, raw] of Object.entries(parsed.providers)) {
      if (!isPlainObject(raw)) continue;
      if (typeof raw.apiKey === "string" && raw.apiKey.length > 0) out.add(id);
    }
  } catch {
    /* ignore */
  }
  return out;
}

export async function GET() {
  const models = listModelsFromModelsJson();
  const builtins = await listBuiltinCatalogModels();
  const modelsJsonKey = providersWithModelsJsonKey();
  const modelCountByProvider = new Map<string, number>();
  for (const m of models) {
    modelCountByProvider.set(m.provider, (modelCountByProvider.get(m.provider) ?? 0) + 1);
  }
  // 内置渠道模型计数：models.json 未覆盖时补上（选择器同规则）
  const customKeys = new Set(models.map((m) => `${m.provider}:${m.id}`));
  for (const m of builtins) {
    if (customKeys.has(`${m.provider}:${m.id}`)) continue;
    if (!isProviderConfigured(m.provider)) continue;
    modelCountByProvider.set(m.provider, (modelCountByProvider.get(m.provider) ?? 0) + 1);
  }

  const byId = new Map<
    string,
    { id: string; displayName: string; configured: boolean; source?: string; modelCount: number }
  >();

  // 1) 内置 API Key 供应商（始终出现在添加列表）
  for (const p of BUILTIN_API_KEY_PROVIDERS) {
    if (OAUTH_PROVIDER_IDS.has(p.id)) continue;
    byId.set(p.id, {
      id: p.id,
      displayName: p.displayName,
      configured: isProviderConfigured(p.id),
      source: isProviderConfigured(p.id) ? "auth_json" : undefined,
      modelCount: modelCountByProvider.get(p.id) ?? 0,
    });
  }

  // 2) models.json 中的其它供应商（非 OAuth、非仅 models.json 明文 key 的 custom）
  for (const [id, modelCount] of modelCountByProvider) {
    if (OAUTH_PROVIDER_IDS.has(id)) continue;
    if (modelsJsonKey.has(id)) continue; // 自定义端点在 Models 配置里另管
    if (byId.has(id)) {
      const cur = byId.get(id)!;
      cur.modelCount = modelCount;
      continue;
    }
    byId.set(id, {
      id,
      displayName: id,
      configured: isProviderConfigured(id),
      source: isProviderConfigured(id) ? "auth_json" : undefined,
      modelCount,
    });
  }

  const result = [...byId.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }),
  );

  return Response.json({ providers: result });
}
