import { NextRequest, NextResponse } from "next/server";
import { passwordEnabled } from "@/lib/request-guard";
import { readServerConfig } from "@/lib/pidance-server-config";
import {
  getOrCreateJwtSecret,
  parseCookieValue,
  readUiSessionDevices,
  readUiSessionJwt,
  UI_SESSION_COOKIE_NAME,
} from "@/lib/ui-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 设置 → 通用 → 登录管理：已登录设备列表。
 * 需要认证（middleware 已校验）；无密码时无 UI 会话概念，返回空列表。
 * 每项含 current 标记（是否本请求 cookie 的设备），供前端标识「此设备」。
 */
export async function GET(req: NextRequest) {
  if (!passwordEnabled(process.env, readServerConfig())) {
    return NextResponse.json({ devices: [] });
  }
  const secret = getOrCreateJwtSecret(process.env);
  const token = parseCookieValue(req.headers.get("cookie"), UI_SESSION_COOKIE_NAME);
  const currentJti = token ? readUiSessionJwt(token, secret).jti : null;
  const devices = readUiSessionDevices().map((device) => ({
    id: device.id,
    label: device.label,
    createdAt: device.createdAt,
    expiresAt: device.expiresAt,
    current: currentJti === device.id,
  }));
  return NextResponse.json({ devices });
}
