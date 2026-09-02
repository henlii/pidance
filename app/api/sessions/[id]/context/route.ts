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
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");
  const limit = parseContextLimitParam(
    url.searchParams,
    before ? DEFAULT_SESSION_HISTORY_PAGE : DEFAULT_SESSION_TAIL_LIMIT,
  );

  try {
    const result = await sessionService.getContextPage(id, {
      leafId,
      before,
      limit,
      deferThinking,
      deferToolResultImages,
    }) as { context?: unknown };
    const context = result.context;
    if (!context) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ context });
  } catch {
    return NextResponse.json({
      context: { messages: [], entryIds: [], hasMoreBefore: false, totalMessageCount: 0 },
    });
  }
}
