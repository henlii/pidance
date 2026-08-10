import { NextResponse } from "next/server";
import { sessionService } from "@/lib/session-service";

export const dynamic = "force-dynamic";

// POST /api/sessions/[id]/command-entry
// body: { command: "/compact", ok?: boolean, result?: string }
// 斜杠命令执行成功后追加 pidance.command 条目到会话时间线（type:"custom"，不进 LLM 上下文）。
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "body required" }, { status: 400 });
  }
  const input = body as { command?: unknown; ok?: unknown; result?: unknown };
  if (typeof input.command !== "string" || input.command.trim() === "") {
    return NextResponse.json({ error: "command required" }, { status: 400 });
  }
  if (input.ok !== undefined && typeof input.ok !== "boolean") {
    return NextResponse.json({ error: "ok must be boolean" }, { status: 400 });
  }
  if (input.result !== undefined && typeof input.result !== "string") {
    return NextResponse.json({ error: "result must be string" }, { status: 400 });
  }
  try {
    const result = await sessionService.appendCommandEntry(id, {
      command: input.command,
      ok: input.ok,
      result: input.result,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
