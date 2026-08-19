import { NextRequest, NextResponse } from "next/server";
import { resolvePassword } from "@/lib/request-guard";
import {
  applyServerConfigChange,
  passwordConfigured,
  readServerConfig,
  writeServerConfig,
  type ServerConfigChange,
} from "@/lib/pidance-server-config";
import { clearUiSessionDevices, rotateJwtSecret } from "@/lib/ui-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 设置 → 通用：服务端密码、远程服务开关与监听端口（~/.pi/agent/pidance-server.json）。
 * GET 永不返回密码本身；PUT 规则见 applyServerConfigChange（远程开启必须已有密码，
 * 已设密码后修改/清除必须提供当前密码）。改密码后轮换 UI 会话 JWT secret 强制重新登录。
 * 监听地址/端口变更（remoteEnabled/port）需重启 Pidance 生效，由前端提示。
 */
export async function GET() {
  const config = readServerConfig();
  return NextResponse.json({
    passwordSet: passwordConfigured(resolvePassword(process.env), config),
    remoteEnabled: config.remoteEnabled,
    port: config.port,
  });
}

export async function PUT(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Partial<ServerConfigChange> | null;
  const change: ServerConfigChange = {
    password: typeof body?.password === "string" ? body.password : undefined,
    clearPassword: body?.clearPassword === true,
    remoteEnabled: typeof body?.remoteEnabled === "boolean" ? body.remoteEnabled : undefined,
    port: typeof body?.port === "number" || body?.port === null ? body.port : undefined,
  };
  const current = readServerConfig();
  const result = applyServerConfigChange(current, change, resolvePassword(process.env));
  if ("error" in result) {
    return NextResponse.json(
      { error: result.error },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  writeServerConfig(result.config);
  if (result.changedPassword) {
    try {
      // 密码变更后强制全局登出（env 固定 JWT secret 时跳过，保持既有会话语义）
      rotateJwtSecret(process.env);
      clearUiSessionDevices();
    } catch {
      /* 环境变量固定 secret，不可轮换 */
    }
  }
  return NextResponse.json(
    {
      passwordSet: passwordConfigured(resolvePassword(process.env), result.config),
      remoteEnabled: result.config.remoteEnabled,
      port: result.config.port,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
