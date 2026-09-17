/**
 * Typed agent message commands and prompt receipts.
 * Parsed at the Route/client trust boundary; Host uses the same shapes.
 */

import type { BinaryMessageInput } from "./types";
import { normalizeBinaryMimeType } from "./message-binary";
import {
  MAX_QUEUED_ITEM_MEDIA,
  normalizeFollowUpItems,
  parseAttemptId,
  parseFollowUpItemId,
  type FollowUpItem,
  type QueueItemPayload,
  type QueuedMediaRef,
} from "./session-queue";

export type { QueueItemPayload, QueuedMediaRef } from "./session-queue";

export const PROMPT_IMAGE_MAX_BASE64_BYTES = 4 * 1024 * 1024;

/**
 * 模型图片引用：字节已经在 Pidance 附件目录里（输入框选图即上传）。
 *
 * 引入它的原因：草稿/队列/取回都只持引用，客户端不必为了再发一次而重新
 * 读回 base64；内联图片只用于旧客户端与扩展直调。
 */
export type PromptImageRef = {
  type: "ref";
  path: string;
  mimeType: string;
};

export type PromptImage = {
  type: "image";
  data: string;
  mimeType: string;
};

/** 提交给 Host 的图片输入：内联 base64，或附件目录里的引用。 */
export type PromptImageInput = PromptImage | PromptImageRef;

export type PromptBinaryBlock = BinaryMessageInput;

export type PromptCommand = {
  type: "prompt";
  message: string;
  submissionId: string;
  images?: PromptImageInput[];
  binaryBlocks?: PromptBinaryBlock[];
};

export type AbortCommand = {
  type: "abort";
};

export type SteerCommand = {
  type: "steer";
  message: string;
  submissionId: string;
  images?: PromptImageInput[];
};

export type FollowUpCommand = {
  type: "follow_up";
  message: string;
  submissionId: string;
  images?: PromptImageInput[];
};

/** 整包写入等待队列：客户端传正文 + 该条目的媒体引用，条目身份由 Host 对齐。 */
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
  /** 上面那段 extra 的写入尝试令牌（未入队时客户端据此恢复，不靠正文猜）。 */
  extraAttemptId?: string;
  expectedRevision: number | null;
  submissionId: string;
};

/**
 * 条目级召回：把指定条目**原子地**从等待队列取回到草稿（issue #42 / H2）。
 *
 * 为什么不是「清空整队」：清队不能证明「我捕获的那几条已经移交」，期间被别的
 * 视图整队投递（claimed）的条目根本不可撤回。只按 itemIds 取，回执回报实际取回
 * 的条目，客户端才能只把确认移交的内容放进可重发草稿。
 */
export type RecallFollowUpQueueCommand = {
  type: "recall_follow_up_queue";
  itemIds: string[];
  submissionId: string;
};

export type TypedMessageCommand =
  | PromptCommand
  | AbortCommand
  | SteerCommand
  | FollowUpCommand
  | SetFollowUpQueueCommand
  | DispatchFollowUpQueueCommand
  | RecallFollowUpQueueCommand;

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
type QueueReceiptBase = {
  revision: number;
  items: FollowUpItem[];
  inFlight: string[];
  /**
   * Host 已受理的写入尝试令牌（有界）。
   *
   * 客户端用它回答「我这次写入被受理了吗」：在列 → 队列持有内容，一律不得再
   * 恢复成可重发副本；不在列 → 从未移交，必须归还草稿。请求成功/失败本身不构成证据。
   */
  admittedAttemptIds?: string[];
};

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

type QueueRecallBase = QueueReceiptBase & {
  /** 真正从队列移除（成功移交回草稿）的条目。 */
  recalled: FollowUpItem[];
  /** 未能取回的条目及原因；`missing` = 已被别的写入移除。 */
  skipped: { id: string; reason: "claimed" | "unknown" | "missing" }[];
};

/**
 * 召回回执：`recalled` 是唯一可以变成可重发草稿的凭据。
 *
 * 落盘失败（persist）时内存未变：请求方不得把撤回当成成功。
 */
export type QueueRecallReceipt =
  | ({ ok: true } & QueueRecallBase)
  | ({ ok: false; persist: true } & QueueRecallBase);

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

export function parsePromptImages(value: unknown): PromptImageInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("images must be an array");
  }
  const images: PromptImageInput[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      throw new Error("invalid image");
    }
    const record = item as Record<string, unknown>;
    if (record.type === "ref") {
      const path = typeof record.path === "string" ? record.path.trim() : "";
      const refMime = normalizeBinaryMimeType(
        typeof record.mimeType === "string" ? record.mimeType : undefined,
      );
      if (!path || !refMime?.startsWith("image/")) throw new Error("invalid image");
      images.push({ type: "ref", path, mimeType: refMime });
      continue;
    }
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
  if (value === undefined || value === null) return null;
  // 非法值不得静默降级成「不做 CAS」：那会让过期写入覆盖服务端权威队列
  // （另一个标签页刚追加的消息）。类型错误一律按 400 回绝。
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("expectedRevision must be a non-negative number");
  }
  return value;
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

/**
 * 队列条目的媒体引用解码：条目只持引用（字节在附件目录里）。
 *
 * 结构不合格就报错，而不是静默丢掉几条引用：丢掉会让被丢的副本变成孤儿
 * （接着被回收），也会让投递少发用户排队的内容。
 */
function parseQueueItemMedia(value: unknown): QueuedMediaRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("invalid queue media");
  if (value.length === 0) return undefined;
  if (value.length > MAX_QUEUED_ITEM_MEDIA) throw new Error("invalid queue media: too many refs");
  const media: QueuedMediaRef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("invalid queue media");
    }
    const record = entry as Record<string, unknown>;
    const role = record.role === "model" || record.role === "original" ? record.role : null;
    const path = typeof record.path === "string" ? record.path.trim() : "";
    if (!role || !path) throw new Error("invalid queue media");
    const mimeType = normalizeBinaryMimeType(
      typeof record.mimeType === "string" ? record.mimeType : undefined,
    );
    if (!mimeType) throw new Error("invalid queue media");
    // 模型副本必须是图片：投递时它会被当作内联图片交给 SDK，其他类型只可能是误传。
    if (role === "model" && !mimeType.startsWith("image/")) throw new Error("invalid queue media");
    const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : "";
    const size = record.size;
    if (!name || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("invalid queue media");
    }
    const previewPath = typeof record.previewPath === "string" ? record.previewPath.trim() : undefined;
    if (record.previewPath !== undefined && !previewPath) throw new Error("invalid queue media");
    media.push({
      role,
      path,
      name,
      mimeType,
      size,
      ...(previewPath && previewPath !== path ? { previewPath } : {}),
    });
  }
  return media.length ? media : undefined;
}

/**
 * 队列条目解码：字符串是旧格式（只有正文），对象可带媒体引用。
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
      throw new Error("items must be strings or { text, media? } objects");
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.text !== "string") {
      throw new Error("items must be strings or { text, media? } objects");
    }
    const media = parseQueueItemMedia(record.media);
    // 纯图消息（正文为空）是合法的：UI 允许只发图；空正文且无媒体才是空条目。
    if (!record.text.trim() && !media?.length) {
      throw new Error("items must not be empty");
    }
    // 客户端身份是可选的（旧客户端/旧脚本不带）；带了就必须合法，不能静默丢弃——
    // 丢了会让失败处置重新靠正文猜身份。
    let clientId: string | undefined;
    if (record.attemptId !== undefined) {
      clientId = parseAttemptId(record.attemptId) ?? undefined;
      if (!clientId) throw new Error("invalid item attemptId");
    }
    // 服务端条目身份同理：带了就必须合法。不许用它指向不存在的条目——
    // 那要么是陈旧快照，要么是伪造，两种都不应该被当成「就是这一条」。
    let itemId: string | undefined;
    if (record.id !== undefined) {
      itemId = parseFollowUpItemId(record.id) ?? undefined;
      if (!itemId) throw new Error("invalid item id");
    }
    items.push({
      text: record.text,
      ...(media ? { media } : {}),
      ...(clientId ? { attemptId: clientId } : {}),
      ...(itemId ? { id: itemId } : {}),
    });
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
  let extraAttemptId: string | undefined;
  if (body.extraAttemptId !== undefined) {
    extraAttemptId = parseAttemptId(body.extraAttemptId) ?? undefined;
    if (!extraAttemptId) throw new Error("invalid extraAttemptId");
  }
  return {
    type: "dispatch_follow_up_queue",
    ...(extra !== undefined ? { extra } : {}),
    ...(extraAttemptId ? { extraAttemptId } : {}),
    expectedRevision: parseExpectedRevision(body.expectedRevision),
    submissionId: submissionIdOf(body, makeId),
  };
}

/** 召回条目数上限（防御性边界：一次召回不可能是整队列的无界写入）。 */
export const MAX_RECALL_ITEM_IDS = 256;

export function parseRecallFollowUpQueueCommand(
  body: Record<string, unknown>,
  makeId: () => string = defaultSubmissionId,
): RecallFollowUpQueueCommand {
  if (!Array.isArray(body.itemIds)) throw new Error("itemIds must be an array");
  if (body.itemIds.length === 0) throw new Error("itemIds must not be empty");
  if (body.itemIds.length > MAX_RECALL_ITEM_IDS) throw new Error("too many itemIds");
  const itemIds: string[] = [];
  for (const entry of body.itemIds) {
    const id = typeof entry === "string" ? entry.trim() : "";
    if (!id) throw new Error("invalid itemId");
    if (!itemIds.includes(id)) itemIds.push(id);
  }
  return {
    type: "recall_follow_up_queue",
    itemIds,
    submissionId: submissionIdOf(body, makeId),
  };
}

export function isTypedMessageCommandType(type: string): boolean {
  return type === "prompt"
    || type === "abort"
    || type === "steer"
    || type === "follow_up"
    || type === "set_follow_up_queue"
    || type === "dispatch_follow_up_queue"
    || type === "recall_follow_up_queue";
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
  if (type === "recall_follow_up_queue") return parseRecallFollowUpQueueCommand(record, makeId);
  throw new Error(`Unsupported message command: ${String(type)}`);
}
