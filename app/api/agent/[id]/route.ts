import { NextResponse } from "next/server";
import { sessionService, requireWritableSession, httpStatusForSessionError } from "@/lib/session-service";
import { isTypedMessageCommandType, parseTypedMessageCommand } from "@/lib/agent-commands";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    await requireWritableSession(id, sessionService.isReadOnly);
    const body = await req.json() as { type?: string; [key: string]: unknown };
    if (typeof body.type !== "string" || !body.type) {
      return NextResponse.json({ error: "type is required" }, { status: 400 });
    }
    if (isTypedMessageCommandType(body.type)) {
      try {
        const command = parseTypedMessageCommand(body);
        if (command.type === "prompt") {
          const receipt = await sessionService.submitPrompt(id, command);
          return NextResponse.json({ success: true, data: receipt });
        }
        const result = await sessionService.send(id, command);
        return NextResponse.json({ success: true, data: result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("required") || message.startsWith("Unsupported") || message.startsWith("invalid") || message.includes("must be")) {
          return NextResponse.json({ error: message }, { status: 400 });
        }
        throw error;
      }
    }
    const result = await sessionService.send(id, body as { type: string; [key: string]: unknown });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: httpStatusForSessionError(error) });
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const result = await sessionService.getAgentState(id);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: httpStatusForSessionError(error) });
  }
}
