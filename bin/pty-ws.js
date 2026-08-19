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
    method: "GET",
    url,
    pathname,
  };
}

function reject(socket, status, message) {
  try {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    // ignore
  }
  try {
    socket.destroy();
  } catch {
    // ignore
  }
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
    if (!checkAuthenticated(guardHeaders, process.env)) {
      reject(socket, 401, "auth-required");
      return;
    }
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

module.exports = { handlePtyUpgrade, ptyGuardHeaders };
