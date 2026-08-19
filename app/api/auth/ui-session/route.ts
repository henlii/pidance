import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { resolvePassword, passwordEnabled } from "@/lib/request-guard";
import { readServerConfig, verifyConfigPassword } from "@/lib/pidance-server-config";
import {
  buildSetCookieHeader,
  checkLoginRateLimit,
  clearLoginFailures,
  clientIpFromHeaders,
  deviceLabelFromUserAgent,
  getOrCreateJwtSecret,
  isSecureRequest,
  isUiSessionActive,
  parseCookieValue,
  recordLoginFailure,
  resolveSessionTtlMs,
  saveUiSessionDevice,
  signUiSessionJwt,
  UI_SESSION_COOKIE_NAME,
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

  const ip = clientIpFromHeaders({
    "x-forwarded-for": req.headers.get("x-forwarded-for"),
    "x-real-ip": req.headers.get("x-real-ip"),
  });
  const rateKey = `login:${ip}`;
  const rate = checkLoginRateLimit(rateKey);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many login attempts, please try again later", retryAfter: rate.retryAfterSeconds },
      {
        status: 429,
        headers: {
          "Retry-After": String(rate.retryAfterSeconds),
          "X-RateLimit-Limit": String(rate.limit),
          "X-RateLimit-Remaining": "0",
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
    recordLoginFailure(rateKey);
    const res = NextResponse.json(
      { error: "Invalid credentials", authenticated: false },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
    res.headers.set("Set-Cookie", clearCookieHeader(req));
    return res;
  }

  clearLoginFailures(rateKey);
  const trustDevice = body?.trustDevice === true;
  const ttlMs = resolveSessionTtlMs(trustDevice);
  const secret = getOrCreateJwtSecret(process.env);
  // 带 jti 的会话注册到设备列表（登录管理可逐设备删除）
  const jti = randomBytes(16).toString("hex");
  const token = signUiSessionJwt(secret, ttlMs, Date.now(), jti);
  saveUiSessionDevice({
    id: jti,
    label: deviceLabelFromUserAgent(req.headers.get("user-agent")),
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
  });
  const res = NextResponse.json(
    { authenticated: true, passwordRequired: true, trustDevice },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
  res.headers.set("Set-Cookie", cookieHeader(req, token, Math.floor(ttlMs / 1000)));
  return res;
}

/** DELETE：登出，清除 Cookie。 */
export async function DELETE(req: NextRequest) {
  const res = NextResponse.json(
    { authenticated: false, passwordRequired: passwordEnabled(process.env, readServerConfig()) },
    { headers: { "Cache-Control": "no-store" } },
  );
  res.headers.set("Set-Cookie", clearCookieHeader(req));
  return res;
}
