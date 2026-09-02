import { NextResponse } from "next/server";
import { sessionService } from "@/lib/session-service";
import { parseExportFormat, SessionExportError } from "@/lib/session-export";

export const runtime = "nodejs";

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function getContentDisposition(fileName: string, inline: boolean): string {
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "session.html";
  const disposition = inline ? "inline" : "attachment";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const format = parseExportFormat(url.searchParams.get("format"));
  if (format === null) {
    return NextResponse.json({ error: "Unknown export format" }, { status: 400 });
  }
  const inline = url.searchParams.get("inline") === "1";
  const leafId = url.searchParams.get("leafId");

  try {
    const result = await sessionService.exportSession(id, {
      format,
      leafId: leafId && leafId.length > 0 ? leafId : undefined,
    });
    return new Response(result.body, {
      headers: {
        "Content-Type": result.contentType,
        "Content-Disposition": getContentDisposition(
          result.fileName,
          format === "html" ? inline : false,
        ),
        "Cache-Control": "no-cache",
        "Content-Security-Policy": "frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      },
    });
  } catch (error) {
    if (error instanceof SessionExportError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Session not found")) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
