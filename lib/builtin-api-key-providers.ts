/**
 * Pi 内置 API-key 类供应商目录（静态，不依赖 SDK ModelRuntime）。
 * OAuth 供应商（openai-codex / github-copilot）不在此列（走 /api/auth/providers）。
 * 与 ModelsConfig 图标表对齐，供「添加提供商」选择器使用。
 */

export type BuiltinApiKeyProvider = {
  id: string;
  displayName: string;
};

/** 添加提供商时展示的内置 API Key 选项。 */
export const BUILTIN_API_KEY_PROVIDERS: readonly BuiltinApiKeyProvider[] = [
  { id: "openai", displayName: "OpenAI" },
  { id: "anthropic", displayName: "Anthropic" },
  { id: "google", displayName: "Google" },
  { id: "google-vertex", displayName: "Google Vertex" },
  { id: "deepseek", displayName: "DeepSeek" },
  { id: "groq", displayName: "Groq" },
  { id: "mistral", displayName: "Mistral" },
  { id: "openrouter", displayName: "OpenRouter" },
  { id: "xai", displayName: "xAI" },
  { id: "fireworks", displayName: "Fireworks" },
  { id: "together", displayName: "Together" },
  { id: "cerebras", displayName: "Cerebras" },
  { id: "huggingface", displayName: "Hugging Face" },
  { id: "cohere", displayName: "Cohere" },
  { id: "perplexity", displayName: "Perplexity" },
  { id: "moonshotai", displayName: "Moonshot AI" },
  { id: "moonshotai-cn", displayName: "Moonshot AI (CN)" },
  { id: "minimax", displayName: "MiniMax" },
  { id: "minimax-cn", displayName: "MiniMax (CN)" },
  { id: "qwen", displayName: "Qwen" },
  { id: "zai", displayName: "Z.AI" },
  { id: "zhipu", displayName: "Zhipu" },
  { id: "kimi-coding", displayName: "Kimi Coding" },
  { id: "nvidia", displayName: "NVIDIA" },
  { id: "opencode", displayName: "OpenCode" },
  { id: "amazon-bedrock", displayName: "Amazon Bedrock" },
  // SDK 1.0.3 把 provider id 从 azure-openai-responses 改成 azure；老配置仍要认得
  { id: "azure", displayName: "Azure OpenAI" },
  { id: "azure-openai-responses", displayName: "Azure OpenAI (legacy id)" },
  { id: "cloudflare-ai-gateway", displayName: "Cloudflare AI Gateway" },
  { id: "vercel-ai-gateway", displayName: "Vercel AI Gateway" },
  { id: "xiaomi", displayName: "Xiaomi" },
] as const;
