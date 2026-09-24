"use strict";

// Pidance PTY WebSocket upgrade 处理器（发布包自包含：不依赖 lib/ 源码树）。
// 守卫逻辑与 lib/request-guard.ts / lib/ui-session.ts 保持一致的精简内联版：
// - Host 白名单（DNS rebinding 防护）
// - 可选认证：PIDANCE_PASSWORD / PI_WEB_PASSWORD 启用时接受 UI 会话 Cookie（JWT）或 Basic
// - 兜底：未设置密码时仅放行回环请求（fail-closed）
// WebSocket 升级不做 CSRF 校验：部分手机浏览器 Origin / sec-fetch 不完整。

/* eslint-disable @typescript-eslint/no-require-imports */
const { existsSync } = require("fs");
const { homedir } = require("os");
const { createHash, createHmac, randomBytes, timingSafeEqual } = require("crypto");
const { isIP } = require("net");
const fs = require("fs");
const path = require("path");
const { tryLoadNodePty, completePtyUpgrade } = require("./pty-manager.cjs");

// ── Host 白名单（对齐 lib/request-guard.ts）──────────────────────────────

function normalizeHostname(hostname) {
  return (hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname)
    .toLowerCase()
    .replace(/\.$/, "");
}

function hostnameFromHostHeader(host) {
  if (!host || /[\s/@\\]/.test(host)) return null;
  try {
    const url = new URL(`http://${host}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return normalizeHostname(url.hostname);
  } catch {
    return null;
  }
}

function allowedHosts(env) {
  return [
    env.PI_WEB_HOSTNAME,
    ...(env.PI_WEB_ALLOWED_HOSTS ? String(env.PI_WEB_ALLOWED_HOSTS).split(",") : []),
  ]
    .filter((h) => typeof h === "string" && h.trim().length > 0)
    .map((h) => h.trim());
}

function isTrustedHost(hostHeader, env) {
  const hostname = hostHeader ? hostnameFromHostHeader(hostHeader) : null;
  if (!hostname) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost") || isIP(hostname) !== 0) return true;
  const names = allowedHosts(env)
    .map((h) => hostnameFromHostHeader(h))
    .filter((n) => n !== null);
  return names.includes(hostname);
}

function isLoopbackHost(hostHeader) {
  const hostname = hostHeader ? hostnameFromHostHeader(hostHeader) : null;
  if (!hostname) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  const ip = isIP(hostname);
  if (ip === 4) return hostname.startsWith("127.");
  if (ip === 6) return hostname === "::1" || hostname === "0:0:0:0:0:0:0:1";
  return false;
}

// ── 认证（对齐 lib/request-guard.ts + lib/ui-session.ts 精简版）────────────

const UI_SESSION_COOKIE_NAME = "pidance_ui_session";

function resolvePassword(env) {
  // 启动时密码已搬进同进程 globalThis 缓存（bin/pidance-auth-gate.js 的
  // primeAndScrubPassword），env 里不再有明文；两条来源同形，缺一不可。
  const cached = globalThis.__piAuthPassword;
  if (cached) return cached.value;
  const p =
    env && env.PIDANCE_PASSWORD && env.PIDANCE_PASSWORD.length > 0
      ? env.PIDANCE_PASSWORD
      : env && env.PI_WEB_PASSWORD;
  return typeof p === "string" && p.length > 0 ? p : null;
}

function passwordEnabled(env) {
  return resolvePassword(env) !== null;
}

function sha256(input) {
  return createHash("sha256").update(input, "utf8").digest();
}

function safeEqual(a, b) {
  return timingSafeEqual(sha256(a), sha256(b));
}

function checkBasicAuth(headers, env) {
  const password = resolvePassword(env);
  if (!passwordEnabled(env) || !password) return false;
  const auth = headers.authorization;
  if (!auth) return false;
  const match = /^Basic\s+(\S+)$/i.exec(auth);
  if (!match) return false;
  let decoded;
  try {
    const buf = Buffer.from(match[1], "base64");
    if (buf.toString("base64") !== match[1]) return false;
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx === -1) return false;
  return safeEqual(decoded.slice(0, idx), "pi") && safeEqual(decoded.slice(idx + 1), password);
}

function parseCookieValue(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const part of String(cookieHeader).split(";")) {
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

function defaultSecretFilePath() {
  const root = process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
  return path.join(root, "pidance-ui-jwt-secret");
}

function getOrCreateJwtSecret(env) {
  const fromEnv = env.PIDANCE_UI_JWT_SECRET || env.OPENCODE_JWT_SECRET;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv.trim();
  const filePath = defaultSecretFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, "utf8").trim();
      if (existing) return existing;
    }
  } catch {
    // 读失败则重建
  }
  const secret = randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, secret, { mode: 0o600 });
  } catch {
    // 无法落盘时仍返回内存密钥（进程内有效）
  }
  return secret;
}

function verifyUiSessionJwt(token, secret, nowMs) {
  if (!token || !secret) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [header, payload, sig] = parts;
  const data = `${header}.${payload}`;
  const expected = createHmac("sha256", secret).update(data).digest();
  let actual;
  try {
    actual = Buffer.from(sig, "base64url");
  } catch {
    return false;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try {
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (body.type !== "ui-session") return false;
    if (typeof body.exp !== "number" || body.exp * 1000 <= nowMs) return false;
    return true;
  } catch {
    return false;
  }
}

function checkUiSessionCookie(headers, env) {
  if (!passwordEnabled(env)) return false;
  const token = parseCookieValue(headers.cookie, UI_SESSION_COOKIE_NAME);
  if (!token) return false;
  return verifyUiSessionJwt(token, getOrCreateJwtSecret(env), Date.now());
}

function checkAuthenticated(headers, env) {
  return checkUiSessionCookie(headers, env) || checkBasicAuth(headers, env);
}

// ── upgrade 处理（原 lib/pty-ws.ts）─────────────────────────────────────

function header(req, name) {
  const value = req.headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

function ptyGuardHeaders(req) {
  const host = header(req, "host");
  const rawUrl = req.url || "/api/pty";
  const url = `http://${host || "127.0.0.1"}${rawUrl}`;
  let pathname = "/api/pty";
  try {
    pathname = new URL(url).pathname;
  } catch {
    // 用默认
  }
  return {
    host,
    origin: header(req, "origin"),
    secFetchSite: header(req, "sec-fetch-site"),
    secFetchMode: header(req, "sec-fetch-mode"),
    secFetchDest: header(req, "sec-fetch-dest"),
    secFetchUser: header(req, "sec-fetch-user"),
    authorization: header(req, "authorization"),
    cookie: header(req, "cookie"),
    xForwardedFor: header(req, "x-forwarded-for"),
    method: "GET",
    url,
    pathname,
  };
}

function reject(socket, status, message, extraHeaders) {
  const headers = {
    Connection: "close",
    "Content-Length": 0,
    ...(extraHeaders || {}),
  };
  const lines = Object.keys(headers).map((name) => `${name}: ${headers[name]}\r\n`).join("");
  try {
    socket.write(`HTTP/1.1 ${status} ${message}\r\n${lines}\r\n`);
  } catch {
    // ignore
  }
  try {
    socket.destroy();
  } catch {
    // ignore
  }
}

// ── 密码尝试限流（与 lib/auth-throttle.ts 同桶）──────────────────────────
//
// WebSocket 升级不经过 Next middleware，所以这里必须自己挡一次：否则 /api/pty
// 就是一条不限速的密码预言机（Basic 可全速猜）。状态放在与 lib/auth-throttle.ts
// 相同的 globalThis 键、相同结构上，两条入口在同进程里共用同一个桶。
//
// bin/ 是自包含发布物（见文件头注释，不依赖 lib/ 源码树），所以退避公式与常量
// 在内联实现里保持语义一致；bin/pty-ws.test.mjs 有一条与 lib/auth-throttle.ts
// 的 parity 断言，改一边不改另一边会红。

const AUTH_THROTTLE_GLOBAL_KEY = "__piAuthThrottle";
const AUTH_THROTTLE_BASE_DELAY_MS = 1000;
const AUTH_THROTTLE_MAX_DELAY_MS = 60000;
const AUTH_THROTTLE_RESET_AFTER_MS = 5 * 60 * 1000;
const AUTH_THROTTLE_MAX_BUCKETS = 256;

function authThrottleStore() {
  if (!globalThis[AUTH_THROTTLE_GLOBAL_KEY]) globalThis[AUTH_THROTTLE_GLOBAL_KEY] = new Map();
  return globalThis[AUTH_THROTTLE_GLOBAL_KEY];
}

function backoffDelayMs(failures) {
  if (failures <= 0) return 0;
  const exponent = Math.min(failures - 1, 31);
  return Math.min(AUTH_THROTTLE_BASE_DELAY_MS * 2 ** exponent, AUTH_THROTTLE_MAX_DELAY_MS);
}

function expireIfStale(state, now) {
  if (state.failures > 0 && now - state.lastFailureAt >= AUTH_THROTTLE_RESET_AFTER_MS) {
    state.failures = 0;
    state.lastFailureAt = 0;
    state.blockedUntil = 0;
  }
}

/** 该桶还需等多久（毫秒）；0 表示可以尝试。 */
function getAuthRetryAfterMs(key, now = Date.now()) {
  const state = authThrottleStore().get(key);
  if (!state) return 0;
  expireIfStale(state, now);
  return Math.max(0, state.blockedUntil - now);
}

function pruneAuthThrottle(now) {
  const map = authThrottleStore();
  if (map.size <= AUTH_THROTTLE_MAX_BUCKETS) return;
  for (const [key, state] of map) {
    if (state.failures === 0 || now - state.lastFailureAt >= AUTH_THROTTLE_RESET_AFTER_MS) map.delete(key);
  }
  while (map.size > AUTH_THROTTLE_MAX_BUCKETS) {
    const oldest = [...map.entries()].sort((a, b) => a[1].lastFailureAt - b[1].lastFailureAt)[0];
    if (!oldest) break;
    map.delete(oldest[0]);
  }
}

/** 记一次失败并返回施加的退避（毫秒）。 */
function recordAuthFailure(key, now = Date.now()) {
  const map = authThrottleStore();
  let state = map.get(key);
  if (!state) {
    state = { failures: 0, lastFailureAt: 0, blockedUntil: 0 };
    map.set(key, state);
  }
  expireIfStale(state, now);
  state.failures += 1;
  state.lastFailureAt = now;
  state.blockedUntil = now + backoffDelayMs(state.failures);
  pruneAuthThrottle(now);
  return backoffDelayMs(state.failures);
}

/**
 * 限流分桶的身份，与 lib/request-guard.ts 的 `authIdentity` 同规则：
 * 只在显式 `PIDANCE_TRUST_PROXY` 时信 `x-forwarded-for`，否则用对端地址；
 * 都拿不到时退回固定全局桶（宁可误伤也不放行）。
 */
function authThrottleKey(socket, headers, env) {
  const trustProxy = env.PIDANCE_TRUST_PROXY === "1" || env.PIDANCE_TRUST_PROXY === "true";
  if (trustProxy) {
    const first = (headers.xForwardedFor || "").split(",")[0];
    const trimmed = first ? first.trim() : "";
    if (trimmed) return trimmed.replace(/^::ffff:/, "");
  }
  const peer = typeof socket?.remoteAddress === "string" ? socket.remoteAddress.trim() : "";
  if (peer) return peer.replace(/^::ffff:/, "");
  return "unknown";
}

function retryAfterSeconds(retryAfterMs) {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

async function handlePtyUpgrade(req, socket, head) {
  if (!tryLoadNodePty()) {
    reject(socket, 503, "PTY Unavailable");
    return;
  }
  const guardHeaders = ptyGuardHeaders(req);
  if (!guardHeaders.pathname.startsWith("/api/pty")) {
    reject(socket, 404, "Not Found");
    return;
  }
  // WebSocket 升级：部分手机浏览器 Origin / sec-fetch 不完整，CSRF 会误杀。
  // 仍校验 Host 白名单和登录（Cookie / Basic）。
  if (!isTrustedHost(guardHeaders.host, process.env)) {
    reject(socket, 403, "untrusted-host");
    return;
  }
  if (passwordEnabled(process.env)) {
    // 与 middleware / 登录表单共用同一个桶：封锁期内密码正确也不放行，
    // 否则升级路径就是一条不限速的密码预言机。
    const throttleKey = authThrottleKey(socket, guardHeaders, process.env);
    const retryAfterMs = getAuthRetryAfterMs(throttleKey);
    if (retryAfterMs > 0) {
      reject(socket, 429, "Too Many Requests", { "Retry-After": retryAfterSeconds(retryAfterMs) });
      return;
    }
    if (!checkAuthenticated(guardHeaders, process.env)) {
      recordAuthFailure(throttleKey);
      reject(socket, 401, "auth-required");
      return;
    }
    // 成功不回退计数：Basic 每个请求都带，复位会让穿插猜测回到基准延迟。
  } else if (!isLoopbackHost(guardHeaders.host)) {
    // fail-closed 兜底：未设密码时仅放行回环请求（与 middleware 一致）。
    reject(socket, 401, "auth-required");
    return;
  }
  const cwd = homedir();
  if (!existsSync(cwd)) {
    reject(socket, 500, "home not found");
    return;
  }
  completePtyUpgrade(req, socket, head, cwd);
}

module.exports = {
  handlePtyUpgrade,
  ptyGuardHeaders,
  // 导出限流内联实现：bin/pty-ws.test.mjs 用它断言与 lib/auth-throttle.ts 的
  // 退避公式一致、且两条入口共用同一个桶。
  authThrottleKey,
  backoffDelayMs,
  getAuthRetryAfterMs,
  recordAuthFailure,
};
