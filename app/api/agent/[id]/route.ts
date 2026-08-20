import { NextResponse } from "next/server";
import { sessionService, requireWritableSession, httpStatusForSessionError } from "@/lib/session-service";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    await requireWritableSession(id, sessionService.isReadOnly);
    const body = await req.json() as { type: string; [key: string]: unknown };
    const result = await sessionService.send(id, body);
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: httpStatusForSessionError(error) });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    if (await sessionService.isReadOnly(id)) {
      return NextResponse.json({ running: false, readOnly: true });
    }
    const session = sessionService.getLiveSession(id);
    if (!session) {
      return NextResponse.json({
        running: false,
      });
    }

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
