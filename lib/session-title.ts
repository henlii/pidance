/**
 * 会话自动命名：从消息列表 + 模型配置生成标题（HTTP chat completions）。
 *
 * 不再创建 pi Agent，不依赖 @earendil-works/pi-agent-core / pi-coding-agent：
 * - 消息来源：磁盘会话文件（SessionFile.buildSessionContext）
 * - 模型配置：settings.json 的 defaultProvider/defaultModel + models.json
 * - 请求方式：openai-completions 兼容的 POST {baseUrl}/chat/completions
 *
 * 保留纯函数：parseGeneratedSessionTitle / appendTitleRequestToTrailingUser。
 */

import { existsSync, readFileSync } from "node:fs";
import { getModelsPath, getSettingsPath } from "./pi-paths";
import { loadSettingsFile } from "./settings-store";

const TITLE_TIMEOUT_MS = 90_000;
const MAX_TITLE_LENGTH = 80;
/** 参与标题生成的最近消息上限（取最后 N 条 user/assistant） */
const MAX_TITLE_HISTORY_MESSAGES = 12;

const TITLE_PROMPT = `Create a concise title for this session based on the conversation above.

Requirements:
- Match the primary language used by the user.
- Describe the user's concrete goal or the outcome, not the act of chatting.
- Use 4-12 words for space-separated languages, or 8-24 characters for CJK text when practical.
- Do not call any tools.
- Return only the title as plain text, with no quotes, label, markdown, or explanation.`;

export interface GeneratedSessionTitle {
  title: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/** 标题请求的最小消息形状（与 Pi 会话 message 兼容的宽松投影）。 */
export type TitleRequestMessage = {
  role: string;
  content: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 从消息 content 提取纯文本（string 或 [{type:"text",text}] 块数组）；无法提取返回空串。 */
function messageToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type?: string; text?: string } =>
          isRecord(block) && block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text as string)
      .join("\n")
      .trim();
  }
  return "";
}

/**
 * 把标题请求折叠进末尾 user 消息（避免向 provider 发送两个连续 user 消息）。
 * 末条非 user（或空）时返回原数组引用；末条为 user 时返回新数组，不修改源数组。
 */
export function appendTitleRequestToTrailingUser(
  messages: TitleRequestMessage[],
): TitleRequestMessage[] {
  const lastMessage = messages.at(-1);
  if (!lastMessage || lastMessage.role !== "user") return messages;

  const content =
    typeof lastMessage.content === "string"
      ? `${lastMessage.content}\n\n${TITLE_PROMPT}`
      : [
          ...(Array.isArray(lastMessage.content) ? lastMessage.content : []),
          { type: "text" as const, text: TITLE_PROMPT },
        ];

  return [...messages.slice(0, -1), { ...lastMessage, content }];
}

function stripWrappingQuotes(value: string): string {
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["\u201c", "\u201d"],
    ["\u300c", "\u300d"],
    ["\u300e", "\u300f"],
  ];
  for (const [start, end] of pairs) {
    if (value.startsWith(start) && value.endsWith(end) && value.length > start.length + end.length) {
      return value.slice(start.length, -end.length).trim();
    }
  }
  return value;
}

export function parseGeneratedSessionTitle(raw: string): string {
  let value = raw.trim();
  const fenced = value.match(/^```(?:json|text)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) value = fenced[1].trim();

  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as { title?: unknown };
      if (typeof parsed.title === "string") value = parsed.title.trim();
    } catch {
      // Fall back to plain-text cleanup below.
    }
  }

  value = value.split(/\r?\n/, 1)[0] ?? "";
  value = value.replace(/^(?:session\s+title|title|标题)\s*[:：-]\s*/i, "");
  value = stripWrappingQuotes(value).replace(/\s+/g, " ").trim();
  value = value.replace(/[。.!]+$/u, "").trim();

  if (!/[\p{L}\p{N}]/u.test(value)) {
    throw new Error("The model did not return a usable session title");
  }

  const characters = Array.from(value);
  if (characters.length > MAX_TITLE_LENGTH) {
    value = characters.slice(0, MAX_TITLE_LENGTH).join("").trim();
  }
  return value;
}

/** 从 chat completions 响应提取 assistant 文本（choices[0].message.content / .text）。 */
function extractCompletionText(json: unknown): string {
  if (!isRecord(json)) return "";
  const choices = json.choices;
  if (Array.isArray(choices)) {
    const first = choices[0];
    if (isRecord(first)) {
      const message = first.message;
      if (isRecord(message) && typeof message.content === "string") return message.content;
      if (typeof first.text === "string") return first.text;
    }
  }
  if (typeof json.output_text === "string") return json.output_text;
  return "";
}

function parseUsage(usage: Record<string, unknown>): GeneratedSessionTitle["usage"] {
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  return {
    input: num(usage.prompt_tokens),
    output: num(usage.completion_tokens),
    cacheRead: num(details.cached_tokens),
    cacheWrite: num(details.cache_creation_input_tokens),
    total: num(usage.total_tokens),
  };
}

/**
 * 从消息列表生成会话标题：HTTP POST {baseUrl}/chat/completions（openai-completions）。
 * - 无 user 消息 → throw
 * - 取最近 MAX_TITLE_HISTORY_MESSAGES 条 user/assistant 文本摘要，末尾折叠 TITLE_PROMPT
 * - 超时 TITLE_TIMEOUT_MS；外部 signal 中止同样生效（两者任一先触发）
 */
export async function generateSessionTitleFromMessages(options: {
  messages: Array<{ role: string; content: unknown }>;
  provider: string;
  modelId: string;
  baseUrl: string;
  api?: string; // 默认 openai-completions
  apiKey: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<GeneratedSessionTitle> {
  // provider/api 保留在签名中（设计约定；当前实现固定 openai-completions，暂未分支）
  const { messages, modelId, baseUrl, apiKey, headers, signal } = options;

  if (!messages.some((message) => message.role === "user")) {
    throw new Error("The session has no user messages to name");
  }

  // 取最近若干条 user/assistant 文本摘录（跳过 toolResult/custom 等；空文本 assistant 跳过）
  const recent: TitleRequestMessage[] = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-MAX_TITLE_HISTORY_MESSAGES)
    .map((message) => ({ role: message.role, content: messageToText(message.content) }))
    .filter((message) => message.role === "user" || (typeof message.content === "string" && message.content.length > 0));

  // 末尾折叠标题请求；末条非 user 时追加一条标题请求
  const prepared = appendTitleRequestToTrailingUser(recent);
  if (prepared === recent) {
    recent.push({ role: "user", content: TITLE_PROMPT });
  }

  const titleMessages = prepared.map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content,
  }));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    const base = baseUrl.replace(/\/+$/, "");
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        ...headers,
      },
      body: JSON.stringify({
        model: modelId,
        messages: titleMessages,
        max_tokens: 64,
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(text.slice(0, 500) || `HTTP ${response.status}`);
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("The model did not return a usable session title");
    }

    const content = extractCompletionText(json);
    if (!content) {
      throw new Error("The model did not return a session title");
    }

    return {
      title: parseGeneratedSessionTitle(content),
      ...(isRecord(json) && isRecord(json.usage) ? { usage: parseUsage(json.usage) } : {}),
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

// ---------------------------------------------------------------------------
// 模型配置解析（settings.json + models.json → 标题请求所需配置）
// ---------------------------------------------------------------------------

/** 标题请求的模型配置：provider/modelId/baseUrl/api/apiKey/headers。 */
export type TitleModelConfig = {
  provider: string;
  modelId: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  headers: Record<string, string>;
};

/** ${ENV} 环境变量引用展开（models.json 的 apiKey 支持，与 models-config/test 一致）。 */
function resolveEnvValue(value: string): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (match) {
    const fromEnv = process.env[match[1]];
    return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
  }
  return value;
}

function asHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === "string") out[key] = val;
  }
  return out;
}

/**
 * 从磁盘解析默认模型的调用配置（不创建 pi Agent / 不依赖 auth-store）：
 * - settings.json 的 defaultProvider / defaultModel 定位模型
 * - models.json 的 provider 级与 model 级 baseUrl/api/apiKey/headers（model 覆盖 provider）
 * - apiKey 支持 ${ENV} 展开；失败抛明确错误，由调用方映射 500
 */
export function resolveTitleModelConfig(options?: {
  settingsPath?: string;
  modelsPath?: string;
}): TitleModelConfig {
  const settingsPath = options?.settingsPath ?? getSettingsPath();
  const modelsPath = options?.modelsPath ?? getModelsPath();
  const settings = loadSettingsFile(settingsPath);

  const provider = asString(settings.defaultProvider);
  const modelId = asString(settings.defaultModel);
  if (!provider || !modelId) {
    throw new Error(
      "No default model configured: set defaultProvider/defaultModel in settings.json",
    );
  }

  let parsed: unknown;
  try {
    if (!existsSync(modelsPath)) throw new Error("missing");
    parsed = JSON.parse(readFileSync(modelsPath, "utf8"));
  } catch {
    throw new Error(`models.json not found or unreadable: ${modelsPath}`);
  }
  if (!isRecord(parsed)) throw new Error(`models.json is not an object: ${modelsPath}`);

  const providers = isRecord(parsed.providers) ? parsed.providers : {};
  const providerConfig = isRecord(providers[provider]) ? providers[provider] : undefined;
  if (!providerConfig) {
    throw new Error(`Model provider not found in models.json: ${provider}`);
  }

  const models = Array.isArray(providerConfig.models) ? providerConfig.models : [];
  const overrides = isRecord(providerConfig.modelOverrides) ? providerConfig.modelOverrides : {};
  const rawModel =
    models.find((entry) => isRecord(entry) && asString(entry.id) === modelId) ??
    overrides[modelId];
  const modelConfig = isRecord(rawModel) ? rawModel : undefined;
  if (!modelConfig) {
    throw new Error(`Model not found in models.json: ${provider}/${modelId}`);
  }

  const apiKey =
    resolveEnvValue(asString(modelConfig.apiKey)) ??
    resolveEnvValue(asString(providerConfig.apiKey));
  if (!apiKey) {
    throw new Error(`No API key found for "${provider}"`);
  }

  const baseUrl = asString(modelConfig.baseUrl) || asString(providerConfig.baseUrl);
  if (!baseUrl) {
    throw new Error(`baseUrl is required for "${provider}"`);
  }

  return {
    provider,
    modelId,
    baseUrl,
    api: asString(modelConfig.api) || asString(providerConfig.api) || "openai-completions",
    apiKey,
    headers: { ...asHeaders(providerConfig.headers), ...asHeaders(modelConfig.headers) },
  };
}
