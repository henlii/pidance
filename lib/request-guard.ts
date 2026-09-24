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
  getAuthRetryAfterMs,
  recordAuthFailure,
} from "./auth-throttle";
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
  /** 自管 HTTP server 注入的对端地址（客户端自带的同名头已被覆盖）。 */
  peerAddress: string | null;
  xForwardedFor: string | null;
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
 * 进程内密码缓存。
 *
 * 为什么需要：SDK 的 bash 工具用 `{ ...process.env }` 构造命令环境
 * （pi-coding-agent dist/utils/shell.js 的 getShellEnv），env 里的登录密码会被 agent
 * 一条 `env` 打进对话并永久落盘。启动时把密码从环境变量搬进缓存、再从 process.env
 * 删掉两个变量名后，命令环境自然拿不到；`resolvePassword` 改读缓存，认证不受影响
 * （不能只删环境变量：resolvePassword 是每次现读，删了就 fail-open）。
 *
 * 放 globalThis 而不是模块作用域：middleware / route / instrumentation 各自是独立的
 * bundle，各有自己的模块实例；Next 的 Node middleware 是 require 进同进程的
 * （next-server.js 的 loadNodeMiddleware），所以 globalThis 在同进程内可靠共享。
 * 缓存不写盘、不出进程。
 */
declare global {
  var __piAuthPassword: { value: string | null } | undefined;
}

/** 把 env 里的密码写进缓存（不删环境变量；删除由启动方负责）。 */
export function primeAuthPassword(env: Record<string, string | undefined>): string | null {
  const value = readPasswordFromEnv(env);
  globalThis.__piAuthPassword = { value };
  return value;
}

/** 清掉缓存（测试与诊断用）。清掉后 resolvePassword 回退读 env。 */
export function clearAuthPasswordCache(): void {
  globalThis.__piAuthPassword = undefined;
}

function readPasswordFromEnv(env: Record<string, string | undefined>): string | null {
  const p =
    env.PIDANCE_PASSWORD && env.PIDANCE_PASSWORD.length > 0
      ? env.PIDANCE_PASSWORD
      : env.PI_WEB_PASSWORD;
  return typeof p === "string" && p.length > 0 ? p : null;
}

/**
 * 解析认证密码：启动缓存优先（进程内已搬走的密码）；未搬过则读
 * PIDANCE_PASSWORD（优先，产品名）→ PI_WEB_PASSWORD（兼容旧变量）。
 * 空串与缺失一律视为未设置。
 */
export function resolvePassword(env: Record<string, string | undefined>): string | null {
  const cached = globalThis.__piAuthPassword;
  if (cached) return cached.value;
  return readPasswordFromEnv(env);
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

/**
 * 限流分桶的桶名：显式开启 `PIDANCE_TRUST_PROXY` 时用 `x-forwarded-for` 首段，
 * 否则用自管 server 注入的对端地址；两者都没有就退回固定全局桶（宁可误伤也不放行）。
 */
/** authIdentity 只看这两个头；RequestGuardHeaders 结构上兼容。 */
export type AuthIdentityHeaders = {
  peerAddress: string | null;
  xForwardedFor: string | null;
};

export function authIdentity(
  req: AuthIdentityHeaders,
  env: Record<string, string | undefined>,
): string {
  const trustProxy = env.PIDANCE_TRUST_PROXY === "1" || env.PIDANCE_TRUST_PROXY === "true";
  if (trustProxy) {
    const first = req.xForwardedFor?.split(",")[0]?.trim();
    if (first) return first.replace(/^::ffff:/, "");
  }
  const peer = req.peerAddress?.trim();
  if (peer) return peer.replace(/^::ffff:/, "");
  return "unknown";
}

function isBasicAuthorizationHeader(authorization: string | null): boolean {
  return typeof authorization === "string" && /^Basic\s/i.test(authorization);
}

/**
 * 把带 Basic 头的请求算作一次密码尝试，与登录表单共用同一个桶：
 * - 正在封锁：即便密码是对的也返回 throttled（否则响应就是密码预言机），由
 *   middleware 回 429 + Retry-After。
 * - 密码错：记一次失败并返回 auth-required。
 * - 密码对：放行，**不复位**计数（Basic 客户端每个请求都带凭据，复位会把
 *   穿插猜测者拉回基准延迟）。
 */
function assessBasicAttempt(
  req: RequestGuardHeaders,
  env: Record<string, string | undefined>,
  options?: { config?: ServerConfig | null; now?: number },
): GuardVerdict | null {
  if (!isBasicAuthorizationHeader(req.authorization)) return null;
  const now = options?.now ?? Date.now();
  const key = authIdentity(req, env);
  if (getAuthRetryAfterMs(key, now) > 0) return "throttled";
  if (checkBasicAuth(req, env, options?.config)) return null;
  recordAuthFailure(key, now);
  return "auth-required";
}

export type GuardVerdict = "ok" | "untrusted-host" | "csrf" | "auth-required" | "throttled";

/** 完整判定（middleware 用；isApi 区分错误形态）。 */
export function guardRequest(
  req: RequestGuardHeaders,
  env: Record<string, string | undefined>,
  options?: {
    jwtSecret?: string;
    config?: ServerConfig | null;
    deviceStore?: UiSessionDeviceStore | null;
    /** 判定时的时间戳；与 middleware 读 Retry-After 共用同一个值，避免两次数值不一致。 */
    now?: number;
  },
): GuardVerdict {
  if (!isTrustedHost(req.host, env)) return "untrusted-host";
  const isApi = req.pathname === "/api" || req.pathname.startsWith("/api/");
  if (isApi && !isPublicAuthApi(req.pathname)) {
    if (!checkCsrf(req)) return "csrf";
  }
  // 限流判定必须在公开认证 API 豁免**之前**：否则登录/状态端点就是一条不限速的
  // 密码猜测通道。只在带 Basic 头时才算尝试；带合法会话 Cookie 的请求不受封锁影响
  // （只在这一分支里验 Cookie，普通请求不多付一次验签/读盘）。
  if (passwordEnabled(env, options?.config) && isBasicAuthorizationHeader(req.authorization)) {
    const authenticatedByCookie = checkUiSessionCookie(
      req, env, options?.jwtSecret, options?.config, options?.deviceStore,
    );
    if (!authenticatedByCookie) {
      const throttled = assessBasicAttempt(req, env, options);
      if (throttled) return throttled;
    }
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
