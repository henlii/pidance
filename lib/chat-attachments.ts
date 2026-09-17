/**
 * 聊天附件存储：独立目录 ~/.pi/agent/pidance-attachments/
 * 不依赖项目 cwd；路径注入 prompt 后由 agent 自行 read；
 * /api/files 预览需把该目录加入 allow-list。
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
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

/**
 * 单份附件读回内存的上限（安全尺寸模型副本远小于此；超出即拒绝读进内存）。
 */
export const CHAT_MEDIA_READ_MAX_BYTES = 25 * 1024 * 1024;

/** 附件目录内的常规文件（GC 扫描用）。 */
export interface ChatAttachmentFile {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * 把候选路径解析为附件目录内的真实文件；越界/不存在/非普通文件一律 null。
 *
 * 字面前缀不够：目录里一个指向别处的 symlink 会把任意文件变成「附件」，于是变成
 * 「客户端给个路径就能读/删任意文件」。realpath 解析后仍须落在附件目录内。
 */
function withChatAttachmentFile<T>(
  candidate: string,
  agentDir: string,
  use: (realPath: string) => T,
): T | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  try {
    const root = normalizeSlashes(realpathSync(ensureChatAttachmentsDir(agentDir)));
    const real = normalizeSlashes(realpathSync(trimmed));
    if (real !== root && !real.startsWith(`${root}/`)) return null;
    if (!statSync(real).isFile()) return null;
    return use(real);
  } catch {
    // 文件或目录不存在：不是有效引用（删除/读取都按幂等处理）
    return null;
  }
}

/** 路径是否是附件目录内的常规文件（引用校验、删除前的守卫）。 */
export function isChatAttachmentMediaPath(path: string, agentDir: string = getAgentDir()): boolean {
  return withChatAttachmentFile(path, agentDir, () => true) ?? false;
}

/** 附件文件的字节数；越界/不存在/非普通文件返回 null。 */
export function chatAttachmentMediaSize(path: string, agentDir: string = getAgentDir()): number | null {
  return withChatAttachmentFile(path, agentDir, (real) => statSync(real).size);
}

/** 读回附件为 base64；越界/非普通文件/超过上限返回 null。 */
export function readChatAttachmentBase64(
  path: string,
  agentDir: string = getAgentDir(),
  maxBytes: number = CHAT_MEDIA_READ_MAX_BYTES,
): string | null {
  return withChatAttachmentFile(path, agentDir, (real) => {
    if (statSync(real).size > maxBytes) return null;
    return readFileSync(real).toString("base64");
  });
}

/** 是否超过读回上限（投递前的可读性检查，避免把大文件读进内存才发现）。 */
export function isChatAttachmentReadable(
  path: string,
  agentDir: string = getAgentDir(),
  maxBytes: number = CHAT_MEDIA_READ_MAX_BYTES,
): boolean {
  const size = chatAttachmentMediaSize(path, agentDir);
  return size !== null && size <= maxBytes;
}

/** 删除一份附件（幂等）。返回是否确实删掉了文件。 */
export function deleteChatAttachmentMedia(path: string, agentDir: string = getAgentDir()): boolean {
  return withChatAttachmentFile(path, agentDir, (real) => {
    try {
      unlinkSync(real);
      return true;
    } catch {
      // 已经被删（竞态）：目标达成
      return false;
    }
  }) ?? false;
}

/** 列出附件目录内的所有常规文件（递归；symlink 与目录不列）。 */
export function listChatAttachmentFiles(agentDir: string = getAgentDir()): ChatAttachmentFile[] {
  const files: ChatAttachmentFile[] = [];
  walkChatAttachments(getChatAttachmentsDir(agentDir), files);
  return files;
}

function walkChatAttachments(dir: string, out: ChatAttachmentFile[]): void {
  const entries = (() => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      // 目录不存在/不可读：没有可扫描的文件
      return [];
    }
  })();
  for (const entry of entries) {
    const target = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkChatAttachments(target, out);
      continue;
    }
    // 只处理目录里的真实文件：symlink 可能指向附件目录之外，交给引用校验拒绝。
    if (!entry.isFile()) continue;
    try {
      const info = statSync(target);
      out.push({ path: normalizeSlashes(target), size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // 扫描期间被删：跳过
    }
  }
}
