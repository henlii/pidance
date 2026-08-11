import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import {
  sessionService,
  READ_ONLY_SUBAGENT_ERROR,
} from "@/lib/session-service";
import { awaitSessionStartLock } from "@/lib/live-session-registry";

/**
 * POST /api/sessions/[id]/release
 * 切换会话时释放空闲 live host。
 * 若 ensureLive 仍在启动：先等启动锁，再判断 isRunning；避免半初始化残留。
 * 仍在 streaming/prompt/bash/compact 时不释放。
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    if (!(await resolveSessionPath(id))) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    if (await sessionService.isReadOnly(id)) {
      return NextResponse.json({ released: false, reason: "read-only" });
    }

    // 与并发 ensureLive/send 共用启动锁：等创建完成后再 destroy
    await awaitSessionStartLock(id);

    const live = sessionService.getLive(id);
    if (!live) {
      return NextResponse.json({ released: false, reason: "not-live" });
    }
    if (live.isRunning()) {
      return NextResponse.json({ released: false, reason: "running" });
    }

    sessionService.destroy(id);
    return NextResponse.json({ released: true });
  } catch (error) {
    if (String(error) === READ_ONLY_SUBAGENT_ERROR) {
      return NextResponse.json({ error: READ_ONLY_SUBAGENT_ERROR }, { status: 403 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
