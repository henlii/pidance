/**
 * Pidance UI-only binary message blocks.
 *
 * Pi's native message schema only carries text/images. Binary bytes stay in the
 * chat attachment store; the Pi `custom` entry contains only this small,
 * display-only descriptor and is ignored by the LLM context.
 */
import type {
  BinaryMessageData,
  BinaryMessageInput,
  BinaryMessageKind,
  CustomMessage,
} from "./types";

export const PIDANCE_BINARY_CUSTOM_TYPE = "pidance.binary";
export const PIDANCE_BINARY_VERSION = 1 as const;
export const BINARY_MESSAGE_MAX_NAME_LENGTH = 180;
export const BINARY_MESSAGE_MAX_PATH_LENGTH = 4_096;

const MIME_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

export function binaryKindFromMime(mimeType: string): BinaryMessageKind {
  const normalized = mimeType.toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  return "file";
}

export function normalizeBinaryMimeType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const mimeType = value.trim().toLowerCase();
  return MIME_TYPE_RE.test(mimeType) ? mimeType : null;
}

export function normalizeBinaryName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\\/\0]/g, "_").trim();
  if (!name || name.length > BINARY_MESSAGE_MAX_NAME_LENGTH) return null;
  return name;
}

/**
 * 读取 Pi custom entry 中的二进制描述符。读取侧 fail closed，坏条目不会
 * 阻断整个会话历史。
 */
export function parseBinaryMessageData(value: unknown): BinaryMessageData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "binary" || record.version !== PIDANCE_BINARY_VERSION) return null;
  if (typeof record.path !== "string") return null;
  const path = record.path.trim();
  if (!path || path.length > BINARY_MESSAGE_MAX_PATH_LENGTH) return null;
  const name = normalizeBinaryName(record.name);
  const mimeType = normalizeBinaryMimeType(record.mimeType);
  if (!name || !mimeType) return null;
  if (typeof record.size !== "number" || !Number.isSafeInteger(record.size) || record.size < 0) return null;
  const kind = record.kind;
  if (kind !== "image" && kind !== "audio" && kind !== "video" && kind !== "file") return null;
  if (kind !== binaryKindFromMime(mimeType)) return null;

  const previewPath = record.previewPath === undefined
    ? undefined
    : typeof record.previewPath === "string" && record.previewPath.trim().length <= BINARY_MESSAGE_MAX_PATH_LENGTH
      ? record.previewPath.trim() || undefined
      : null;
  if (previewPath === null) return null;

  const messageEntryId = record.messageEntryId === undefined
    ? undefined
    : typeof record.messageEntryId === "string" && record.messageEntryId.trim()
      ? record.messageEntryId.trim()
      : null;
  if (messageEntryId === null) return null;

  return {
    type: "binary",
    version: PIDANCE_BINARY_VERSION,
    kind,
    path,
    name,
    mimeType,
    size: record.size,
    ...(previewPath ? { previewPath } : {}),
    ...(messageEntryId ? { messageEntryId } : {}),
  };
}

export function binaryMessageToUiMessage(
  data: BinaryMessageData,
  timestamp?: number,
): CustomMessage {
  const message: CustomMessage = {
    role: "custom",
    customType: PIDANCE_BINARY_CUSTOM_TYPE,
    content: data.name,
    display: true,
    details: data,
  };
  if (timestamp !== undefined) message.timestamp = timestamp;
  return message;
}

export function binaryInputToData(
  input: BinaryMessageInput,
  messageEntryId?: string,
): BinaryMessageData {
  const mimeType = normalizeBinaryMimeType(input.mimeType) ?? "application/octet-stream";
  const name = normalizeBinaryName(input.name) ?? "file";
  const path = input.path.trim();
  const size = Number.isSafeInteger(input.size) && input.size >= 0 ? input.size : 0;
  const previewPath = input.previewPath?.trim() || undefined;
  return {
    type: "binary",
    version: PIDANCE_BINARY_VERSION,
    kind: binaryKindFromMime(mimeType),
    path,
    name,
    mimeType,
    size,
    ...(previewPath ? { previewPath } : {}),
    ...(messageEntryId ? { messageEntryId } : {}),
  };
}
