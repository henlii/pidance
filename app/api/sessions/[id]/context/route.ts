import { NextResponse } from "next/server";
import { buildSessionContext } from "@/lib/session-reader";
import {
  parseContextLimitParam,
  sliceContextBefore,
  sliceContextTail,
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
    // 与主会话 GET 一致：getReadView 在存活 live wrapper 时用其 entries，避免 leaf 偏差。
    // readOnly subagent 仍可读；不 start。投影本身以请求 leafId 为准。
    const view = await sessionService.getReadView(id);
    if (!view) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = view.manager;
    const entries = sm.getEntries() as never;
    const full = buildSessionContext(entries, leafId, {
      deferThinking,
      deferToolResultImages,
    });

    // before：更旧页；limit 无 before 时作 tail；都不传则全量（分支切换兼容）。
    let context;
    if (before) {
      context = sliceContextBefore(full, before, limit ?? DEFAULT_SESSION_HISTORY_PAGE);
    } else if (limit !== null) {
      context = sliceContextTail(full, limit);
    } else {
      context = {
        ...full,
        hasMoreBefore: false,
        totalMessageCount: full.messages.length,
      };
    }

    return NextResponse.json({ context });
  } catch {
    return NextResponse.json({
      context: { messages: [], entryIds: [], hasMoreBefore: false, totalMessageCount: 0 },
    });
  }
}
