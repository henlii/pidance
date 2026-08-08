/**
 * OAuth logout：删除 auth.json 中的凭据（自管，不依赖 ModelRuntime）。
 */

import { deleteCredential, getCredential } from "@/lib/auth-store";
import { invalidateModelsCache } from "@/lib/models-cache";

export const dynamic = "force-dynamic";

const OAUTH_PROVIDER_IDS = new Set(["anthropic", "github-copilot", "openai-codex"]);

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  if (!OAUTH_PROVIDER_IDS.has(provider)) {
    return Response.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
  }
  // 无凭据也返回 ok（幂等）
  const existing = getCredential(provider);
  if (existing) deleteCredential(provider);
  invalidateModelsCache();
  return Response.json({ ok: true });
}
