import { NextResponse } from "next/server";
import {
  parseContextLimitParam,
  DEFAULT_SESSION_HISTORY_PAGE,
  DEFAULT_SESSION_TAIL_LIMIT,
} from "@/lib/session-context-window";
import { sessionService } from "@/lib/session-service";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const before = url.searchParams.get("before") ?? undefined;
  // 按 entryId 定位（导航条跳转到历史某条）：与 before/after 互斥，优先 around。
  const around = url.searchParams.get("around") ?? undefined;
  // 定位到历史后继续向下加载：取 after 之后的更新窗口。
  const after = url.searchParams.get("after") ?? undefined;
  // 跳转历史时窗口一直取到最新（保留尾部流式段，运行中会话不被切掉尾部）。
  const aroundToEnd = url.searchParams.get("toEnd") !== "0";
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");
  const limit = parseContextLimitParam(
    url.searchParams,
    before || around || after ? DEFAULT_SESSION_HISTORY_PAGE : DEFAULT_SESSION_TAIL_LIMIT,
  );

  try {
    const result = await sessionService.getContextPage(id, {
      leafId,
      before,
      around,
      after,
      aroundToEnd: around !== undefined ? aroundToEnd : undefined,
      limit,
      deferThinking,
      deferToolResultImages,
    }) as { context?: unknown };
    const context = result.context;
    if (!context) {
      // 两种未命中分开：anchor 不在当前 leaf 路径（404 not-found）vs 会话不存在。
      const notFound = (result as { notFound?: string }).notFound;
      return NextResponse.json(
        notFound ? { error: "Entry not found in current branch", entryId: notFound } : { error: "Session not found" },
        { status: 404 },
      );
    }
    return NextResponse.json({ context });
  } catch {
    return NextResponse.json({
      context: { messages: [], entryIds: [], hasMoreBefore: false, totalMessageCount: 0 },
    });
  }
}
