import { NextRequest, NextResponse } from "next/server";
import {
  MESSAGE_MEDIA_MAX_BYTES,
  saveChatAttachmentStream,
} from "@/lib/chat-attachments";
import { normalizeBinaryMimeType } from "@/lib/message-binary";

export const dynamic = "force-dynamic";

function decodeFileName(value: string | null): string {
  if (!value) return "file";
  try {
    return decodeURIComponent(value) || "file";
  } catch {
    return "file";
  }
}

function responseStatus(error: unknown): number {
  return error instanceof Error && error.message.startsWith("message media exceeds") ? 413 : 500;
}

/**
 * POST /api/message-media
 * 原图/音视频/二进制消息的原始字节流入口；JSON prompt 只携带返回的 path 元数据。
 */
export async function POST(request: NextRequest) {
  if (!request.body) {
    return NextResponse.json({ error: "Media body is required" }, { status: 400 });
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isSafeInteger(contentLength) && contentLength > MESSAGE_MEDIA_MAX_BYTES) {
    return NextResponse.json({ error: `Media exceeds ${MESSAGE_MEDIA_MAX_BYTES} bytes` }, { status: 413 });
  }

  const mimeType = normalizeBinaryMimeType(request.headers.get("content-type")) ?? "application/octet-stream";
  try {
    const saved = await saveChatAttachmentStream(
      decodeFileName(request.headers.get("x-pidance-filename")),
      request.body,
    );
    return NextResponse.json({ ...saved, mediaId: saved.storedName, mimeType });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: responseStatus(error) },
    );
  }
}
