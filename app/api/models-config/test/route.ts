/**
 * POST /api/models-config/test — 用纯 HTTP 探测模型连通性（不依赖 ModelRuntime / completeSimple）。
 */

import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@/lib/pi-paths";
import { resolveModelSecrets, resolveProviderSecrets } from "@/lib/models-config-service";

export const dynamic = "force-dynamic";

const TEST_TIMEOUT_MS = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 读取服务器真实 models.json 中指定 provider 的配置。客户端已不再持有
 * apiKey / 敏感 header 的原始值（GET 只返回脱敏投影），测试模型连接时
 * 需要用服务器现值补全被掩码/缺失的密钥。
 */
function readServerProvider(providerName: string): Record<string, unknown> | undefined {
  try {
    const modelsPath = join(getAgentDir(), "models.json");
    if (!existsSync(modelsPath)) return undefined;
    const parsed = JSON.parse(readFileSync(modelsPath, "utf8")) as {
      providers?: Record<string, unknown>;
    };
    const provider = parsed.providers?.[providerName];
    return isRecord(provider) ? provider : undefined;
  } catch {
    return undefined;
  }
}

function resolveApiKey(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  const envMatch = trimmed.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (envMatch) {
    const fromEnv = process.env[envMatch[1]];
    return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
  }
  return trimmed;
}

function asHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

type ProbeResult = {
  ok: boolean;
  status?: number;
  responseText?: string;
  error?: string;
};

/**
 * 按 provider.api 发最小探测请求。
 * 支持 openai-completions / openai-responses / anthropic-messages / google-generative-ai。
 */
async function probeModel(options: {
  api: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}): Promise<ProbeResult> {
  const { api, baseUrl, modelId, apiKey, headers, signal } = options;
  const base = baseUrl.replace(/\/+$/, "");
  const commonHeaders: Record<string, string> = {
    "content-type": "application/json",
    ...headers,
  };

  let url: string;
  let body: unknown;
  let authHeaders: Record<string, string>;

  if (api === "anthropic-messages" || api === "anthropic") {
    url = `${base}/v1/messages`;
    authHeaders = {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      ...commonHeaders,
    };
    body = {
      model: modelId,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with OK only." }],
    };
  } else if (api === "google-generative-ai" || api === "google") {
    url = `${base}/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    authHeaders = { ...commonHeaders };
    body = {
      contents: [{ role: "user", parts: [{ text: "Reply with OK only." }] }],
      generationConfig: { maxOutputTokens: 16 },
    };
  } else if (api === "openai-responses" || api === "responses") {
    url = `${base}/responses`;
    authHeaders = { authorization: `Bearer ${apiKey}`, ...commonHeaders };
    body = {
      model: modelId,
      input: "Reply with OK only.",
      max_output_tokens: 16,
    };
  } else {
    // openai-completions 及默认 chat completions
    url = `${base}/chat/completions`;
    authHeaders = { authorization: `Bearer ${apiKey}`, ...commonHeaders };
    body = {
      model: modelId,
      messages: [{ role: "user", content: "Reply with OK only." }],
      max_tokens: 16,
    };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(body),
    signal,
  });

  const status = response.status;
  const text = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      status,
      error: text.slice(0, 500) || `HTTP ${status}`,
    };
  }

  let responseText = "";
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    if (Array.isArray(json.choices) && isRecord(json.choices[0])) {
      const msg = json.choices[0].message;
      if (isRecord(msg) && typeof msg.content === "string") responseText = msg.content;
      else if (typeof json.choices[0].text === "string") responseText = json.choices[0].text;
    } else if (typeof json.output_text === "string") {
      responseText = json.output_text;
    } else if (Array.isArray(json.content)) {
      responseText = json.content
        .filter((b): b is { type?: string; text?: string } => isRecord(b) && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");
    } else if (Array.isArray(json.candidates) && isRecord(json.candidates[0])) {
      const content = json.candidates[0].content;
      if (isRecord(content) && Array.isArray(content.parts)) {
        responseText = content.parts
          .filter((p): p is { text?: string } => isRecord(p) && typeof p.text === "string")
          .map((p) => p.text as string)
          .join("");
      }
    }
    if (!responseText) responseText = text.slice(0, 300);
  } catch {
    responseText = text.slice(0, 300);
  }

  return { ok: true, status, responseText: responseText.slice(0, 300) };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      providerName?: unknown;
      provider?: unknown;
      model?: unknown;
    };
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName) {
      return NextResponse.json({ ok: false, error: "providerName is required" }, { status: 400 });
    }
    if (!isRecord(body.provider)) {
      return NextResponse.json({ ok: false, error: "provider is required" }, { status: 400 });
    }
    if (!isRecord(body.model)) {
      return NextResponse.json({ ok: false, error: "model is required" }, { status: 400 });
    }

    const modelId = typeof body.model.id === "string" ? body.model.id.trim() : "";
    if (!modelId) {
      return NextResponse.json({ ok: false, error: "Model ID is required" }, { status: 400 });
    }

    // 客户端 apiKey 缺失/掩码（"***"）时回退到服务器现值
    const serverProvider = readServerProvider(providerName);
    const providerBase: Record<string, unknown> = { ...(body.provider as Record<string, unknown>) };
    delete providerBase.models;
    const providerResolved = resolveProviderSecrets(providerBase, serverProvider);
    const serverModel = (Array.isArray(serverProvider?.models) ? serverProvider.models : []).find(
      (entry) => isRecord(entry) && entry.id === modelId,
    );
    const modelResolved: Record<string, unknown> = {
      ...(body.model as Record<string, unknown>),
      id: modelId,
    };
    resolveModelSecrets(modelResolved, isRecord(serverModel) ? serverModel : undefined);

    const apiKey =
      resolveApiKey(modelResolved.apiKey) ??
      resolveApiKey(providerResolved.apiKey);
    if (!apiKey) {
      return NextResponse.json({ ok: false, error: `No API key found for "${providerName}"` });
    }

    const baseUrl =
      (typeof modelResolved.baseUrl === "string" && modelResolved.baseUrl) ||
      (typeof providerResolved.baseUrl === "string" && providerResolved.baseUrl) ||
      "";
    if (!baseUrl) {
      return NextResponse.json({ ok: false, error: "baseUrl is required" }, { status: 400 });
    }

    const api =
      (typeof modelResolved.api === "string" && modelResolved.api) ||
      (typeof providerResolved.api === "string" && providerResolved.api) ||
      "openai-completions";

    const headers = {
      ...asHeaders(providerResolved.headers),
      ...asHeaders(modelResolved.headers),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    const startedAt = Date.now();

    try {
      const result = await probeModel({
        api,
        baseUrl,
        modelId,
        apiKey,
        headers,
        signal: controller.signal,
      });
      const latencyMs = Date.now() - startedAt;
      if (!result.ok) {
        return NextResponse.json({
          ok: false,
          error: result.error ?? (controller.signal.aborted ? "Test timed out" : "Model returned an error"),
          latencyMs,
          status: result.status,
        });
      }
      return NextResponse.json({
        ok: true,
        latencyMs,
        status: result.status,
        responseText: result.responseText ?? "",
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    const aborted =
      (error instanceof Error && error.name === "AbortError") ||
      (typeof error === "object" &&
        error !== null &&
        "name" in error &&
        (error as { name?: string }).name === "AbortError");
    return NextResponse.json(
      { ok: false, error: aborted ? "Test timed out" : errorMessage(error) },
      { status: aborted ? 200 : 500 },
    );
  }
}
