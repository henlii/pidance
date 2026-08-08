/**
 * OAuth provider 统一注册表（不依赖 @earendil-works/pi-coding-agent）。
 *
 * 单一事实源：登录路由（/api/auth/login/[provider]）与 provider 列表
 * （/api/auth/providers）共用本表，避免两处集合漂移。
 * anthropic 历史上被 providers 列表排除（EXCLUDED），登录路由亦不暴露。
 */

export const OAUTH_PROVIDERS = [
  { id: "openai-codex", name: "ChatGPT Plus/Pro" },
  { id: "github-copilot", name: "GitHub Copilot" },
] as const;

export type OAuthProviderId = (typeof OAUTH_PROVIDERS)[number]["id"];

export const OAUTH_PROVIDER_IDS: ReadonlySet<string> = new Set(
  OAUTH_PROVIDERS.map((p) => p.id),
);

export function isOAuthProviderId(id: string): id is OAuthProviderId {
  return OAUTH_PROVIDER_IDS.has(id);
}
