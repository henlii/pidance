import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import {
  sessionService,
  httpStatusForSessionError,
} from "@/lib/session-service";

/**
 * GET /api/sessions/[id]/state
 * - 默认：仅当已有 live host 时返回 get_state（不启动）
 * - ?wake=1：可写会话 ensureLive 后返回完整 state（含 systemPrompt / contextUsage）
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    if (!(await resolveSessionPath(id))) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (await sessionService.isReadOnly(id)) {
      return NextResponse.json({ running: false, readOnly: true });
    }

    const wake = new URL(req.url).searchParams.get("wake") === "1";
    const live = wake
      ? await sessionService.ensureLive(id)
      : sessionService.getLive(id);

    if (!live) {
      return NextResponse.json({
        running: false,
      });
    }

    const state = await live.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: httpStatusForSessionError(error) });
  }
}
