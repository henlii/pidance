/**
 * API key 状态/写入/删除：凭据走 auth-store；catalog 字段从 models.json 推导。
 */

import { NextResponse } from "next/server";
import {
  deleteCredential,
  getCredential,
  isProviderConfigured,
  setApiKey,
} from "@/lib/auth-store";
import { invalidateModelsCache } from "@/lib/models-cache";
import { listModelsFromModelsJson } from "@/lib/models-catalog";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ provider: string }> };

function authSource(provider: string): string | undefined {
  const cred = getCredential(provider);
  if (cred) {
    if (cred.type === "api_key") return "auth_json";
    if (cred.type === "oauth") return "oauth";
    return "auth_json";
  }
  // models.json 兜底
  if (isProviderConfigured(provider)) return "models_json_key";
  return undefined;
}

// GET /api/auth/api-key/[provider] — returns auth status (never returns the actual key)
export async function GET(_req: Request, { params }: Params) {
  const { provider } = await params;
  const displayName = provider;
  const models = listModelsFromModelsJson().filter((m) => m.provider === provider).length;
  return NextResponse.json({
    provider,
    displayName,
    configured: isProviderConfigured(provider),
    source: authSource(provider),
    models,
  });
}

// POST /api/auth/api-key/[provider]  body: { apiKey: string }
export async function POST(req: Request, { params }: Params) {
  const { provider } = await params;
  try {
    const { apiKey } = (await req.json()) as { apiKey?: string };
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
    }
    setApiKey(provider, apiKey.trim());
    invalidateModelsCache();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/auth/api-key/[provider] — removes stored API key
export async function DELETE(_req: Request, { params }: Params) {
  const { provider } = await params;
  try {
    deleteCredential(provider);
    invalidateModelsCache();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
