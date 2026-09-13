import { NextResponse } from "next/server";
import { sessionService } from "@/lib/session-service";

/**
 * GET /api/sessions/:id/outline — 会话全部用户消息大纲（左侧导航条用）。
 *
 * 只读：直接读完整 entry 列表（live 内存视图或磁盘），不唤醒 writer。
 * 失败按「只读投影失败 → 200 安全空态」返回空大纲，不升 500。
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const items = await sessionService.getUserMessageOutline(id);
    return NextResponse.json({ sessionId: id, userMessages: items });
  } catch {
    return NextResponse.json({ sessionId: id, userMessages: [] });
  }
}
