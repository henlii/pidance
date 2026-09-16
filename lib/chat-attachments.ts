/**
 * 聊天附件存储：独立目录 ~/.pi/agent/pidance-attachments/
 * 不依赖项目 cwd；路径注入 prompt 后由 agent 自行 read；
 * /api/files 预览需把该目录加入 allow-list。
 */

import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
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
 * 排队消息的图片暂存区：`pidance-attachments/queue-outbox/<sessionId>/`。
 *
 * 队列条目要活到投递时（可能跨重启/跨标签），而浏览器只把安全尺寸图片的 base64
 * 交给 Host；把字节落成文件、条目里只存引用，才是可序列化且不撞偏好文件体积的做法。
 * 按会话分目录：提交队列时只扫本会话目录，别的会话的条目不受影响。
 */
export const QUEUE_OUTBOX_DIR_NAME = "queue-outbox";

/** 会话目录名白名单：pi 的 session id 是 uuid v7；反例（`..`、分隔符）直接拒绝。 */
function assertSafeSessionKey(sessionId: string): string {
  const key = sessionId.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) {
    throw new Error("invalid session id for queue media");
  }
  return key;
}

export function getQueueOutboxDir(sessionId: string, agentDir: string = getAgentDir()): string {
  return normalizeSlashes(join(ensureChatAttachmentsDir(agentDir), QUEUE_OUTBOX_DIR_NAME, assertSafeSessionKey(sessionId)));
}

export function ensureQueueOutboxDir(sessionId: string, agentDir: string = getAgentDir()): string {
  const dir = getQueueOutboxDir(sessionId, agentDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  allowFileRoot(dir);
  return dir;
}

export interface QueueMediaRef {
  /** 稳定身份 = 落盘文件名；客户端回传时按它复现同一份字节。 */
  id: string;
  path: string;
  mimeType: string;
  name: string;
}

function extensionForMimeType(mimeType: string): string {
  const subtype = mimeType.slice("image/".length).replace(/[^A-Za-z0-9.+-]/g, "");
  if (subtype === "jpeg") return "jpg";
  return subtype || "img";
}

/** 写入一份排队图片（自动原子落盘；调用方负责 MIME 与大小校验）。 */
export function saveQueueMediaBytes(
  sessionId: string,
  bytes: Buffer,
  mimeType: string,
  name = `image.${extensionForMimeType(mimeType)}`,
  agentDir: string = getAgentDir(),
): QueueMediaRef {
  const dir = ensureQueueOutboxDir(sessionId, agentDir);
  const storedName = uniqueAttachmentFileName(name);
  const target = join(dir, storedName);
  // 同目录临时文件 + rename：条目一旦可见就要求图已经完整存在（投递时回读到
  // 半截文件会把损坏的图发给模型），而直接 writeFileSync 在进程被杀时留下半截。
  const temp = join(dir, `.${storedName}.${randomUUID()}.part`);
  try {
    writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
    renameSync(temp, target);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // 临时文件没落下或已被清掉:目标达成
    }
    throw error;
  }
  return {
    id: storedName,
    path: normalizeSlashes(target),
    mimeType,
    name: sanitizeAttachmentFileName(name),
  };
}

/** 单张排队图片的最大字节数（安全尺寸副本；超出即客户端违约，拒绝而不是读进来）。 */
export const QUEUE_MEDIA_MAX_BYTES = 16 * 1024 * 1024;

/**
 * 路径是否属于本会话的 outbox（防「客户端给个路径就发任意文件给模型」）。
 *
 * 字面前缀不够：outbox 里一个指向别处的 symlink 会把任意文件变成「本会话的排队图」。
 * 真实父目录必须就是 outbox 本身。
 */
export function isQueueMediaPath(sessionId: string, path: string, agentDir: string = getAgentDir()): boolean {
  const dir = getQueueOutboxDir(sessionId, agentDir);
  const candidate = normalizeSlashes(path.trim());
  if (!candidate.startsWith(`${dir}/`)) return false;
  if (candidate.slice(dir.length + 1).includes("/")) return false;
  try {
    const realDir = realpathSync(dir);
    return dirname(realpathSync(candidate)) === realDir;
  } catch {
    // 文件不存在（或目录不存在）：不是有效引用
    return false;
  }
}

/** 回读排队图片为 base64；文件不存在/越界/非普通文件/过大返回 null。 */
export function readQueueMediaBase64(
  sessionId: string,
  path: string,
  agentDir: string = getAgentDir(),
): string | null {
  if (!isQueueMediaPath(sessionId, path, agentDir)) return null;
  try {
    const target = normalizeSlashes(path);
    // 只读普通文件，且限制尺寸：ref 路径来自持久化数据，不应无上限读进内存。
    if (!lstatSync(target).isFile()) return null;
    if (statSync(target).size > QUEUE_MEDIA_MAX_BYTES) return null;
    return readFileSync(target).toString("base64");
  } catch {
    return null;
  }
}

/** 删除单份排队图片（已投递/被清出队列）。 */
export function deleteQueueMedia(sessionId: string, path: string, agentDir: string = getAgentDir()): void {
  if (!isQueueMediaPath(sessionId, path, agentDir)) return;
  try {
    unlinkSync(normalizeSlashes(path));
  } catch {
    // 已经不存在即目标达成：清理是幂等的，不因竞态报错打断队列写入。
  }
}

/**
 * 清理本会话 outbox 中不再被队列引用的文件。
 *
 * 覆盖：取回/清队/投递完成/崩溃遗留（hydrate 时队列已无该条目）。识别不了的
 * 目录（别的会话）不碰。
 */
export function sweepQueueOutbox(
  sessionId: string,
  keepPaths: Iterable<string>,
  agentDir: string = getAgentDir(),
): number {
  const dir = getQueueOutboxDir(sessionId, agentDir);
  if (!existsSync(dir)) return 0;
  const keep = new Set([...keepPaths].map((path) => normalizeSlashes(path)));
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const target = normalizeSlashes(join(dir, entry));
    if (keep.has(target)) continue;
    try {
      unlinkSync(target);
      removed += 1;
    } catch {
      // 目录项删除失败（权限/竞态）：留给下一次 sweep，不抛出打断提交。
    }
  }
  return removed;
}

/** 会话删除：整目录清掉。 */
export function removeQueueOutboxDir(sessionId: string, agentDir: string = getAgentDir()): void {
  const dir = getQueueOutboxDir(sessionId, agentDir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 尽力而为：会话已删，残留文件由下次 sweep 处理。
  }
}
