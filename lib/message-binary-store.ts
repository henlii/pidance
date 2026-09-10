/** Server-side validation for Pidance UI-only binary message descriptors. */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { getAgentDir } from "./pi-paths";
import {
  ensureChatAttachmentsDir,
  sanitizeAttachmentFileName,
} from "./chat-attachments";
import {
  binaryInputToData,
  normalizeBinaryMimeType,
} from "./message-binary";
import type { BinaryMessageData, BinaryMessageInput } from "./types";

export class BinaryMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BinaryMessageError";
  }
}

function resolveStoredPath(value: string, agentDir: string): { path: string; size: number } {
  const root = realpathSync(ensureChatAttachmentsDir(agentDir));
  let actual: string;
  try {
    actual = realpathSync(resolve(value));
  } catch {
    throw new BinaryMessageError("binary media file not found");
  }
  const escaped = relative(root, actual);
  if (!escaped || escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
    throw new BinaryMessageError("binary media path is not allowed");
  }
  let stat;
  try {
    stat = statSync(actual);
  } catch {
    throw new BinaryMessageError("binary media file not found");
  }
  if (!stat.isFile()) throw new BinaryMessageError("binary media must be a file");
  return { path: actual.replace(/\\/g, "/"), size: stat.size };
}

export function normalizeBinaryMessageInput(
  input: BinaryMessageInput,
  agentDir: string = getAgentDir(),
  messageEntryId?: string,
): BinaryMessageData {
  if (!input || typeof input !== "object") throw new BinaryMessageError("invalid binary block");
  if (typeof input.name !== "string" || !input.name.trim() || typeof input.path !== "string" || !input.path.trim()) {
    throw new BinaryMessageError("invalid binary block");
  }
  const mimeType = normalizeBinaryMimeType(input.mimeType);
  if (!mimeType) throw new BinaryMessageError("invalid binary MIME type");
  const name = sanitizeAttachmentFileName(input.name);
  if (!name) throw new BinaryMessageError("binary file name is required");
  const original = resolveStoredPath(input.path, agentDir);
  const preview = input.previewPath
    ? resolveStoredPath(input.previewPath, agentDir)
    : undefined;
  return binaryInputToData(
    {
      path: original.path,
      name,
      mimeType,
      size: original.size,
      ...(preview ? { previewPath: preview.path } : {}),
    },
    messageEntryId,
  );
}

export function normalizeBinaryMessageInputs(
  inputs: BinaryMessageInput[] | undefined,
  agentDir: string = getAgentDir(),
): BinaryMessageData[] {
  if (!inputs || inputs.length === 0) return [];
  if (inputs.length > 32) throw new BinaryMessageError("too many binary blocks");
  return inputs.map((input) => normalizeBinaryMessageInput(input, agentDir));
}
