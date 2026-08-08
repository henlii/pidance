/**
 * auth.json 自管读写 seam。
 *
 * 背景：ModelRuntime 的凭据读路径（getProviderAuthStatus / listCredentials）
 * 每次都要重建 runtime，且混合 auth.json / models.json / 环境变量多个来源；
 * 多数只读调用点只想知道「某个 provider 是否已配置」。本模块直接读写
 * ~/.pi/agent/auth.json（经 lib/pi-paths.ts 的 getAuthPath），支持历史格式
 * 的顶层 providers 嵌套，并提供 ${ENV} 模板解析。
 *
 * 写入语义：
 * - setApiKey / deleteCredential 只动 auth.json 的 flat 位置（读取先命中 flat，
 *   兼容嵌套历史格式），models.json 的 apiKey 由 /api/models-config 管理，本模块不写。
 * - saveAuthFile 原子写 + mode 0o600（凭据文件不得放权），模式参考
 *   lib/models-config-service.ts 的 atomicWrite。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { getAuthPath, getModelsPath } from "./pi-paths";

export type AuthCredential =
  | { type: "api_key"; key: string; env?: Record<string, string> }
  | { type: "oauth"; access?: string; refresh?: string; expires?: number; [k: string]: unknown }
  | Record<string, unknown>;

export type AuthFile = Record<string, AuthCredential | unknown>;

/** 历史格式：顶层 providers 嵌套 map 的固定键名 */
const NESTED_PROVIDERS_KEY = "providers";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── 读写 ─────────────────────────────────────────────────────────────────────

/** 读取整个 auth 文件；缺失→{}，损坏/非对象→{}（降级为安全空态，不抛错）。 */
export function loadAuthFile(path?: string): AuthFile {
  const authPath = path ?? getAuthPath();
  if (!existsSync(authPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(authPath, "utf8"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 原子写整个 auth 文件：同目录临时文件独占创建（wx）+ chmod 0o600 + rename 覆盖；
 * 任一步失败清理临时文件、不破坏原文件。
 */
export function saveAuthFile(data: AuthFile, path?: string): void {
  const authPath = path ?? getAuthPath();
  const dir = dirname(authPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const serialized = JSON.stringify(data, null, 2);
  const temp = join(dir, `.auth-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, serialized, { flag: "wx", mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, authPath);
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // 清理失败不覆盖原错误
    }
    throw error;
  }
}

// ── 凭据查询 ─────────────────────────────────────────────────────────────────

/**
 * 读取单个 provider 凭据：先查 flat（data[providerId]），再查历史格式的
 * 顶层嵌套（data.providers?.[providerId]）；非对象值不算凭据。
 */
export function getCredential(providerId: string, path?: string): AuthCredential | undefined {
  const data = loadAuthFile(path);
  const flat = data[providerId];
  if (isPlainObject(flat)) return flat as AuthCredential;
  const nested = data[NESTED_PROVIDERS_KEY];
  if (isPlainObject(nested)) {
    const inner = nested[providerId];
    if (isPlainObject(inner)) return inner as AuthCredential;
  }
  return undefined;
}

// ── 写入 ─────────────────────────────────────────────────────────────────────

/** 写入 API key 凭据（覆盖 flat 位置；读取先命中 flat，嵌套历史格式自然降级）。 */
export function setApiKey(providerId: string, key: string, path?: string): void {
  const data = loadAuthFile(path);
  data[providerId] = { type: "api_key", key: key.trim() };
  saveAuthFile(data, path);
}

/** 删除 provider 凭据（flat 与嵌套位置都删；嵌套清空后移除整个 providers 键）。 */
export function deleteCredential(providerId: string, path?: string): void {
  const data = loadAuthFile(path);
  delete data[providerId];
  const nested = data[NESTED_PROVIDERS_KEY];
  if (isPlainObject(nested) && nested[providerId] !== undefined) {
    delete nested[providerId];
    if (Object.keys(nested).length === 0) delete data[NESTED_PROVIDERS_KEY];
  }
  saveAuthFile(data, path);
}

/** 列出已存凭据的 provider id：跳过非对象顶层键与 providers 嵌套键本身，嵌套内 id 展开合并。 */
export function listCredentialProviders(path?: string): string[] {
  const data = loadAuthFile(path);
  const ids = new Set<string>();
  for (const [key, value] of Object.entries(data)) {
    if (key === NESTED_PROVIDERS_KEY) continue;
    if (isPlainObject(value)) ids.add(key);
  }
  const nested = data[NESTED_PROVIDERS_KEY];
  if (isPlainObject(nested)) {
    for (const [id, value] of Object.entries(nested)) {
      if (isPlainObject(value)) ids.add(id);
    }
  }
  return [...ids];
}

// ── ${ENV} 模板解析 ──────────────────────────────────────────────────────────

/**
 * ${VAR} 模板解析：非模板原样返回；模板缺值/空值返回 undefined（视为未配置）。
 * 仅接受形如 `${NAME}` 的完整模板（NAME 为标识符）。
 */
function resolveEnvTemplate(key: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(key.trim());
  if (!match) return key;
  const value = env[match[1]];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 是否含 oauth token 字段（兼容 loose Record 联合）。 */
function hasOauthTokens(credential: AuthCredential): boolean {
  return (
    ("access" in credential && typeof credential.access === "string") ||
    ("refresh" in credential && typeof credential.refresh === "string")
  );
}

/** 凭据对象是否满足「已配置」：api_key 有非空 key（支持 ${ENV} 模板）；oauth 有 access 或 refresh。 */
function credentialIsConfigured(credential: AuthCredential, env: NodeJS.ProcessEnv): boolean {
  if (credential.type === "api_key") {
    if (typeof credential.key !== "string" || credential.key.trim() === "") return false;
    return resolveEnvTemplate(credential.key, env) !== undefined;
  }
  if (credential.type === "oauth") {
    return hasOauthTokens(credential);
  }
  // 历史/未知格式：含 access 或 refresh 即视为已配置
  return hasOauthTokens(credential);
}

// ── 配置判断 ─────────────────────────────────────────────────────────────────

/** models.json providers[id].apiKey 是否为非空字符串（损坏/缺失一律 false）。 */
function modelsProviderHasApiKey(providerId: string, modelsPath: string): boolean {
  if (!existsSync(modelsPath)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(modelsPath, "utf8"));
  } catch {
    return false;
  }
  if (!isPlainObject(parsed)) return false;
  const providers = parsed.providers;
  if (!isPlainObject(providers)) return false;
  const entry = providers[providerId];
  if (!isPlainObject(entry)) return false;
  return typeof entry.apiKey === "string" && entry.apiKey.length > 0;
}

/**
 * provider 是否已配置：
 * - auth.json 有该 provider 且（api_key 有非空 key / oauth 有 access 或 refresh）
 * - 或 models.json providers[id].apiKey 为非空字符串
 */
export function isProviderConfigured(
  providerId: string,
  opts?: { authPath?: string; modelsPath?: string },
): boolean {
  const authPath = opts?.authPath ?? getAuthPath();
  const modelsPath = opts?.modelsPath ?? getModelsPath();
  const credential = getCredential(providerId, authPath);
  if (credential && credentialIsConfigured(credential, process.env)) return true;
  return modelsProviderHasApiKey(providerId, modelsPath);
}
