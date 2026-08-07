/**
 * Pidance UI 会话（对齐 OpenChamber ui-auth 语义，#18）：
 * - Cookie：pidance_ui_session，HttpOnly + SameSite=Strict + Secure(HTTPS)
 * - JWT HS256（node:crypto，无 jose 依赖）
 * - TTL：12h 默认 / 7d trustDevice
 * - 密钥落盘：~/.pi/agent/pidance-ui-jwt-secret（或 PIDANCE_UI_JWT_SECRET / OPENCODE_JWT_SECRET）
 */
import { createHmac, createHash, randomBytes, timingSafeEqual, scryptSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export const UI_SESSION_COOKIE_NAME = "pidance_ui_session";
export const UI_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const UI_TRUSTED_DEVICE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const UI_LOGIN_RATE_WINDOW_MS = 5 * 60 * 1000;
export const UI_LOGIN_RATE_MAX = 10;
export const UI_LOGIN_RATE_LOCKOUT_MS = 15 * 60 * 1000;

const SECRET_FILE_NAME = "pidance-ui-jwt-secret";

export type UiSessionTtlKind = "default" | "trusted";

export function resolveSessionTtlMs(trustDevice: boolean): number {
  return trustDevice ? UI_TRUSTED_DEVICE_TTL_MS : UI_SESSION_TTL_MS;
}

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

function b64urlJson(value: unknown): string {
  return b64url(JSON.stringify(value));
}

/** 解析 Cookie 头中的指定名（值已 decodeURIComponent）。 */
export function parseCookieValue(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    if (key !== name) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export function buildSetCookieHeader(options: {
  name: string;
  value: string;
  maxAgeSeconds: number;
  secure: boolean;
}): string {
  const { name, value, maxAgeSeconds, secure } = options;
  const maxAge = Math.max(0, Math.floor(maxAgeSeconds));
  const expires = maxAge === 0
    ? "Thu, 01 Jan 1970 00:00:00 GMT"
    : new Date(Date.now() + maxAge * 1000).toUTCString();
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
    `Expires=${expires}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function isSecureRequest(url: string, forwardedProto: string | null): boolean {
  if (forwardedProto) {
    const first = forwardedProto.split(",")[0]?.trim().toLowerCase();
    if (first === "https") return true;
    if (first === "http") return false;
  }
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export function defaultSecretFilePath(agentDir?: string): string {
  const root = agentDir
    ?? process.env.PI_CODING_AGENT_DIR
    ?? path.join(homedir(), ".pi", "agent");
  return path.join(root, SECRET_FILE_NAME);
}

export type SecretStore = {
  readFileSync: (p: string, enc: "utf8") => string;
  writeFileSync: (p: string, data: string, opts: { mode: number }) => void;
  mkdirSync: (p: string, opts: { recursive: boolean }) => void;
  existsSync: (p: string) => boolean;
};

const defaultFs: SecretStore = {
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
  writeFileSync: (p, data, opts) => fs.writeFileSync(p, data, opts),
  mkdirSync: (p, opts) => { fs.mkdirSync(p, opts); },
  existsSync: (p) => fs.existsSync(p),
};

/** 读取或创建 HMAC 密钥（hex）。env 优先：PIDANCE_UI_JWT_SECRET → OPENCODE_JWT_SECRET。 */
export function getOrCreateJwtSecret(
  env: Record<string, string | undefined> = process.env,
  filePath = defaultSecretFilePath(),
  store: SecretStore = defaultFs,
): string {
  const fromEnv = env.PIDANCE_UI_JWT_SECRET || env.OPENCODE_JWT_SECRET;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv.trim();

  try {
    if (store.existsSync(filePath)) {
      const existing = store.readFileSync(filePath, "utf8").trim();
      if (existing) return existing;
    }
  } catch {
    // 读失败则重建
  }

  const secret = randomBytes(32).toString("hex");
  try {
    store.mkdirSync(path.dirname(filePath), { recursive: true });
    store.writeFileSync(filePath, secret, { mode: 0o600 });
  } catch {
    // 无法落盘时仍返回内存密钥（进程内有效）
  }
  return secret;
}

/** 轮换密钥（强制全局登出）。env 固定密钥时抛错。 */
export function rotateJwtSecret(
  env: Record<string, string | undefined> = process.env,
  filePath = defaultSecretFilePath(),
  store: SecretStore = defaultFs,
): string {
  if (env.PIDANCE_UI_JWT_SECRET || env.OPENCODE_JWT_SECRET) {
    throw new Error("Cannot rotate secret while PIDANCE_UI_JWT_SECRET/OPENCODE_JWT_SECRET is set");
  }
  const secret = randomBytes(32).toString("hex");
  store.mkdirSync(path.dirname(filePath), { recursive: true });
  store.writeFileSync(filePath, secret, { mode: 0o600 });
  return secret;
}

export function signUiSessionJwt(secret: string, ttlMs: number, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + Math.max(1, Math.floor(ttlMs / 1000));
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const payload = b64urlJson({ type: "ui-session", iat, exp });
  const data = `${header}.${payload}`;
  const sig = createHmac("sha256", secret).update(data).digest();
  return `${data}.${b64url(sig)}`;
}

export function verifyUiSessionJwt(token: string, secret: string, nowMs = Date.now()): boolean {
  if (!token || !secret) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [header, payload, sig] = parts;
  const data = `${header}.${payload}`;
  const expected = createHmac("sha256", secret).update(data).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(sig, "base64url");
  } catch {
    return false;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try {
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      type?: string;
      exp?: number;
    };
    if (body.type !== "ui-session") return false;
    if (typeof body.exp !== "number" || body.exp * 1000 <= nowMs) return false;
    return true;
  } catch {
    return false;
  }
}

export function verifyPassword(candidate: string, expected: string): boolean {
  if (!candidate || !expected) return false;
  const a = createHash("sha256").update(candidate.normalize().trim(), "utf8").digest();
  const b = createHash("sha256").update(expected.normalize().trim(), "utf8").digest();
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 可选：scrypt 绑盐校验（登录 API 内对 env 明文密码仍用 verifyPassword）。 */
export function hashPasswordScrypt(password: string, salt: Buffer): Buffer {
  return scryptSync(password.normalize().trim(), salt, 64);
}

// —— 登录限流（进程内；对齐 OC 量级）——

type RateEntry = { fails: number; windowStart: number; lockedUntil: number };

const loginRateMap = new Map<string, RateEntry>();

export function resetLoginRateLimitForTests(): void {
  loginRateMap.clear();
}

export function checkLoginRateLimit(key: string, nowMs = Date.now()): {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  limit: number;
} {
  const limit = UI_LOGIN_RATE_MAX;
  const entry = loginRateMap.get(key);
  if (!entry) {
    return { allowed: true, remaining: limit, retryAfterSeconds: 0, limit };
  }
  if (entry.lockedUntil > nowMs) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.ceil((entry.lockedUntil - nowMs) / 1000),
      limit,
    };
  }
  if (nowMs - entry.windowStart > UI_LOGIN_RATE_WINDOW_MS) {
    loginRateMap.delete(key);
    return { allowed: true, remaining: limit, retryAfterSeconds: 0, limit };
  }
  const remaining = Math.max(0, limit - entry.fails);
  return { allowed: remaining > 0, remaining, retryAfterSeconds: 0, limit };
}

export function recordLoginFailure(key: string, nowMs = Date.now()): void {
  let entry = loginRateMap.get(key);
  if (!entry || nowMs - entry.windowStart > UI_LOGIN_RATE_WINDOW_MS) {
    entry = { fails: 0, windowStart: nowMs, lockedUntil: 0 };
  }
  entry.fails += 1;
  if (entry.fails >= UI_LOGIN_RATE_MAX) {
    entry.lockedUntil = nowMs + UI_LOGIN_RATE_LOCKOUT_MS;
  }
  loginRateMap.set(key, entry);
}

export function clearLoginFailures(key: string): void {
  loginRateMap.delete(key);
}

export function clientIpFromHeaders(headers: {
  "x-forwarded-for"?: string | null;
  "x-real-ip"?: string | null;
}): string {
  const fwd = headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) {
    return fwd.split(",")[0]!.trim().replace(/^::ffff:/, "");
  }
  const real = headers["x-real-ip"];
  if (typeof real === "string" && real.trim()) return real.trim().replace(/^::ffff:/, "");
  return "unknown";
}
