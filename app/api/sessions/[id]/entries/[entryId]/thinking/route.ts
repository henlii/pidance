import { NextResponse } from "next/server";
import { sessionService } from "@/lib/session-service";

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
    const result = await sessionService.getEntryThinking(id, entryId, blockIndex);
    return NextResponse.json(result ?? { thinking: null });
  } catch {
    return NextResponse.json({ thinking: null });
  }
}
