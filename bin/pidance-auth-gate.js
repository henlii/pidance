"use strict";

// 启动认证门禁纯逻辑（CLI 门禁用；与 lib/request-guard.ts 的 isLoopbackHost 语义保持一致）：
// 监听非回环地址且未设置认证密码 → 拒绝启动（fail-closed，发布阻断 P0）。
// 密码来源：PIDANCE_PASSWORD 优先（产品名），兼容回退旧变量 PI_WEB_PASSWORD。

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isIP } = require("net");

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

/** 解析认证密码：PIDANCE_PASSWORD 优先（产品名，空/缺失时回退），兼容旧变量 PI_WEB_PASSWORD。 */
function resolvePassword(env) {
  const p =
    env && env.PIDANCE_PASSWORD && env.PIDANCE_PASSWORD.length > 0
      ? env.PIDANCE_PASSWORD
      : env && env.PI_WEB_PASSWORD;
  return typeof p === "string" && p.length > 0 ? p : null;
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

module.exports = { isLoopbackHost, resolvePassword, shouldRequireAuth, describeHost };
