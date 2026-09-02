import { NextResponse } from "next/server";
import {
  parseContextLimitParam,
  sliceContextTail,
  DEFAULT_SESSION_TAIL_LIMIT,
} from "@/lib/session-context-window";
import { sessionService, READ_ONLY_SUBAGENT_ERROR, httpStatusForSessionError } from "@/lib/session-service";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const snapshot = await sessionService.getNavigationSnapshot(id, {
      deferThinking: new URL(req.url).searchParams.has("deferThinking"),
      deferToolResultImages: new URL(req.url).searchParams.has("deferMedia"),
    });
    if (!snapshot) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const searchParams = new URL(req.url).searchParams;
    const tailLimit = parseContextLimitParam(searchParams, DEFAULT_SESSION_TAIL_LIMIT);
    const fullContext = snapshot.context as {
      messages: unknown[];
      totalMessageCount?: number;
      hasMoreBefore?: boolean;
    };
    const context = tailLimit !== null
      ? sliceContextTail(fullContext as never, tailLimit)
      : {
          ...fullContext,
          hasMoreBefore: false,
          totalMessageCount: fullContext.messages.length,
        };

    return NextResponse.json({
      sessionId: id,
      filePath: snapshot.filePath,
      info: snapshot.info,
      leafId: snapshot.leafId,
      tree: snapshot.tree,
      context,
    });
  } catch (error) {
    if (String(error) === READ_ONLY_SUBAGENT_ERROR) {
      return NextResponse.json({ error: READ_ONLY_SUBAGENT_ERROR }, { status: 403 });
    }
    return NextResponse.json({
      sessionId: id,
      filePath: null,
      info: null,
      leafId: null,
      tree: [],
      context: { messages: [], entryIds: [], hasMoreBefore: false, totalMessageCount: 0 },
    });
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    await sessionService.renameSession(id, name);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "name is required") {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: message }, { status: httpStatusForSessionError(error) });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const result = await sessionService.deleteSession(id);
    return NextResponse.json({ ok: true, skippedSubagents: result.skippedSubagents });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: httpStatusForSessionError(error) },
    );
  }
}
