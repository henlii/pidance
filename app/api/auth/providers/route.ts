/**
 * OAuth provider 列表（自管，不依赖 ModelRuntime）。
 * 内置 OAuth 源固定为已知集合；loggedIn 读 auth-store。
 */

import { getCredential } from "@/lib/auth-store";
import { OAUTH_PROVIDERS } from "@/lib/oauth-providers";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = OAUTH_PROVIDERS.map((p) => {
    const credential = getCredential(p.id);
    const loggedIn =
      credential !== undefined &&
      (credential.type === "oauth" ||
        ("access" in credential && typeof credential.access === "string") ||
        ("refresh" in credential && typeof credential.refresh === "string"));
    return {
      id: p.id,
      name: p.name,
      usesCallbackServer: false,
      loggedIn,
    };
  });

  return Response.json({ providers: result });
}
