import { NextResponse } from "next/server";
import { loadSessionStats } from "@/lib/session-metadata-cache";
import { resolveSessionPath } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

// GET /api/sessions/[id]/stats —— 全量 token 统计（不含窗口）。
// 数字由扫描折叠 JSONL 全部 message 条目得到，与客户端加载了多少消息无关。
// 读投影失败一律 200 空态（不升 5xx）。
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return NextResponse.json({ sessionId: id, stats: null });
    const stats = await loadSessionStats(filePath);
    return NextResponse.json({ sessionId: id, stats: stats ?? null });
  } catch {
    return NextResponse.json({ sessionId: id, stats: null });
  }
}
