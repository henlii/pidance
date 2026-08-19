import { NextRequest, NextResponse } from "next/server";
import { removeUiSessionDevice } from "@/lib/ui-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 删除已登录设备：从设备注册表移除，该设备的 UI 会话 cookie 随即失效（middleware 逐请求校验）。
 * 删除当前设备后，本请求的 cookie 也会在下次请求被拒绝（前端同时清除 cookie）。
 * 需要认证（middleware 已校验）。
 */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!id || id.length === 0 || id.length > 64) {
    return NextResponse.json({ error: "invalid_device_id" }, { status: 400 });
  }
  removeUiSessionDevice(id);
  return NextResponse.json({ ok: true });
}
