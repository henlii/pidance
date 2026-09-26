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
        const result = await sessionService.send(id, command, { signal: req.signal });
        return NextResponse.json({ success: true, data: result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("required") || message.startsWith("Unsupported") || message.startsWith("invalid") || message.includes("must be")) {
          return NextResponse.json({ error: message }, { status: 400 });
        }
        throw error;
      }
    }
    const result = await sessionService.send(id, body as { type: string; [key: string]: unknown }, { signal: req.signal });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: httpStatusForSessionError(error) });
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // light=1：轮询用。省略 systemPrompt（数十 KB 且几乎不变）；
  // 消费方按「键缺失 = 本次不更新」处理，语义不变。
  const light = new URL(req.url).searchParams.get("light") === "1";

  try {
    const result = await sessionService.getAgentState(id, { light });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: httpStatusForSessionError(error) });
  }
}
