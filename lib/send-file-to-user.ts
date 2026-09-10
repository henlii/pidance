/**
 * Pidance file delivery executor. The SDK-specific tool wrapper lives in the
 * server-only SdkSessionHost; this module owns file validation and staging.
 */
import { constants, createReadStream, lstatSync, realpathSync, unlinkSync, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Readable } from "node:stream";
import { saveChatAttachmentStream, MESSAGE_MEDIA_MAX_BYTES } from "./chat-attachments";
import { getAllowedFileRoots, isFileAccessUnrestricted, isFilePathAllowed } from "./file-access";
import { getAudioMime, getDocumentMime, getFileExt, getImageMime, getVideoMime } from "./file-types";
import { normalizeBinaryMessageInput } from "./message-binary-store";
import type { BinaryMessageInput } from "./types";

export const SEND_FILE_TO_USER_TOOL_NAME = "send_file_to_user";

/**
 * This is deliberately code-owned instead of relying only on a user-editable
 * APPEND_SYSTEM.md. It remains present when a user supplies SYSTEM.md.
 */
export const PIDANCE_FILE_DELIVERY_SYSTEM_PROMPT = `## Pidance file delivery
When the \`send_file_to_user\` tool is available and you create a file that the user needs to view, download, or play, call it instead of only printing a local path or embedding Base64. The tool publishes a user-visible attachment message: images keep the original for preview and download, audio/video follow the UI playback size policy, and other files get a download card. Only claim that a file was sent after the tool returns success.`;

export function appendPidanceFileDeliveryPrompt(base: string[]): string[] {
  return base.some((entry) => entry === PIDANCE_FILE_DELIVERY_SYSTEM_PROMPT)
    ? base
    : [...base, PIDANCE_FILE_DELIVERY_SYSTEM_PROMPT];
}

/** Plain JSON Schema; the SDK adapter applies the narrow ToolDefinition type. */
export const SEND_FILE_TO_USER_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      description: "Absolute or current-project-relative path of the file to deliver.",
    },
    name: {
      type: "string",
      description: "Optional filename shown to the user; the source basename is used by default.",
    },
  },
  required: ["path"],
} as const;

export type SendFileToUserParams = {
  path: string;
  name?: string;
};

export type SendFileDeliveryResult = {
  entryId: string;
  name: string;
  size: number;
};

export type SendFileToUserExecutorOptions = {
  cwd: string;
  agentDir: string;
  appendBinary: (input: BinaryMessageInput) => { entryId: string };
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("file delivery aborted");
}

function mimeForPath(filePath: string): string {
  return getImageMime(filePath)
    ?? getAudioMime(filePath)
    ?? getVideoMime(filePath)
    ?? getDocumentMime(filePath)
    ?? ({
      txt: "text/plain",
      md: "text/markdown",
      json: "application/json",
      csv: "text/csv",
      html: "text/html",
      xml: "application/xml",
      zip: "application/zip",
      gz: "application/gzip",
      tar: "application/x-tar",
    }[getFileExt(filePath)] ?? "application/octet-stream");
}

async function resolveSourcePath(value: unknown, cwd: string): Promise<{ path: string; stat: Stats }> {
  if (typeof value !== "string" || !value.trim()) throw new Error("path is required");
  const requested = resolve(cwd, value.trim());
  const allowedRoots = isFileAccessUnrestricted() ? null : await getAllowedFileRoots();
  if (allowedRoots && !isFilePathAllowed(requested, allowedRoots)) {
    throw new Error("file path is not allowed");
  }
  let requestedStat;
  try {
    requestedStat = lstatSync(requested);
  } catch {
    throw new Error("file not found");
  }
  if (requestedStat.isSymbolicLink()) throw new Error("symbolic-link sources are not allowed");
  if (!requestedStat.isFile()) throw new Error("path must be a regular file");

  let actual: string;
  try {
    actual = realpathSync(requested);
  } catch {
    throw new Error("file path could not be resolved");
  }
  if (allowedRoots && !isFilePathAllowed(actual, allowedRoots)) {
    throw new Error("file path is not allowed");
  }
  return { path: actual, stat: requestedStat };
}

export function createSendFileToUserExecutor(options: SendFileToUserExecutorOptions) {
  return async function sendFileToUser(
    params: SendFileToUserParams,
    signal?: AbortSignal,
  ): Promise<SendFileDeliveryResult> {
    throwIfAborted(signal);
    const source = await resolveSourcePath(params.path, options.cwd);
    const sourcePath = source.path;
    const sourceName = typeof params.name === "string" && params.name.trim()
      ? params.name.trim()
      : basename(sourcePath);

    // Open once and stream from the same descriptor after fstat. This avoids
    // copying through a second path lookup and makes size/type checks stable.
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const nonBlock = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
    const handle = await open(sourcePath, constants.O_RDONLY | noFollow | nonBlock);
    let saved: Awaited<ReturnType<typeof saveChatAttachmentStream>> | undefined;
    try {
      const sourceStat = await handle.stat();
      if (!sourceStat.isFile()) throw new Error("path must be a regular file");
      if (source.stat.dev !== 0 && source.stat.ino !== 0
        && (sourceStat.dev !== source.stat.dev || sourceStat.ino !== source.stat.ino)) {
        throw new Error("file changed during open");
      }
      if (sourceStat.size > MESSAGE_MEDIA_MAX_BYTES) {
        throw new Error(`file exceeds ${MESSAGE_MEDIA_MAX_BYTES} bytes`);
      }
      throwIfAborted(signal);
      const sourceStream = createReadStream("", { fd: handle.fd, autoClose: false, signal });
      saved = await saveChatAttachmentStream(
        sourceName,
        Readable.toWeb(sourceStream) as ReadableStream<Uint8Array>,
        options.agentDir,
        MESSAGE_MEDIA_MAX_BYTES,
      );
      throwIfAborted(signal);

      const binary = normalizeBinaryMessageInput({
        path: saved.path,
        name: saved.name,
        mimeType: mimeForPath(sourcePath),
        size: saved.size,
      }, options.agentDir);
      const { entryId } = options.appendBinary(binary);
      saved = undefined;
      return { entryId, name: binary.name, size: binary.size };
    } finally {
      await handle.close().catch(() => {});
      if (saved) {
        try { unlinkSync(saved.path); } catch { /* best effort cleanup */ }
      }
    }
  };
}
