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
    const result = await sessionService.getToolResultDetails(id, toolCallId);
    return NextResponse.json(result ?? { details: null });
  } catch {
    return NextResponse.json({ details: null });
  }
}
