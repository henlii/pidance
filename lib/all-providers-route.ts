/**
 * API-key provider 列表：内置目录 + models.json 中已有供应商 + **扩展注册的 provider** + auth 状态。
 * 不依赖 ModelRuntime；OAuth 供应商走 /api/auth/providers。
 *
 * 扩展 provider 的来源见 lib/extension-providers.ts（SDK 默认 resource loader 加载扩展后的
 * pending 注册）。加载失败只降级为空列表并把原因放进 extensionProvidersError，不影响内置目录。
 *
 * `createAllProvidersHandler` 暴露出来只为可测：路由本身不注入实现，测试传假加载器即可断言
 * 「扩展 provider 出现在列表里 / 与内置同 id 时不覆盖 / 失败不炸」。
 */

import { isProviderConfigured } from "@/lib/auth-store";
import { BUILTIN_API_KEY_PROVIDERS } from "@/lib/builtin-api-key-providers";
import { listExtensionProviders } from "@/lib/extension-providers";
import { OAUTH_PROVIDER_IDS } from "@/lib/oauth-providers";
import { listModelsFromModelsJson } from "@/lib/models-catalog";
import { listBuiltinCatalogModels } from "@/lib/pi-builtin-models";
import { getAgentDir, getModelsPath } from "@/lib/pi-paths";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";


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

type ExtensionListFn = typeof listExtensionProviders;

export function createAllProvidersHandler(listExtensions: ExtensionListFn = listExtensionProviders) {
  return async function GET(req: Request) {
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

  // 3) 扩展注册的 provider：未认证的也要进来，否则用户没法给它配 Key（#833）。
  //    已在内置/models.json 列表里的不覆盖（来源以「用户已能看到的那个」为准）。
  const requestedCwd = new URL(req.url).searchParams.get("cwd");
  const extension = await listExtensions({
    cwd: resolve(requestedCwd && requestedCwd.trim() !== "" ? requestedCwd : process.cwd()),
    agentDir: getAgentDir(),
  });
  for (const p of extension.providers) {
    if (OAUTH_PROVIDER_IDS.has(p.id)) continue;
    if (byId.has(p.id)) continue;
    byId.set(p.id, {
      id: p.id,
      displayName: p.displayName,
      configured: isProviderConfigured(p.id),
      source: "extension",
      modelCount: p.modelCount,
    });
  }

  const result = [...byId.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }),
  );

    return Response.json({
      providers: result,
      ...(extension.error ? { extensionProvidersError: extension.error } : {}),
    });
  };
}
