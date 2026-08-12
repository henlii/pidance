/**
 * models.json 配置服务：GET 脱敏投影 + PUT 校验/保留语义/原子写。
 *
 * 背景（发布阻断 P0）：原 /api/models-config 直接 readFileSync 返回整个
 * models.json，provider.apiKey 与 headers 中的敏感值（authorization、
 * x-api-key 等）原样进入浏览器/DevTools/日志；PUT 则接受任意 JSON 直接
 * writeFileSync，无 schema/大小校验、非原子、无冲突检测、多标签页互覆盖。
 *
 * 本模块把 route 下沉为纯逻辑：
 * - GET：返回可编辑投影——apiKey 原值下发（设置页基础表单与原始 JSON 一致，
 *   再隐藏无意义）；敏感 header 仍打码为 "***"（非敏感 header 原值保留）；
 *   附带 apiKeyConfigured + baseline（mtimeMs/size）供 UI/冲突检测。
 * - PUT：apiKey 未提交（undefined）或掩码（"***"/空）→ 保留服务器现值，
 *   显式 null → 删除，正常字符串 → 更新；headers 为 merge 覆盖层——
 *   未提交键保留、null 删除、掩码保留现值（provider/model/modelOverride
 *   三级同规则）。
 * - 原子写：同目录临时文件独占创建（wx）+ chmod 保持权限 + rename 覆盖，
 *   失败清理临时文件、不破坏原文件（参考 lib/file-save.ts 模式）。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

// ── 常量与上限 ──────────────────────────────────────────────────────────────

/** 序列化后总字节上限（1MiB） */
export const MODELS_CONFIG_MAX_BYTES = 1024 * 1024;
export const MODELS_CONFIG_MAX_PROVIDERS = 256;
export const MODELS_CONFIG_MAX_MODELS_PER_PROVIDER = 512;
export const MODELS_CONFIG_MAX_OVERRIDES_PER_PROVIDER = 512;
export const MODELS_CONFIG_MAX_HEADERS_PER_PROVIDER = 64;
export const MODELS_CONFIG_MAX_STRING_LENGTH = 4096;
export const MODELS_CONFIG_MAX_KEY_LENGTH = 256;

/** apiKey / 敏感 header 的掩码哨兵：GET 投影使用；PUT 收到视为「保留服务器现值」。 */
export const SECRET_MASK = "***";

/** header 敏感键（大小写不敏感）：GET 打码、PUT 掩码保留现值。 */
const SENSITIVE_HEADER_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "cookie",
  "set-cookie",
  "proxy-authenticate",
  "www-authenticate",
]);

export function isSensitiveHeaderKey(key: string): boolean {
  return SENSITIVE_HEADER_KEYS.has(key.trim().toLowerCase());
}

export interface Baseline {
  mtimeMs: number;
  size: number;
}

export class ModelsConfigError extends Error {
  readonly code: "bad-request" | "conflict";
  constructor(code: "bad-request" | "conflict", message: string) {
    super(message);
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── 读取 ─────────────────────────────────────────────────────────────────────

function readModelsFile(modelsPath: string): { data: Record<string, unknown>; baseline: Baseline | null } {
  if (!existsSync(modelsPath)) return { data: { providers: {} }, baseline: null };
  const stats = statSync(modelsPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(modelsPath, "utf8"));
  } catch {
    parsed = { providers: {} }; // 损坏降级：视作空配置，不抛 500
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.providers)) parsed = { providers: {} };
  return { data: parsed as Record<string, unknown>, baseline: { mtimeMs: stats.mtimeMs, size: stats.size } };
}

// ── GET 脱敏投影 ─────────────────────────────────────────────────────────────

export interface SanitizedModelEntry {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: Record<string, unknown>;
  compat?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface SanitizedProviderConfig {
  name?: string;
  baseUrl?: string;
  api?: string;
  oauth?: "radius";
  authHeader?: boolean;
  compat?: Record<string, unknown>;
  models?: SanitizedModelEntry[];
  modelOverrides?: Record<string, SanitizedModelEntry>;
  headers?: Record<string, string>;
  /** 是否配置了自定义 header（敏感值已打码为 "***"） */
  headersConfigured?: boolean;
  /** 服务器是否已配置 apiKey */
  apiKeyConfigured: boolean;
  /** 当前 apiKey 原值（设置页可编辑；与 raw JSON 一致） */
  apiKey?: string;
}

export interface SanitizedModelsConfig {
  providers: Record<string, SanitizedProviderConfig>;
  baseline: Baseline | null;
}

function sanitizeHeaders(headers: unknown): { headers?: Record<string, string>; headersConfigured?: boolean } {
  if (!isPlainObject(headers)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] =
      typeof value === "string" && isSensitiveHeaderKey(key)
        ? SECRET_MASK
        : typeof value === "string" ? value : String(value);
  }
  return Object.keys(out).length > 0 ? { headers: out, headersConfigured: true } : {};
}

function sanitizeModel(model: unknown): SanitizedModelEntry | null {
  if (!isPlainObject(model)) return null;
  const { headers, ...rest } = model as Record<string, unknown>;
  const out = { ...rest } as unknown as SanitizedModelEntry;
  const h = sanitizeHeaders(headers);
  if (h.headers) out.headers = h.headers;
  return out;
}

function sanitizeProvider(provider: unknown): SanitizedProviderConfig | null {
  if (!isPlainObject(provider)) return null;
  const { apiKey, headers, models, modelOverrides, ...rest } = provider as Record<string, unknown>;
  const out = { ...rest } as unknown as SanitizedProviderConfig;
  out.apiKeyConfigured = typeof apiKey === "string" && apiKey.length > 0;
  // 基础表单直接加载密钥（设置页另有 raw JSON 已含密钥，再脱敏无意义）
  if (typeof apiKey === "string" && apiKey.length > 0) out.apiKey = apiKey;
  const h = sanitizeHeaders(headers);
  if (h.headers) {
    out.headers = h.headers;
    out.headersConfigured = true;
  }
  if (Array.isArray(models)) {
    out.models = models.map(sanitizeModel).filter((m): m is SanitizedModelEntry => m !== null);
  }
  if (isPlainObject(modelOverrides)) {
    const overrides: Record<string, SanitizedModelEntry> = {};
    for (const [id, override] of Object.entries(modelOverrides)) {
      const sanitized = sanitizeModel(override);
      if (sanitized) overrides[id] = sanitized;
    }
    if (Object.keys(overrides).length > 0) out.modelOverrides = overrides;
  }
  return out;
}

export function getSanitizedModelsConfig(modelsPath: string): SanitizedModelsConfig {
  const { data, baseline } = readModelsFile(modelsPath);
  const providers = (data.providers as Record<string, unknown> | undefined) ?? {};
  const result: Record<string, SanitizedProviderConfig> = {};
  for (const [name, provider] of Object.entries(providers)) {
    const sanitized = sanitizeProvider(provider);
    if (sanitized) result[name] = sanitized;
  }
  return { providers: result, baseline };
}

// ── PUT 校验 ─────────────────────────────────────────────────────────────────

function fail(path: string, detail: string): never {
  throw new ModelsConfigError("bad-request", `models.json 校验失败：${path}（${detail}）`);
}

function checkOptionalString(value: unknown, path: string): void {
  if (value === undefined) return;
  if (typeof value !== "string") fail(path, "期望字符串");
  if (value.length > MODELS_CONFIG_MAX_STRING_LENGTH) fail(path, `超过 ${MODELS_CONFIG_MAX_STRING_LENGTH} 字符上限`);
}

function checkOptionalBoolean(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== "boolean") fail(path, "期望布尔值");
}

function checkOptionalNumber(value: unknown, path: string): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) fail(path, "期望有限数字");
}

/** headers 等字符串键值对象；允许 null 值（merge 语义表示删除），其余必须为字符串。 */
function checkOptionalStringRecord(value: unknown, path: string, countLimit: number): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) fail(path, "期望键值对象");
  const entries = Object.entries(value);
  if (entries.length > countLimit) fail(path, `超过 ${countLimit} 个键上限`);
  for (const [key, val] of entries) {
    if (key.length > MODELS_CONFIG_MAX_KEY_LENGTH) fail(`${path}.${key}`, "键名超长");
    if (val === null) continue;
    if (typeof val !== "string") fail(`${path}.${key}`, "期望字符串值");
    if (val.length > MODELS_CONFIG_MAX_STRING_LENGTH) fail(`${path}.${key}`, `超过 ${MODELS_CONFIG_MAX_STRING_LENGTH} 字符上限`);
  }
}

function checkThinkingLevelMap(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) fail(path, "期望对象");
  for (const [key, val] of Object.entries(value)) {
    if (val !== null && typeof val !== "string") fail(`${path}.${key}`, "期望字符串或 null");
    if (typeof val === "string" && val.length > MODELS_CONFIG_MAX_STRING_LENGTH) fail(`${path}.${key}`, "超长");
  }
}

function checkModelShape(model: unknown, path: string, requireId: boolean): void {
  if (!isPlainObject(model)) fail(path, "期望对象");
  if (requireId) {
    const id = model.id;
    if (typeof id !== "string" || id.trim() === "") fail(`${path}.id`, "必须是非空字符串");
    if (id.length > MODELS_CONFIG_MAX_STRING_LENGTH) fail(`${path}.id`, "超长");
  }
  checkOptionalString(model.name, `${path}.name`);
  checkOptionalString(model.api, `${path}.api`);
  checkOptionalString(model.baseUrl, `${path}.baseUrl`);
  checkOptionalBoolean(model.reasoning, `${path}.reasoning`);
  checkThinkingLevelMap(model.thinkingLevelMap, `${path}.thinkingLevelMap`);
  if (model.input !== undefined) {
    if (!Array.isArray(model.input) || model.input.some((item) => item !== "text" && item !== "image")) {
      fail(`${path}.input`, "期望 ['text'|'image'] 数组");
    }
  }
  checkOptionalNumber(model.contextWindow, `${path}.contextWindow`);
  checkOptionalNumber(model.maxTokens, `${path}.maxTokens`);
  checkOptionalStringRecord(model.headers, `${path}.headers`, MODELS_CONFIG_MAX_HEADERS_PER_PROVIDER);
  if (model.compat !== undefined && !isPlainObject(model.compat)) fail(`${path}.compat`, "期望对象");
  if (model.cost !== undefined) {
    if (!isPlainObject(model.cost)) fail(`${path}.cost`, "期望对象");
    for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
      checkOptionalNumber(model.cost[key], `${path}.cost.${key}`);
    }
  }
}

function validateProvider(provider: unknown, path: string): void {
  if (!isPlainObject(provider)) fail(path, "期望对象");
  checkOptionalString(provider.name, `${path}.name`);
  checkOptionalString(provider.baseUrl, `${path}.baseUrl`);
  // apiKey 允许 null（merge 语义：显式删除）
  if (provider.apiKey !== undefined && provider.apiKey !== null) {
    checkOptionalString(provider.apiKey, `${path}.apiKey`);
  }
  checkOptionalString(provider.api, `${path}.api`);
  if (provider.oauth !== undefined && provider.oauth !== "radius") fail(`${path}.oauth`, "仅支持 'radius'");
  checkOptionalBoolean(provider.authHeader, `${path}.authHeader`);
  checkOptionalStringRecord(provider.headers, `${path}.headers`, MODELS_CONFIG_MAX_HEADERS_PER_PROVIDER);
  if (provider.compat !== undefined && !isPlainObject(provider.compat)) fail(`${path}.compat`, "期望对象");
  if (provider.models !== undefined) {
    if (!Array.isArray(provider.models)) fail(`${path}.models`, "期望数组");
    if (provider.models.length > MODELS_CONFIG_MAX_MODELS_PER_PROVIDER) {
      fail(`${path}.models`, `超过 ${MODELS_CONFIG_MAX_MODELS_PER_PROVIDER} 个模型上限`);
    }
    provider.models.forEach((model, index) => checkModelShape(model, `${path}.models[${index}]`, true));
  }
  if (provider.modelOverrides !== undefined) {
    if (!isPlainObject(provider.modelOverrides)) fail(`${path}.modelOverrides`, "期望对象");
    const entries = Object.entries(provider.modelOverrides);
    if (entries.length > MODELS_CONFIG_MAX_OVERRIDES_PER_PROVIDER) {
      fail(`${path}.modelOverrides`, `超过 ${MODELS_CONFIG_MAX_OVERRIDES_PER_PROVIDER} 个覆盖上限`);
    }
    for (const [modelId, override] of entries) {
      if (modelId.length > MODELS_CONFIG_MAX_KEY_LENGTH) fail(`${path}.modelOverrides.${modelId}`, "键名超长");
      checkModelShape(override, `${path}.modelOverrides.${modelId}`, false);
    }
  }
  // 剔除 GET 投影专用字段，避免回写 models.json
  delete provider.apiKeyConfigured;
  delete provider.headersConfigured;
}

/**
 * 校验并归一化 PUT 载荷；返回 { providers }（原地剔除投影专用字段）。
 * 仅校验已知字段的类型与上限，未知字段原样保留（SDK 容忍额外字段，
 * 避免破坏用户数据）；root 非对象直接拒绝。
 */
export function validateAndNormalize(incoming: unknown): { providers: Record<string, unknown> } {
  if (!isPlainObject(incoming)) fail("root", "期望对象");
  if (incoming.providers === undefined) return { providers: {} };
  if (!isPlainObject(incoming.providers)) fail("providers", "期望对象");
  const names = Object.keys(incoming.providers);
  if (names.length > MODELS_CONFIG_MAX_PROVIDERS) fail("providers", `超过 ${MODELS_CONFIG_MAX_PROVIDERS} 个 provider 上限`);
  for (const name of names) {
    if (name.length > MODELS_CONFIG_MAX_KEY_LENGTH) fail(`providers.${name}`, "名称超长");
    validateProvider(incoming.providers[name], `providers.${name}`);
  }
  return { providers: incoming.providers };
}

// ── PUT 保留/删除/更新语义 ────────────────────────────────────────────────────

function mergeHeaderOverlay(
  incoming: Record<string, unknown>,
  current: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null) delete result[key];
    else if (value === SECRET_MASK) { /* 掩码：保留服务器现值 */ }
    else result[key] = value;
  }
  return result;
}

/** 单个 model / modelOverride 的 headers merge（未提交键保留、null 删除、掩码保留现值）。 */
export function resolveModelSecrets(incoming: Record<string, unknown>, current: Record<string, unknown> | undefined): void {
  if (!isPlainObject(incoming.headers)) return;
  const merged = mergeHeaderOverlay(incoming.headers, isPlainObject(current?.headers) ? current.headers : {});
  if (Object.keys(merged).length === 0) delete incoming.headers;
  else incoming.headers = merged;
}

/**
 * 把客户端提交的 provider 与服务器现值合并（返回新对象，不修改入参）：
 * - apiKey：未提交（无该键）/ 掩码（"***"/空）→ 保留服务器现值；null → 删除；字符串 → 更新
 * - headers：merge 覆盖层，provider/model/modelOverride 三级同规则
 */
export function resolveProviderSecrets(
  incoming: Record<string, unknown>,
  current: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...incoming };
  if ("apiKey" in out) {
    const value = out.apiKey;
    if (value === null) delete out.apiKey;
    else if (typeof value === "string" && (value.trim() === "" || value === SECRET_MASK)) {
      // 掩码/空：保留服务器现值
      if (isPlainObject(current) && typeof current.apiKey === "string") out.apiKey = current.apiKey;
      else delete out.apiKey;
    }
    // 其余真实字符串保留
  } else if (isPlainObject(current) && typeof current.apiKey === "string") {
    // 未提交 apiKey：保留服务器现值
    out.apiKey = current.apiKey;
  }
  if (isPlainObject(out.headers)) {
    const merged = mergeHeaderOverlay(out.headers, isPlainObject(current?.headers) ? current.headers : {});
    if (Object.keys(merged).length === 0) delete out.headers;
    else out.headers = merged;
  }
  if (Array.isArray(out.models)) {
    const currentModels = Array.isArray(current?.models) ? current.models : [];
    for (const model of out.models) {
      if (isPlainObject(model)) {
        const cur = currentModels.find((entry) => isPlainObject(entry) && entry.id === model.id);
        resolveModelSecrets(model, isPlainObject(cur) ? cur : undefined);
      }
    }
  }
  if (isPlainObject(out.modelOverrides)) {
    const currentOverrides = isPlainObject(current?.modelOverrides) ? current.modelOverrides : {};
    for (const [modelId, override] of Object.entries(out.modelOverrides)) {
      if (isPlainObject(override)) {
        const cur = isPlainObject(currentOverrides[modelId]) ? currentOverrides[modelId] : undefined;
        resolveModelSecrets(override, cur);
      }
    }
  }
  return out;
}

// ── PUT 保存（校验 + 冲突检测 + 原子写） ───────────────────────────────────────

export interface SaveModelsConfigResult {
  success: true;
  baseline: Baseline;
}

export function saveModelsConfig(
  modelsPath: string,
  incoming: unknown,
  baseline: Baseline | null,
): SaveModelsConfigResult {
  const current = readModelsFile(modelsPath);
  if (baseline) {
    if (!current.baseline) {
      throw new ModelsConfigError("conflict", "配置文件已被删除，请刷新后重试");
    }
    if (current.baseline.mtimeMs !== baseline.mtimeMs || current.baseline.size !== baseline.size) {
      throw new ModelsConfigError("conflict", "配置文件已被其他会话修改，请刷新后重试");
    }
  }

  const normalized = validateAndNormalize(incoming);
  const currentProviders = isPlainObject(current.data.providers) ? current.data.providers : {};
  const mergedProviders: Record<string, unknown> = {};
  for (const [name, provider] of Object.entries(normalized.providers)) {
    const rawCur = currentProviders[name];
    const cur = isPlainObject(rawCur) ? rawCur : undefined;
    mergedProviders[name] = resolveProviderSecrets(provider as Record<string, unknown>, cur);
  }
  const finalData = { providers: mergedProviders };
  const serialized = JSON.stringify(finalData, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > MODELS_CONFIG_MAX_BYTES) {
    throw new ModelsConfigError("bad-request", `配置超过 ${MODELS_CONFIG_MAX_BYTES / 1024 / 1024}MiB 上限`);
  }

  atomicWrite(modelsPath, serialized);
  const after = statSync(modelsPath);
  return { success: true, baseline: { mtimeMs: after.mtimeMs, size: after.size } };
}

/**
 * 原子写：同目录临时文件独占创建（wx）+ chmod 保持原权限 + rename 覆盖；
 * 任一步失败清理临时文件、不破坏原文件（参考 lib/file-save.ts 模式）。
 */
function atomicWrite(modelsPath: string, serialized: string): void {
  const dir = dirname(modelsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const originalMode = existsSync(modelsPath) ? statSync(modelsPath).mode & 0o7777 : 0o644;
  const temp = join(dir, `.models-config-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, serialized, { flag: "wx", mode: originalMode });
    chmodSync(temp, originalMode);
    renameSync(temp, modelsPath);
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // 清理失败不覆盖原错误
    }
    throw error;
  }
}
