import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import {
  authIdentity,
  passwordEnabled,
  resolvePassword,
  type AuthIdentityHeaders,
} from "@/lib/request-guard";
import { readServerConfig, verifyConfigPassword } from "@/lib/pidance-server-config";
import {
  getAuthRetryAfterMs,
  recordAuthFailure,
  recordAuthSuccess,
  retryAfterSeconds,
} from "@/lib/auth-throttle";
import {
  buildSetCookieHeader,
  deviceLabelFromUserAgent,
  getOrCreateJwtSecret,
  isSecureRequest,
  isUiSessionActive,
  parseCookieValue,
  readUiDeviceIdCookie,
  readUiSessionJwt,
  removeUiSessionDevice,
  resolveSessionTtlMs,
  saveUiSessionDevice,
  signUiSessionJwt,
  UI_DEVICE_COOKIE_NAME,
  UI_SESSION_COOKIE_NAME,
  UI_TRUSTED_DEVICE_TTL_MS,
  verifyPassword,
} from "@/lib/ui-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function cookieHeader(req: NextRequest, token: string, maxAgeSeconds: number): string {
  const secure = isSecureRequest(req.url, req.headers.get("x-forwarded-proto"));
  return buildSetCookieHeader({
    name: UI_SESSION_COOKIE_NAME,
    value: encodeURIComponent(token),
    maxAgeSeconds,
    secure,
  });
}

function deviceCookieHeader(req: NextRequest, value: string): string {
  const secure = isSecureRequest(req.url, req.headers.get("x-forwarded-proto"));
  return buildSetCookieHeader({
    name: UI_DEVICE_COOKIE_NAME,
    value,
    maxAgeSeconds: Math.floor(UI_TRUSTED_DEVICE_TTL_MS / 1000),
    secure,
  });
}

function clearCookieHeader(req: NextRequest): string {
  return cookieHeader(req, "", 0);
}

/** GET：会话状态（未登录 401；未设密码时 authenticated:true, passwordRequired:false）。 */
export async function GET(req: NextRequest) {
  if (!passwordEnabled(process.env, readServerConfig())) {
    return NextResponse.json({ authenticated: true, passwordRequired: false });
  }
  const secret = getOrCreateJwtSecret(process.env);
  if (isUiSessionActive(req.headers.get("cookie"), secret)) {
    return NextResponse.json({ authenticated: true, passwordRequired: true });
  }
  return NextResponse.json(
    { authenticated: false, passwordRequired: true, locked: true },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

/** POST：登录 { password, trustDevice? }。env 密码优先，回退配置文件哈希。 */
export async function POST(req: NextRequest) {
  const config = readServerConfig();
  if (!passwordEnabled(process.env, config)) {
    return NextResponse.json({ authenticated: true, passwordRequired: false });
  }
  const expected = resolvePassword(process.env);
  const storedHash = expected ? null : config.passwordHash;
  if (!expected && !storedHash) {
    return NextResponse.json({ error: "Password not configured" }, { status: 500 });
  }

  const identityHeaders: AuthIdentityHeaders = {
    peerAddress: req.headers.get("x-pidance-peer-ip"),
    xForwardedFor: req.headers.get("x-forwarded-for"),
  };
  // 与 middleware 的 Basic 尝试共用一个桶：同一个地址下两条入口的失败次数累加。
  const rateKey = authIdentity(identityHeaders, process.env);
  const retryAfterMs = getAuthRetryAfterMs(rateKey);
  if (retryAfterMs > 0) {
    return NextResponse.json(
      { error: "Too many login attempts, please try again later", retryAfter: retryAfterSeconds(retryAfterMs) },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfterSeconds(retryAfterMs)),
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const body = await req.json().catch(() => null) as {
    password?: unknown;
    trustDevice?: unknown;
  } | null;
  const candidate = typeof body?.password === "string" ? body.password : "";
  const valid = expected ? verifyPassword(candidate, expected) : verifyConfigPassword(candidate, storedHash!);
  if (!valid) {
    recordAuthFailure(rateKey);
    const res = NextResponse.json(
      { error: "Invalid credentials", authenticated: false },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
    res.headers.set("Set-Cookie", clearCookieHeader(req));
    return res;
  }

  // 表单登录成功复位计数（Basic 成功不复位，由 request-guard 侧处理）。
  recordAuthSuccess(rateKey);
  const trustDevice = body?.trustDevice === true;
  const ttlMs = resolveSessionTtlMs(trustDevice);
  const secret = getOrCreateJwtSecret(process.env);
  // 同一浏览器复用设备 id：重复登录更新同一条设备记录，不堆叠新行（登出时才删除该行）。
  const deviceId = readUiDeviceIdCookie(req.headers.get("cookie")) ?? randomBytes(16).toString("hex");
  const token = signUiSessionJwt(secret, ttlMs, Date.now(), deviceId);
  saveUiSessionDevice({
    id: deviceId,
    label: deviceLabelFromUserAgent(req.headers.get("user-agent")),
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
  });
  const res = NextResponse.json(
    { authenticated: true, passwordRequired: true, trustDevice },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
  res.headers.append("Set-Cookie", cookieHeader(req, token, Math.floor(ttlMs / 1000)));
  res.headers.append("Set-Cookie", deviceCookieHeader(req, deviceId));
  return res;
}

/** DELETE：登出，删除本设备的注册记录并清除会话 Cookie（设备 id 保留，下次登录仍归同一行）。 */
export async function DELETE(req: NextRequest) {
  const token = parseCookieValue(req.headers.get("cookie"), UI_SESSION_COOKIE_NAME);
  const jti = token ? readUiSessionJwt(token, getOrCreateJwtSecret(process.env)).jti : null;
  if (jti) removeUiSessionDevice(jti);
  const res = NextResponse.json(
    { authenticated: false, passwordRequired: passwordEnabled(process.env, readServerConfig()) },
    { headers: { "Cache-Control": "no-store" } },
  );
  res.headers.set("Set-Cookie", clearCookieHeader(req));
  return res;
}
