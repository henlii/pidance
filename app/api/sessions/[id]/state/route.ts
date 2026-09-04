import { NextResponse } from "next/server";
import {
  sessionService,
  httpStatusForSessionError,
} from "@/lib/session-service";

/**
 * GET /api/sessions/[id]/state
 * - 默认：仅当已有 live host 时返回 get_state（不启动）
 * - ?wake=1：可写会话 ensureLive 后返回完整 state
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // 内存已 live（含 ensure_session 未落盘的新会话）：直接放行，不要求磁盘文件。
    // ensure_session 的 host 在 user 消息落盘前没有 JSONL，resolvePath 会 404，
    // 导致新建会话首次 prompt 的 wake 步骤失败（会话只有乐观 1 条、刷新即消失）。
    const liveNow = sessionService.getLive(id);
    if (liveNow) {
      return NextResponse.json(await sessionService.getAgentState(id));
    }
    if (!(await sessionService.resolvePath(id))) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const result = await sessionService.getAgentState(id);
    if (result.readOnly) {
      return NextResponse.json(result);
    }

    const wake = new URL(req.url).searchParams.get("wake") === "1";
    if (wake && !result.live) {
      await sessionService.ensureLive(id);
      return NextResponse.json(await sessionService.getAgentState(id));
    }
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: httpStatusForSessionError(error) });
  }
}
