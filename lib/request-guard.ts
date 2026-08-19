/**
 * 请求安全守卫（对齐上游 pi-web 0.8.6 middleware）：
 * - Host 白名单：仅 localhost / *.localhost / IP / PI_WEB_HOSTNAME / PI_WEB_ALLOWED_HOSTS
 *   （防 DNS rebinding）
 * - CSRF：API 请求校验 origin/sec-fetch-site（cross-site 拒绝、origin 须与 Host 同源；
 *   会话导出的 navigate GET 豁免；无跨站信号的非浏览器客户端放行）
 * - 可选认证：设置 PIDANCE_PASSWORD（优先，兼容旧变量 PI_WEB_PASSWORD）即启用；
 *   未设 env 密码时回退 ~/.pi/agent/pidance-server.json 中保存的 scrypt 密码哈希
 *   （设置 → 通用 中配置；见 lib/pidance-server-config.ts）
 *   （#18）UI 会话 Cookie（pidance_ui_session JWT）或 Basic Auth（用户名固定 "pi"）
 * - 兜底认证：未设置密码时仅放行回环（loopback）请求；非回环请求一律 auth-required，
 *   防止服务误绑 0.0.0.0 时局域网/公网匿名调用（P0 fail-closed，即使 CLI 门禁被绕过）
 * 纯逻辑（env 注入），供 middleware.ts 组装与 .test.mjs 测试。
 */
import { createHash, timingSafeEqual } from "crypto";
import { isIP } from "net";
import {
  getOrCreateJwtSecret,
  hasUiSessionDevice,
  parseCookieValue,
  readUiSessionJwt,
  UI_SESSION_COOKIE_NAME,
} from "./ui-session";
import {
  passwordHashConfigured,
  verifyConfigPassword,
  type ServerConfig,
} from "./pidance-server-config";

export const EXPORT_NAVIGATE_RE = /^\/api\/sessions\/[^/]+\/export$/;
/** 未登录也可访问的 API（登录/会话状态）。 */
export const PUBLIC_AUTH_API_RE = /^\/api\/auth\/ui-session\/?$/;

export type RequestGuardHeaders = {
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
  secFetchMode: string | null;
  secFetchDest: string | null;
  secFetchUser: string | null;
  authorization: string | null;
  cookie: string | null;
  method: string;
  url: string;
  pathname: string;
};

/** 对齐上游：IPv6 去括号、小写、去尾点。 */
function normalizeHostname(hostname: string): string {
  return (hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname)
    .toLowerCase()
    .replace(/\.$/, "");
}

export function hostnameFromHostHeader(host: string): string | null {
  if (!host || /[\s/@\\]/.test(host)) return null;
  try {
    const url = new URL(`http://${host}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return normalizeHostname(url.hostname);
  } catch {
    return null;
  }
}

export function allowedHosts(env: Record<string, string | undefined>): string[] {
  return [
    env.PI_WEB_HOSTNAME,
    ...(env.PI_WEB_ALLOWED_HOSTS?.split(",") ?? []),
  ]
    .filter((h): h is string => typeof h === "string" && h.trim().length > 0)
    .map((h) => h.trim());
}

/** Host 白名单校验（DNS rebinding 防护）。 */
export function isTrustedHost(hostHeader: string | null, env: Record<string, string | undefined>): boolean {
  const hostname = hostHeader ? hostnameFromHostHeader(hostHeader) : null;
  if (!hostname) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost") || isIP(hostname) !== 0) return true;
  const names = allowedHosts(env).map((h) => hostnameFromHostHeader(h)).filter((n): n is string => n !== null);
  return names.includes(hostname);
}

function isExportNavigate(req: RequestGuardHeaders): boolean {
  if (req.method !== "GET") return false;
  if (req.secFetchMode !== "navigate") return false;
  if (req.secFetchDest !== "document") return false;
  if (req.secFetchUser !== "?1") return false;
  return EXPORT_NAVIGATE_RE.test(req.pathname);
}

/** origin 与 Host 是否同源。 */
export function isSameOrigin(req: RequestGuardHeaders): boolean {
  if (!req.origin || !req.host) return false;
  try {
    const base = new URL(req.url);
    return new URL(req.origin).origin === new URL(`${base.protocol}//${req.host}`).origin;
  } catch {
    return false;
  }
}

/** CSRF 防护：无跨站信号放行；cross-site 拒绝；origin 存在则须同源。 */
export function checkCsrf(req: RequestGuardHeaders): boolean {
  if (isExportNavigate(req)) return true;
  const hasCrossSiteSignal = req.origin !== null || req.secFetchSite !== null;
  if (!hasCrossSiteSignal) return true;
  if (req.secFetchSite === "cross-site") return false;
  if (!req.origin) return true;
  return isSameOrigin(req);
}

/** 请求 Host 是否为回环（localhost / *.localhost / IPv4 127.x / IPv6 ::1）。 */
export function isLoopbackHost(hostHeader: string | null): boolean {
  const hostname = hostHeader ? hostnameFromHostHeader(hostHeader) : null;
  if (!hostname) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  const ip = isIP(hostname);
  if (ip === 4) return hostname.startsWith("127.");
  if (ip === 6) return hostname === "::1" || hostname === "0:0:0:0:0:0:0:1";
  return false;
}

/**
 * 解析认证密码：PIDANCE_PASSWORD 优先（产品名，空/缺失时回退），兼容旧变量 PI_WEB_PASSWORD；
 * 最终值为空串或缺失视为未设置。
 */
export function resolvePassword(env: Record<string, string | undefined>): string | null {
  const p =
    env.PIDANCE_PASSWORD && env.PIDANCE_PASSWORD.length > 0
      ? env.PIDANCE_PASSWORD
      : env.PI_WEB_PASSWORD;
  return typeof p === "string" && p.length > 0 ? p : null;
}

export function passwordEnabled(
  env: Record<string, string | undefined>,
  config?: ServerConfig | null,
): boolean {
  return resolvePassword(env) !== null || passwordHashConfigured(config);
}

function sha256(input: string): Buffer {
  return createHash("sha256").update(input, "utf8").digest();
}

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

/** Basic Auth 校验：Authorization: Basic base64("pi:<password>")。env 密码优先，回退配置哈希。 */
export function checkBasicAuth(
  req: RequestGuardHeaders,
  env: Record<string, string | undefined>,
  config?: ServerConfig | null,
): boolean {
  const envPassword = resolvePassword(env);
  const storedHash = config?.passwordHash ?? null;
  if (!envPassword && !storedHash) return false;
  const auth = req.authorization;
  if (!auth) return false;
  const match = /^Basic\s+(\S+)$/i.exec(auth);
  if (!match) return false;
  let decoded: string;
  try {
    const buf = Buffer.from(match[1], "base64");
    if (buf.toString("base64") !== match[1]) return false;
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx === -1) return false;
  if (!safeEqual(decoded.slice(0, idx), "pi")) return false;
  const candidate = decoded.slice(idx + 1);
  return envPassword ? safeEqual(candidate, envPassword) : verifyConfigPassword(candidate, storedHash!);
}

/** 设备注册表查询接口（middleware 用默认实现读文件；测试可注入内存实现）。 */
export type UiSessionDeviceStore = { has: (id: string) => boolean };

/**
 * UI 会话 Cookie 校验（#18 + 设备管理）。jwtSecret / deviceStore 可注入以便测试。
 * 带 jti 的新会话必须仍在设备注册表中（删除设备即失效）；无 jti 的旧会话仅验签兼容放行。
 */
export function checkUiSessionCookie(
  req: RequestGuardHeaders,
  env: Record<string, string | undefined>,
  jwtSecret?: string,
  config?: ServerConfig | null,
  deviceStore?: UiSessionDeviceStore | null,
): boolean {
  if (!passwordEnabled(env, config)) return false;
  const token = parseCookieValue(req.cookie, UI_SESSION_COOKIE_NAME);
  if (!token) return false;
  const secret = jwtSecret ?? getOrCreateJwtSecret(env);
  const { valid, jti } = readUiSessionJwt(token, secret);
  if (!valid) return false;
  if (!jti) return true;
  if (deviceStore === null) return true; // 显式跳过设备校验（内部/测试）
  const store = deviceStore ?? { has: (id) => hasUiSessionDevice(id) };
  return store.has(jti);
}

/** Cookie 会话或 Basic 任一通过即认证成功。 */
export function checkAuthenticated(
  req: RequestGuardHeaders,
  env: Record<string, string | undefined>,
  jwtSecret?: string,
  config?: ServerConfig | null,
  deviceStore?: UiSessionDeviceStore | null,
): boolean {
  return (
    checkUiSessionCookie(req, env, jwtSecret, config, deviceStore)
    || checkBasicAuth(req, env, config)
  );
}

export function isPublicAuthApi(pathname: string): boolean {
  return PUBLIC_AUTH_API_RE.test(pathname);
}

export type GuardVerdict = "ok" | "untrusted-host" | "csrf" | "auth-required";

/** 完整判定（middleware 用；isApi 区分错误形态）。 */
export function guardRequest(
  req: RequestGuardHeaders,
  env: Record<string, string | undefined>,
  options?: { jwtSecret?: string; config?: ServerConfig | null; deviceStore?: UiSessionDeviceStore | null },
): GuardVerdict {
  if (!isTrustedHost(req.host, env)) return "untrusted-host";
  const isApi = req.pathname === "/api" || req.pathname.startsWith("/api/");
  if (isApi && !isPublicAuthApi(req.pathname)) {
    if (!checkCsrf(req)) return "csrf";
  }
  // 登录/会话状态 API 在已设密码时也放行（由路由自身校验密码）。
  if (isPublicAuthApi(req.pathname)) {
    if (isApi && !checkCsrf(req) && req.method !== "GET") {
      // POST 登录仍须 CSRF（同源）；GET 状态可无 Origin（curl）
      if (req.method !== "GET") return "csrf";
    }
    return "ok";
  }
  if (passwordEnabled(env, options?.config)) {
    if (!checkAuthenticated(req, env, options?.jwtSecret, options?.config, options?.deviceStore)) {
      return "auth-required";
    }
  } else if (!isLoopbackHost(req.host)) {
    // fail-closed 兜底：未设置密码时仅放行回环请求；非回环请求一律要求认证，
    // 即使 CLI 启动门禁被绕过（如直接 next start -H 0.0.0.0）也保护 Agent API。
    return "auth-required";
  }
  return "ok";
}
