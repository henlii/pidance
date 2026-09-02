/**
 * Typed agent message commands and prompt receipts.
 * Parsed at the Route/client trust boundary; Host uses the same shapes.
 */

export type PromptImage = {
  type: "image";
  data: string;
  mimeType: string;
};

export type PromptCommand = {
  type: "prompt";
  message: string;
  submissionId: string;
  images?: PromptImage[];
};

export type AbortCommand = {
  type: "abort";
};

export type SteerCommand = {
  type: "steer";
  message: string;
  images?: PromptImage[];
};

export type FollowUpCommand = {
  type: "follow_up";
  message: string;
  images?: PromptImage[];
};

export type TypedMessageCommand = PromptCommand | AbortCommand | SteerCommand | FollowUpCommand;

export type PromptReceiptStatus = "accepted" | "rejected";

export type PromptReceipt = {
  submissionId: string;
  sessionId: string;
  status: PromptReceiptStatus;
};

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
    const mimeType = typeof record.mimeType === "string"
      ? record.mimeType
      : typeof record.mime_type === "string" ? record.mime_type : undefined;
    if (!data || !mimeType) {
      throw new Error("invalid image");
    }
    images.push({ type: "image", data, mimeType });
  }
  return images;
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
  };
}

export function parseAbortCommand(): AbortCommand {
  return { type: "abort" };
}

export function parseSteerCommand(body: Record<string, unknown>): SteerCommand {
  return {
    type: "steer",
    message: requireMessage(body),
    images: parsePromptImages(body.images),
  };
}

export function parseFollowUpCommand(body: Record<string, unknown>): FollowUpCommand {
  return {
    type: "follow_up",
    message: requireMessage(body),
    images: parsePromptImages(body.images),
  };
}

export function isTypedMessageCommandType(type: string): boolean {
  return type === "prompt" || type === "abort" || type === "steer" || type === "follow_up";
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
  if (type === "steer") return parseSteerCommand(record);
  if (type === "follow_up") return parseFollowUpCommand(record);
  throw new Error(`Unsupported message command: ${String(type)}`);
}
