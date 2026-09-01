import { NextResponse } from "next/server";
import { sessionService } from "@/lib/session-service";
import { getThinkingText, isThinkingLikeType } from "@/lib/thinking-content";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; entryId: string }> },
) {
  const { id, entryId } = await params;
  const blockIndexParam = new URL(req.url).searchParams.get("blockIndex");
  const blockIndex = blockIndexParam === null ? Number.NaN : Number(blockIndexParam);
  if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) {
    return NextResponse.json({ error: "Valid blockIndex is required" }, { status: 400 });
  }

  try {
    const view = await sessionService.getReadView(id);
    if (!view) return NextResponse.json({ thinking: null });

    const entry = view.manager.getEntries().find((candidate) => {
      const record = candidate as { id?: string; type?: string; message?: { role?: string; content?: unknown[] } };
      return record.id === entryId;
    }) as { type?: string; message?: { role?: string; content?: Array<{ type?: string }> } } | undefined;
    if (!entry || entry.type !== "message" || entry.message?.role !== "assistant") {
      return NextResponse.json({ thinking: null });
    }

    const block = entry.message.content?.[blockIndex];
    if (!block || !isThinkingLikeType(block.type)) {
      return NextResponse.json({ thinking: null });
    }

    return NextResponse.json({ thinking: getThinkingText(block) });
  } catch {
    return NextResponse.json({ thinking: null });
  }
}
