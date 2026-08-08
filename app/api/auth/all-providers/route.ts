/**
 * API-key provider 列表：从 models.json + auth-store 推导（不依赖 ModelRuntime）。
 * OAuth-only provider 排除（走 /api/auth/providers）。
 */

import { isProviderConfigured } from "@/lib/auth-store";
import { listModelsFromModelsJson } from "@/lib/models-catalog";
import { getModelsPath } from "@/lib/pi-paths";
import { existsSync, readFileSync } from "node:fs";

export const dynamic = "force-dynamic";

const OAUTH_PROVIDER_IDS = new Set(["anthropic", "github-copilot", "openai-codex"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** models.json 中有 apiKey 的 provider 视为 custom（source=models_json_key），历史逻辑会跳过 */
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
  const modelsJsonKey = providersWithModelsJsonKey();
  const byProvider = new Map<string, number>();
  for (const m of models) {
    byProvider.set(m.provider, (byProvider.get(m.provider) ?? 0) + 1);
  }

  const result: {
    id: string;
    displayName: string;
    configured: boolean;
    source?: string;
    modelCount: number;
  }[] = [];

  for (const [id, modelCount] of byProvider) {
    if (OAUTH_PROVIDER_IDS.has(id)) continue;
    // 与历史：跳过 key 仅来自 models.json 的 custom provider（在 ModelsConfig 里另管）
    if (modelsJsonKey.has(id) && !isProviderConfigured(id)) continue;
    if (modelsJsonKey.has(id)) {
      // 有 models.json key 但历史会 skip source===models_json_key 的整项
      // 保持：这类 provider 不进 all-providers 列表
      continue;
    }
    result.push({
      id,
      displayName: id,
      configured: isProviderConfigured(id),
      source: isProviderConfigured(id) ? "auth_json" : undefined,
      modelCount,
    });
  }

  return Response.json({ providers: result });
}
