/**
 * 聊天附件存储：独立目录 ~/.pi/agent/pidance-attachments/
 * 不依赖项目 cwd；路径注入 prompt 后由 agent 自行 read；
 * /api/files 预览需把该目录加入 allow-list。
 */

import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { getAgentDir } from "./pi-paths";
import { allowFileRoot, normalizeSlashes } from "./file-access";

export const CHAT_ATTACHMENTS_DIR_NAME = "pidance-attachments";
export const CHAT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const CHAT_ATTACHMENT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
/** 消息媒体使用流式上传；这是传输安全上限，不限制会话中的显示尺寸。 */
export const MESSAGE_MEDIA_MAX_BYTES = 512 * 1024 * 1024;

export function getChatAttachmentsDir(agentDir: string = getAgentDir()): string {
  return normalizeSlashes(join(agentDir, CHAT_ATTACHMENTS_DIR_NAME));
}

/** 确保目录存在，并登记到文件 allow-list（供 /api/files 预览与后续读）。 */
export function ensureChatAttachmentsDir(agentDir: string = getAgentDir()): string {
  const dir = getChatAttachmentsDir(agentDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  allowFileRoot(dir);
  return dir;
}

/** 清理文件名：去掉路径分隔与空字节，保留 basename。 */
export function sanitizeAttachmentFileName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "file";
  const cleaned = base.replace(/\0/g, "").replace(/^\.+/, "").trim() || "file";
  // 过长文件名截断，保留扩展名
  if (cleaned.length <= 180) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  if (dot > 0 && cleaned.length - dot <= 20) {
    const ext = cleaned.slice(dot);
    return cleaned.slice(0, 180 - ext.length) + ext;
  }
  return cleaned.slice(0, 180);
}

/** 生成唯一落盘名：时间戳_uuid前缀_原名，避免覆盖。 */
export function uniqueAttachmentFileName(originalName: string, now = Date.now()): string {
  const safe = sanitizeAttachmentFileName(originalName);
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const id = randomUUID().slice(0, 8);
  return `${stamp}_${id}_${safe}`;
}

export type SavedChatAttachment = {
  path: string;
  name: string;
  storedName: string;
  size: number;
};

/**
 * 将消息媒体流式写入附件目录，避免把原图/大视频同时读入 Node 内存。
 * 调用方负责校验 MIME；这里以实际读取字节数为准并原子改名。
 */
export async function saveChatAttachmentStream(
  originalName: string,
  body: ReadableStream<Uint8Array>,
  agentDir: string = getAgentDir(),
  maxBytes: number = MESSAGE_MEDIA_MAX_BYTES,
): Promise<SavedChatAttachment> {
  const dir = ensureChatAttachmentsDir(agentDir);
  const storedName = uniqueAttachmentFileName(originalName);
  const target = join(dir, storedName);
  const temporary = join(dir, `.${storedName}.${randomUUID()}.tmp`);
  let size = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) {
        callback(new Error(`message media exceeds ${maxBytes} bytes`));
        return;
      }
      callback(null, bytes);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(body as unknown as import("node:stream/web").ReadableStream),
      counter,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
    throw error;
  }

  return {
    path: normalizeSlashes(target),
    name: sanitizeAttachmentFileName(originalName),
    storedName,
    size,
  };
}

/**
 * 将字节写入附件目录，返回绝对路径。
 * 调用方负责校验大小与文件名合法性。
 */
export function saveChatAttachmentBytes(
  originalName: string,
  bytes: Buffer,
  agentDir: string = getAgentDir(),
): SavedChatAttachment {
  const dir = ensureChatAttachmentsDir(agentDir);
  const storedName = uniqueAttachmentFileName(originalName);
  const target = join(dir, storedName);
  writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
  return {
    path: normalizeSlashes(target),
    name: sanitizeAttachmentFileName(originalName),
    storedName,
    size: bytes.length,
  };
}
