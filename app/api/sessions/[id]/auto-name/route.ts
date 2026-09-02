/**
 * POST /api/sessions/[id]/auto-name — 会话自动命名。
 */

import { NextResponse } from "next/server";
import { sessionService, READ_ONLY_SUBAGENT_ERROR, httpStatusForSessionError } from "@/lib/session-service";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const result = await sessionService.autoNameSession(id);
    return NextResponse.json(result);
  } catch (error) {
    if (String(error) === READ_ONLY_SUBAGENT_ERROR) {
      return NextResponse.json({ error: READ_ONLY_SUBAGENT_ERROR }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: httpStatusForSessionError(error) });
  }
}
