import { NextResponse } from "next/server";
import { sessionService } from "@/lib/session-service";
import { getRunningStartedAt } from "@/lib/running-state";

/**
 * GET /api/sessions[?scope=active|archived|all]
 * 服务端权威投影（客户端不读 sidecar）：
 * - 默认 / scope=active：仅 active 会话；同时附 archivedSessions/archivedCount
 *   （Archive 页面与侧栏 badge 共用一次请求，改动面最小）。
 * - scope=archived：仅归档会话。
 * - scope=all：全部真实会话（含归档）。
 * 归档/恢复/永久删除后的缓存失效由服务层统一处理。
 */
export async function GET(req: Request) {
  try {
    const scope = new URL(req.url).searchParams.get("scope");
    const runningSessionIds = sessionService.getRunningIds();
    if (scope === "archived") {
      const sessions = await sessionService.listArchivedSessions();
      return NextResponse.json({ sessions, runningSessionIds, runningStartedAt: Object.fromEntries(getRunningStartedAt()) });
    }
    if (scope === "all") {
      const sessions = await sessionService.listAllSessions();
      return NextResponse.json({ sessions, runningSessionIds, runningStartedAt: Object.fromEntries(getRunningStartedAt()) });
    }
    if (scope !== null && scope !== "active") {
      return NextResponse.json({ error: `Invalid scope: ${scope}` }, { status: 400 });
    }
    const { sessions, archivedSessions, archivedCount } = await sessionService.listSessions();
    return NextResponse.json({ sessions, archivedSessions, archivedCount, runningSessionIds, runningStartedAt: Object.fromEntries(getRunningStartedAt()) });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
