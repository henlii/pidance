import { NextResponse } from "next/server";
import { sessionService, httpStatusForNewSessionError } from "@/lib/session-service";

// POST /api/agent/new  body: { cwd: string; type: string; message?: string; ... }
// Spawns a brand-new pi session. Most calls immediately send the first command;
// type:"ensure_session" only creates the runtime so clients can query commands.
// Returns { sessionId, data } where sessionId is pi's real session id.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: string; [key: string]: unknown };
    const { cwd, ...command } = body;

    const { sessionId, data } = await sessionService.createNew({
      cwd: cwd as string,
      command: command as { type: string; [key: string]: unknown },
    });

    return NextResponse.json({ success: true, sessionId, data });
  } catch (error) {
    // 不要再与 `String(error)` 比较：Error 的字符串形式带 "Error: " 前缀，
    // 会让输入错误被误报为 500。统一走类型化映射。
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: httpStatusForNewSessionError(error) });
  }
}
