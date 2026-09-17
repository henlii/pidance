import { NextRequest, NextResponse } from "next/server";
import {
  MESSAGE_MEDIA_MAX_BYTES,
  deleteChatAttachmentMedia,
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

/** 单次删除的路径数上限：客户端只在移除输入框附件/清草稿时调用。 */
const MEDIA_DELETE_MAX_PATHS = 64;

/**
 * DELETE /api/message-media
 *
 * 输入框里的附件被移除后回收服务端文件（图片含原图/预览/模型副本）。只允许删
 * 附件目录内的常规文件：越界路径与 symlink 由 deleteChatAttachmentMedia 拒绝，
 * 删除本身幂等（已消失的返回未删）。
 */
export async function DELETE(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { paths?: unknown } | null;
  const paths = body?.paths;
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) {
    return NextResponse.json({ error: "paths must be an array of strings" }, { status: 400 });
  }
  if (paths.length > MEDIA_DELETE_MAX_PATHS) {
    return NextResponse.json({ error: `at most ${MEDIA_DELETE_MAX_PATHS} paths per request` }, { status: 400 });
  }
  let deleted = 0;
  for (const path of paths) {
    if (deleteChatAttachmentMedia(path as string)) deleted += 1;
  }
  return NextResponse.json({ deleted });
}
