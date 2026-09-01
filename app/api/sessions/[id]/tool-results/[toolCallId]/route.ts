import { NextResponse } from "next/server";
import { sessionService } from "@/lib/session-service";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; toolCallId: string }> },
) {
  const { id, toolCallId } = await params;
  if (!toolCallId) {
    return NextResponse.json({ error: "toolCallId is required" }, { status: 400 });
  }

  try {
    const view = await sessionService.getReadView(id);
    if (!view) return NextResponse.json({ details: null });

    const entry = view.manager.getEntries().find((candidate) => {
      const record = candidate as { type?: string; message?: { role?: string; toolCallId?: string } };
      if (record.type !== "message") return false;
      return record.message?.role === "toolResult" && record.message.toolCallId === toolCallId;
    }) as { message?: { details?: unknown } } | undefined;
    if (!entry) return NextResponse.json({ details: null });
    return NextResponse.json({ details: entry.message?.details ?? null });
  } catch {
    return NextResponse.json({ details: null });
  }
}
