/**
 * Typed agent message commands and prompt receipts.
 * Parsed at the Route/client trust boundary; Host uses the same shapes.
 */

import type { BinaryMessageInput } from "./types";
import { normalizeBinaryMimeType } from "./message-binary";
import { normalizeFollowUpItems, type FollowUpItem } from "./session-queue";

export const PROMPT_IMAGE_MAX_BASE64_BYTES = 4 * 1024 * 1024;

export type PromptImage = {
  type: "image";
  data: string;
  mimeType: string;
};

export type PromptBinaryBlock = BinaryMessageInput;

export type PromptCommand = {
  type: "prompt";
  message: string;
  submissionId: string;
  images?: PromptImage[];
  binaryBlocks?: PromptBinaryBlock[];
};

export type AbortCommand = {
  type: "abort";
};

export type SteerCommand = {
  type: "steer";
  message: string;
  submissionId: string;
  images?: PromptImage[];
};

export type FollowUpCommand = {
  type: "follow_up";
  message: string;
  submissionId: string;
  images?: PromptImage[];
};

/** 整包写入等待队列：客户端传正文（可带图片引用/新图 base64），条目身份由 Host 对齐。 */
export type SetFollowUpQueueCommand = {
  type: "set_follow_up_queue";
  items: QueueItemPayload[];
  expectedRevision: number | null;
  submissionId: string;
};

/**
 * 原子「整队转引导」：清队与投递是同一个服务端用例。
 *
 * 浏览器不再「清队 → 发 steer → 失败回填」——那个补偿 saga 会把 A 的队列写到 B，
 * 也无法判断清队之后在途批次是否已经投递。
 */
export type DispatchFollowUpQueueCommand = {
  type: "dispatch_follow_up_queue";
  /** 输入框内容，并入队尾后一起发送。 */
  extra?: string;
  expectedRevision: number | null;
  submissionId: string;
};

export type TypedMessageCommand =
  | PromptCommand
  | AbortCommand
  | SteerCommand
  | FollowUpCommand
  | SetFollowUpQueueCommand
  | DispatchFollowUpQueueCommand;

/** 回执状态：`queued` 表示载荷已被可靠持久化到产品队列，不是失败。 */
export type PromptReceiptStatus = "accepted" | "queued" | "rejected";

/** 实际生效的动作。与用户 intent 不同时（如空闲引导转 prompt）必须显式给出。 */
export type PromptEffectiveAction = "prompt" | "steer" | "queued";

/**
 * 拒绝/入队原因。客户端不得把「任何 rejected」都解释成「应该排队」：
 * 无模型、鉴权失败、扩展命令错误与 busy 是完全不同的处置。
 */
export type PromptReason =
  | "busy"
  | "compacting"
  | "bash"
  | "media"
  | "locked"
  | "model"
  | "auth"
  | "extension"
  | "error";

/** 这些原因代表「稍后可自动发送」：内容应留在队列里而不是丢掉或当错误。 */
export function isQueueablePromptReason(reason: PromptReason | undefined): boolean {
  return reason === "busy" || reason === "compacting" || reason === "bash";
}

export type PromptReceipt = {
  submissionId: string;
  sessionId: string;
  status: PromptReceiptStatus;
  /** 实际生效动作（steer 回执、空闲引导转 prompt、入队）。 */
  action?: PromptEffectiveAction;
  reason?: PromptReason;
  /** 权威队列快照（入队/冲突时附带），含条目身份与在途正文。 */
  queue?: { items: FollowUpItem[]; revision: number; inFlight: string[] };
};

/**
 * 队列回执的公共基底。
 *
 * items = 客户端可见条目（waiting + unknown，含 id）；inFlight = 已提交给 Pi、
 * 尚未拿到受理结果的正文。清队不会动 inFlight：把在途批次当成取消成功是撒谎。
 */
type QueueReceiptBase = { revision: number; items: FollowUpItem[]; inFlight: string[] };

/** 队列写入回执。 */
export type QueueWriteReceipt =
  | ({ ok: true } & QueueReceiptBase)
  | ({ ok: false; conflict: true; reason: "revision" } & QueueReceiptBase)
  /**
   * 落盘失败（队列或条目图片）：内存未变，调用方不得声称已入队。
   *
   * 图片落盘失败与队列落盘失败对用户是同一件事（内容没被可靠保存），因此共用
   * 这个回执，而不是新增一种客户端还得单独处置的失败形态。
   */
  | ({ ok: false; persist: true } & QueueReceiptBase);

export type QueueDispatchReceipt =
  | ({ ok: true; status: "accepted"; action: "prompt" | "steer" | "queued" } & QueueReceiptBase)
  | ({ ok: false; status: "rejected"; reason: PromptReason } & QueueReceiptBase)
  | ({ ok: false; conflict: true; reason: "revision" | "in-flight" } & QueueReceiptBase);

/**
 * 把 Host/SDK 抛出的错误消息归类成结构化原因。
 *
 * 只做保守映射：无法确定的一律 `error`，客户端不得据此排队或重发。
 */
export function classifyPromptRejection(error: unknown): PromptReason {
  const message = error instanceof Error ? error.message : String(error);
  if (/already processing|already running|streamingBehavior/i.test(message)) return "busy";
  if (/shell command is running/i.test(message)) return "bash";
  if (/compaction/i.test(message)) return "compacting";
  if (/cannot be queued|Extension command/i.test(message)) return "extension";
  if (/no (valid )?model|model not found|未选择模型/i.test(message)) return "model";
  if (/401|403|unauthor|api key|authentication|permission denied/i.test(message)) return "auth";
  if (/running lease|locked by another|another process/i.test(message)) return "locked";
  return "error";
}

export function generateSubmissionId(
  makeId: () => string = defaultSubmissionId,
): string {
  return makeId();
}

function defaultSubmissionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `sub-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function parsePromptImages(value: unknown): PromptImage[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("images must be an array");
  }
  const images: PromptImage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      throw new Error("invalid image");
    }
    const record = item as Record<string, unknown>;
    const data = typeof record.data === "string" ? record.data : undefined;
    const rawMimeType = typeof record.mimeType === "string"
      ? record.mimeType
      : typeof record.mime_type === "string" ? record.mime_type : undefined;
    const mimeType = normalizeBinaryMimeType(rawMimeType);
    if (!data || !mimeType?.startsWith("image/")) {
      throw new Error("invalid image");
    }
    if (data.length > PROMPT_IMAGE_MAX_BASE64_BYTES) {
      throw new Error("invalid image: payload too large");
    }
    images.push({ type: "image", data, mimeType });
  }
  return images;
}

export function parsePromptBinaryBlocks(value: unknown): PromptBinaryBlock[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("binaryBlocks must be an array");
  if (value.length > 32) throw new Error("too many binary blocks");
  const blocks: PromptBinaryBlock[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("invalid binary block");
    }
    const record = item as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path.trim() : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const mimeType = normalizeBinaryMimeType(record.mimeType);
    const size = record.size;
    const previewPath = record.previewPath === undefined
      ? undefined
      : typeof record.previewPath === "string" ? record.previewPath.trim() : null;
    if (!path || !name || !mimeType || !Number.isSafeInteger(size) || (size as number) < 0 || previewPath === null) {
      throw new Error("invalid binary block");
    }
    blocks.push({
      path,
      name,
      mimeType,
      size: size as number,
      ...(previewPath ? { previewPath } : {}),
    });
  }
  return blocks;
}

function requireMessage(body: Record<string, unknown>): string {
  if (typeof body.message !== "string") {
    throw new Error("message is required");
  }
  return body.message;
}

export function parsePromptCommand(
  body: Record<string, unknown>,
  makeId: () => string = defaultSubmissionId,
): PromptCommand {
  const message = requireMessage(body);
  const submissionId = typeof body.submissionId === "string" && body.submissionId.trim()
    ? body.submissionId.trim()
    : makeId();
  return {
    type: "prompt",
    message,
    submissionId,
    images: parsePromptImages(body.images),
    binaryBlocks: parsePromptBinaryBlocks(body.binaryBlocks),
  };
}

export function parseAbortCommand(): AbortCommand {
  return { type: "abort" };
}

function submissionIdOf(body: Record<string, unknown>, makeId: () => string): string {
  return typeof body.submissionId === "string" && body.submissionId.trim()
    ? body.submissionId.trim()
    : makeId();
}

/** 队列 CAS 基线：缺失/非法一律视为「没有基线」（首写）。 */
export function parseExpectedRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseSteerCommand(
  body: Record<string, unknown>,
  makeId: () => string = defaultSubmissionId,
): SteerCommand {
  return {
    type: "steer",
    message: requireMessage(body),
    submissionId: submissionIdOf(body, makeId),
    images: parsePromptImages(body.images),
  };
}

export function parseFollowUpCommand(
  body: Record<string, unknown>,
  makeId: () => string = defaultSubmissionId,
): FollowUpCommand {
  return {
    type: "follow_up",
    message: requireMessage(body),
    submissionId: submissionIdOf(body, makeId),
    images: parsePromptImages(body.images),
  };
}

/** 队列条目的图片载荷：新图走 base64，已入库的图按引用回传。 */
export type QueueItemImagePayload =
  | { source: "data"; data: string; mimeType: string; name?: string }
  | { source: "ref"; id: string; path: string; mimeType: string; name: string };

export type QueueItemPayload = {
  text: string;
  images?: QueueItemImagePayload[];
};

function parseQueueItemImages(value: unknown): QueueItemImagePayload[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("invalid queue image");
  if (value.length === 0) return undefined;
  const images: QueueItemImagePayload[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("invalid queue image");
    }
    const record = entry as Record<string, unknown>;
    const mimeType = normalizeBinaryMimeType(
      typeof record.mimeType === "string" ? record.mimeType : undefined,
    );
    if (!mimeType?.startsWith("image/")) throw new Error("invalid queue image");
    const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : undefined;
    if (typeof record.data === "string" && record.data.length > 0) {
      if (record.data.length > PROMPT_IMAGE_MAX_BASE64_BYTES) {
        throw new Error("invalid queue image: payload too large");
      }
      images.push({ source: "data", data: record.data, mimeType, ...(name ? { name } : {}) });
      continue;
    }
    const path = typeof record.path === "string" ? record.path.trim() : "";
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!path || !id) throw new Error("invalid queue image");
    images.push({ source: "ref", id, path, mimeType, name: name ?? id });
  }
  return images.length ? images : undefined;
}

/**
 * 队列条目解码：字符串是旧格式（只有正文），对象可带图片。
 *
 * 非字符串且非对象的条目一律拒绝：旧行为是静默丢弃，于是「发错了格式」变成一次
 * **空队列写入**，把用户未投递的消息悄悄清掉（issue #42 关注的正是这类静默丢失）。
 */
export function parseSetFollowUpQueueCommand(
  body: Record<string, unknown>,
  makeId: () => string = defaultSubmissionId,
): SetFollowUpQueueCommand {
  if (body.items !== undefined && !Array.isArray(body.items)) {
    throw new Error("items must be an array");
  }
  const items: QueueItemPayload[] = [];
  for (const entry of Array.isArray(body.items) ? body.items : []) {
    if (typeof entry === "string") {
      if (!entry.trim()) throw new Error("items must not contain empty text");
      items.push({ text: entry });
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("items must be strings or { text, images? } objects");
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.text !== "string") {
      throw new Error("items must be strings or { text, images? } objects");
    }
    const images = parseQueueItemImages(record.images);
    // 纯图消息（正文为空）是合法的：UI 允许只发图；空正文且无图才是空条目。
    if (!record.text.trim() && !images?.length) {
      throw new Error("items must not be empty");
    }
    items.push({ text: record.text, ...(images ? { images } : {}) });
  }
  return {
    type: "set_follow_up_queue",
    items,
    expectedRevision: parseExpectedRevision(body.expectedRevision),
    submissionId: submissionIdOf(body, makeId),
  };
}

export function parseDispatchFollowUpQueueCommand(
  body: Record<string, unknown>,
  makeId: () => string = defaultSubmissionId,
): DispatchFollowUpQueueCommand {
  const extra = typeof body.extra === "string" ? body.extra : undefined;
  return {
    type: "dispatch_follow_up_queue",
    ...(extra !== undefined ? { extra } : {}),
    expectedRevision: parseExpectedRevision(body.expectedRevision),
    submissionId: submissionIdOf(body, makeId),
  };
}

export function isTypedMessageCommandType(type: string): boolean {
  return type === "prompt"
    || type === "abort"
    || type === "steer"
    || type === "follow_up"
    || type === "set_follow_up_queue"
    || type === "dispatch_follow_up_queue";
}

export function parseTypedMessageCommand(
  body: unknown,
  makeId: () => string = defaultSubmissionId,
): TypedMessageCommand {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("command is required");
  }
  const record = body as Record<string, unknown>;
  const type = record.type;
  if (type === "prompt") return parsePromptCommand(record, makeId);
  if (type === "abort") return parseAbortCommand();
  if (type === "steer") return parseSteerCommand(record, makeId);
  if (type === "follow_up") return parseFollowUpCommand(record, makeId);
  if (type === "set_follow_up_queue") return parseSetFollowUpQueueCommand(record, makeId);
  if (type === "dispatch_follow_up_queue") return parseDispatchFollowUpQueueCommand(record, makeId);
  throw new Error(`Unsupported message command: ${String(type)}`);
}
