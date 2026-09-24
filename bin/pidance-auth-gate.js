"use strict";

// 启动认证门禁纯逻辑（CLI 门禁用；与 lib/request-guard.ts 的 isLoopbackHost 语义保持一致）：
// 监听非回环地址且未设置认证密码 → 拒绝启动（fail-closed，发布阻断 P0）。
// 密码来源：启动缓存（已搬走）→ PIDANCE_PASSWORD（产品名）→ 旧变量 PI_WEB_PASSWORD。

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isIP } = require("net");

/**
 * 进程内密码缓存键，与 lib/request-guard.ts 的 __piAuthPassword 同形。
 *
 * 同进程共享：middleware / route / CLI 共用 globalThis（Next 的 Node middleware 是
 * require 进同进程的），所以 CLI 写、服务端读。
 */
const AUTH_PASSWORD_CACHE_KEY = "__piAuthPassword";

function readPasswordFromEnv(env) {
  const p =
    env && env.PIDANCE_PASSWORD && env.PIDANCE_PASSWORD.length > 0
      ? env.PIDANCE_PASSWORD
      : env && env.PI_WEB_PASSWORD;
  return typeof p === "string" && p.length > 0 ? p : null;
}

/** 解析认证密码：启动缓存优先，否则读 env。 */
function resolvePassword(env) {
  const cached = globalThis[AUTH_PASSWORD_CACHE_KEY];
  if (cached) return cached.value;
  return readPasswordFromEnv(env);
}

/**
 * 把 env 里的密码搬进进程内缓存，并从 process.env 删掉两个变量名。
 *
 * 为什么必须搬：主 agent 的 SDK bash 工具用 `{ ...process.env }` 构造命令环境，
 * 密码留在 env 里会被 agent 一条 `env` 打进会话并永久落盘。删掉后命令环境拿不到，
 * 认证改读缓存（只删不搬会让 resolvePassword fail-open）。
 * 缓存不写盘。
 */
function primeAndScrubPassword(env = process.env) {
  const value = readPasswordFromEnv(env);
  globalThis[AUTH_PASSWORD_CACHE_KEY] = { value };
  delete env.PIDANCE_PASSWORD;
  delete env.PI_WEB_PASSWORD;
  return value;
}

/** host 是否为回环（localhost / *.localhost / IPv4 127.x / IPv6 ::1）。 */
function isLoopbackHost(host) {
  if (typeof host !== "string" || host.length === 0) return false; // 未指定 → Pidance 默认绑定 127.0.0.1
  let hostname = host.toLowerCase().replace(/\.$/, "");
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  const ip = isIP(hostname);
  if (ip === 4) return hostname.startsWith("127.");
  if (ip === 6) return hostname === "::1" || hostname === "0:0:0:0:0:0:0:1";
  return false;
}

/**
 * 是否需要强制认证：非回环监听地址 + 未设置密码（env 明文或设置 → 通用 保存的服务端密码）。
 * serverConfig 来自 bin/pidance-server-config.js 的 { passwordSet, remoteEnabled } 投影。
 */
function shouldRequireAuth(host, password, serverConfig) {
  const hasPassword =
    (typeof password === "string" && password.length > 0) ||
    Boolean(serverConfig && serverConfig.passwordSet);
  return !isLoopbackHost(host) && !hasPassword;
}

/** 人类可读的监听地址描述（拒绝启动报错用）。 */
function describeHost(host) {
  return typeof host === "string" && host.length > 0 ? host : "127.0.0.1（默认本机绑定）";
}

module.exports = { isLoopbackHost, resolvePassword, primeAndScrubPassword, shouldRequireAuth, describeHost };
