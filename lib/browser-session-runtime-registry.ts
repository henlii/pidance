/**
 * Page-level owner of per-session submit, EventStreamManager, run token, and
 * live timeline. ChatWindow unmount only detaches the view; it cannot cancel POST.
 */

import { setDraft } from "./draft-store";
import {
  createEventStreamManager,
  type AgentStreamEvent,
  type EventSourceLike,
  type EventStreamManager,
  type TimerHandle,
} from "./event-stream-manager";
import { pendingSessionId } from "./new-session-intent";
import type { PromptReceipt } from "./agent-commands";
import { generateSubmissionId } from "./agent-commands";
import { attachCustomRenderedLines } from "./custom-rendered-lines";
import { normalizeToolCalls } from "./normalize";
import { PIDANCE_BINARY_CUSTOM_TYPE, parseBinaryMessageData } from "./message-binary";
import { shouldFinishFromReconcile } from "./finish-agent-run";
import type { AgentMessage, AttachedImage, BinaryMessageData, BinaryMessageInput } from "./types";

export type SubmissionStatus = "submitting" | "accepted" | "persisted" | "rejected" | "unknown";

export type PromptSubmission = {
  submissionId: string;
  sessionId: string;
  draftKey: string;
  message: string;
  images?: AttachedImage[];
  binaryBlocks?: BinaryMessageInput[];
  status: SubmissionStatus;
  /** persisted 时对应 Pi JSONL user entry id；未确认前为 null */
  entryId?: string | null;
  error?: string;
};

export type StreamSnapshot = {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
};

export type SessionRuntimeSnapshot = {
  sessionId: string;
  messages: AgentMessage[];
  entryIds: string[];
  streamState: StreamSnapshot;
  agentRunning: boolean;
  sendInFlight: boolean;
  submissions: PromptSubmission[];
  promptRunId: number;
  /** 当前 run 的异步 finish claim；由 registry 而非视图 hook 持有。 */
  finishingRunId: number | null;
  /** 最近一个已收到 agent_end/prompt_done 的 run。 */
  completedRunId: number | null;
  attachCount: number;
  /** 消息 timeline 版本：仅当 messages/streaming 内容变化时递增；
   * connected/agent_start 等运行态事件不递增，避免阻塞初始磁盘 hydrate。 */
  timelineSeq: number;
};

export type RuntimeAgentState = {
  live?: boolean;
  running?: boolean;
  activeRun?: boolean;
  lockedByOther?: boolean;
  state?: {
    isStreaming?: boolean;
    isPromptRunning?: boolean;
    isCompacting?: boolean;
    [key: string]: unknown;
  };
};

export type RuntimeReconcileResult = {
  runId: number;
  stale: boolean;
  live: boolean;
  shouldFinish: boolean;
  state?: RuntimeAgentState["state"];
};

export type SubmitPromptTarget =
  | { kind: "persisted"; sessionId: string }
  | { kind: "new"; intentId: string; cwd: string };

export type SubmitPromptInput = {
  target: SubmitPromptTarget;
  submissionId?: string;
  message: string;
  images?: AttachedImage[];
  binaryBlocks?: BinaryMessageInput[];
  draftKey: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
};

export type SubmitPromptResult = {
  submissionId: string;
  sessionId: string;
  status: "accepted" | "rejected" | "unknown";
  error?: string;
};

export type BrowserSessionRuntimeRegistryDeps = {
  postPrompt: (
    sessionId: string,
    input: {
      message: string;
      images?: AttachedImage[];
      binaryBlocks?: BinaryMessageInput[];
      submissionId: string;
      signal?: AbortSignal;
    },
  ) => Promise<PromptReceipt>;
  ensureNewSession?: (
    cwd: string,
    extras?: { provider?: string; modelId?: string },
  ) => Promise<string>;
  /** 一步创建并发送（避免 ensure→wake→prompt 两跳：无文件 404 / 双行 / 闪）。 */
  createAndPrompt?: (cwd: string, input: {
    message: string;
    images?: AttachedImage[];
    binaryBlocks?: BinaryMessageInput[];
    submissionId: string;
    provider?: string;
    modelId?: string;
    thinkingLevel?: string;
    signal?: AbortSignal;
  }) => Promise<{ sessionId: string; receipt: PromptReceipt }>;
  wake?: (sessionId: string, signal?: AbortSignal) => Promise<void>;
  createEventStream?: (sessionId: string, onEvent: (event: AgentStreamEvent) => void) => EventStreamManager;
  getAgentState?: (sessionId: string) => Promise<RuntimeAgentState>;
  restoreDraft?: (draftKey: string, draft: { value: string; images: AttachedImage[] }) => void;
  now?: () => number;
  makeSubmissionId?: () => string;
  /** slot 空闲 SSE 关闭定时器（测试注入；生产 setTimeout/clearTimeout） */
  schedule?: (fn: () => void, ms: number) => TimerHandle;
  clearSchedule?: (id: TimerHandle) => void;
};

export type RegistrySubscription = {
  sessionId: string;
  dispose: () => void;
};

export type SubmitPromptCancellation = {
  submissionId: string;
  cancel: () => void;
  signal: AbortSignal;
};

type RuntimeSlot = {
  sessionId: string;
  snapshot: SessionRuntimeSnapshot;
  submissions: Map<string, PromptSubmission>;
  /** in-flight POST per submissionId（单飞）；结算后从 map 移除 */
  inFlight: Map<string, Promise<SubmitPromptResult>>;
  /** submissionId → AbortController（Stop 用） */
  promptAborts: Map<string, AbortController>;
  eventStream: EventStreamManager | null;
  viewHandlers: Set<(event: AgentStreamEvent) => void>;
  snapshotListeners: Set<(snapshot: SessionRuntimeSnapshot) => void>;
  attachCount: number;
  consumedEntryIds: Set<string>;
  /** submitPrompt 乐观消息的稳定位置；message_end 回来时按 submission 绑定 entryId */
  submissionMessageIndexes: Map<string, number>;
  /** slot-owned hydrate 请求（按发起序）的单调号 */
  hydrateSeq: number;
  /** 最近一次已应用 hydrate 的请求号 */
  hydrateAppliedSeq: number;
  /** 无视图且空闲时延迟关闭 SSE 的兜底定时器 */
  idleCloseTimer: TimerHandle | null;
  /** SSE 确连失败后的有限重试：当前定时器与已用次数 */
  sseRetryTimer: TimerHandle | null;
  sseRetryAttempt: number;
  /** 当前视图订阅是否在（attach/detach 计数 0/1 过渡用） */
  viewAttached: boolean;
};

/** slot 空闲 SSE 关闭兜底窗口：切走后留一小段时间给快速切回，随后释放服务端 host。 */
export const IDLE_SSE_CLOSE_DELAY_MS = 5_000;

export type BrowserSessionRuntimeRegistry = {
  getSnapshot(sessionId: string): SessionRuntimeSnapshot | null;
  subscribe(sessionId: string, listener: (snapshot: SessionRuntimeSnapshot) => void): () => void;
  attach(sessionId: string, onEvent?: (event: AgentStreamEvent) => void): RegistrySubscription;
  detach(sessionId: string, subscription: RegistrySubscription): void;
  submitPrompt(input: SubmitPromptInput): Promise<SubmitPromptResult>;
  /** 绑定当前 submissions 的取消槽位；cancel 只取消一个 submission */
  cancellationFor(sessionId: string): SubmitPromptCancellation | null;
  /** 显式 Stop：取消唯一在途 submission 的 POST 并等待结算 */
  abortSubmission(sessionId: string, submissionId?: string): Promise<SubmitPromptResult | null>;
  abort(sessionId: string): void;
  /** 当前 per-session run 状态；视图只读此 snapshot，不维护 sendInFlight 单槽。 */
  getRunState(sessionId: string): Pick<SessionRuntimeSnapshot, "promptRunId" | "agentRunning" | "sendInFlight" | "finishingRunId" | "completedRunId"> | null;
  beginRunFinish(sessionId: string, runId: number): boolean;
  releaseRunFinish(sessionId: string, runId: number): void;
  completeRun(sessionId: string, runId: number): boolean;
  reconcile(sessionId: string): Promise<RuntimeReconcileResult | null>;
  /** 在 HTTP context 发起前取得 slot-owned 请求代数。 */
  beginHydrate(sessionId: string): number;
  hydrate(
    sessionId: string,
    messages: AgentMessage[],
    entryIds?: string[],
    options?: { sinceSeq?: number; hydrateRequestSeq?: number },
  ): boolean;
  appendLocal(sessionId: string, message: AgentMessage): void;
  applyEvent(sessionId: string, event: AgentStreamEvent): void;
  ensureEventsConnected(sessionId: string): void;
  getEventSource(sessionId: string): EventSourceLike | null;
  getSubmission(sessionId: string, submissionId: string): PromptSubmission | undefined;
  /** 冷挂载/刷新时把服务端已在跑的 run 导入 slot（防止 reconcile 误收尾、发送被拒）。 */
  importRunningRun(sessionId: string, startedAt?: number): void;
  /** 测试用：重置单例 */
  resetForTests(): void;
};

function emptyStream(): StreamSnapshot {
  return { isStreaming: false, streamingMessage: null };
}

function createSlot(sessionId: string): RuntimeSlot {
  return {
    sessionId,
    snapshot: {
      sessionId,
      messages: [],
      entryIds: [],
      streamState: emptyStream(),
      agentRunning: false,
      sendInFlight: false,
      submissions: [],
      promptRunId: 0,
      finishingRunId: null,
      completedRunId: null,
      attachCount: 0,
      timelineSeq: 0,
    },
    submissions: new Map(),
    inFlight: new Map(),
    promptAborts: new Map(),
    eventStream: null,
    viewHandlers: new Set(),
    snapshotListeners: new Set(),
    attachCount: 0,
    consumedEntryIds: new Set(),
    submissionMessageIndexes: new Map(),
    hydrateSeq: 0,
    hydrateAppliedSeq: 0,
    idleCloseTimer: null,
    sseRetryTimer: null,
    sseRetryAttempt: 0,
    viewAttached: false,
  };
}

function userMessageFromSubmit(
  message: string,
  images: AttachedImage[] | undefined,
  binaryBlocks: BinaryMessageInput[] | undefined,
  now: number,
): AgentMessage {
  const imageBlocks = images?.map((img) => ({
    type: "image" as const,
    source: { type: "base64" as const, media_type: img.mimeType, data: img.data },
  }));
  const projected: AgentMessage & { binaryBlocks?: BinaryMessageData[] } = {
    role: "user",
    content: imageBlocks?.length
      ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
      : message,
    timestamp: now,
  };
  if (binaryBlocks?.length) {
    projected.binaryBlocks = binaryBlocks.map((block) => ({
      type: "binary",
      version: 1,
      kind: block.mimeType.toLowerCase().startsWith("image/")
        ? "image"
        : block.mimeType.toLowerCase().startsWith("audio/")
          ? "audio"
          : block.mimeType.toLowerCase().startsWith("video/")
            ? "video"
            : "file",
      ...block,
    }));
  }
  return projected;
}

export function hashMessageIdentity(message: string, images: AttachedImage[] | undefined): string {
  const imageSig = (images ?? [])
    .map((img) => `${img.mimeType}:${img.data}`)
    .join("|");
  return `${message}\x1f${imageSig}`;
}

/**
 * 从 content 提取纯文本（string 或 blocks 数组两种形状）。
 * Pi 投递的 message_end user content 是 blocks 数组，而乐观气泡是 string；
 * 去重比对必须统一两种形状，否则比对失败导致乐观气泡与投递消息重复。
 */
function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object"
        && (block as { type?: string }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "")
    .filter(Boolean)
    .join("\n");
}

function defaultRestoreDraft(draftKey: string, draft: { value: string; images: AttachedImage[] }): void {
  setDraft(draftKey, { value: draft.value, images: draft.images });
}

export function createBrowserSessionRuntimeRegistry(
  deps: BrowserSessionRuntimeRegistryDeps,
): BrowserSessionRuntimeRegistry {
  const restoreDraft = deps.restoreDraft ?? defaultRestoreDraft;
  const now = deps.now ?? (() => Date.now());
  const makeSubmissionId = deps.makeSubmissionId ?? generateSubmissionId;
  const schedule: (fn: () => void, ms: number) => TimerHandle = deps.schedule
    ?? ((fn, ms) => setTimeout(fn, ms));
  const clearSchedule: (id: TimerHandle) => void = deps.clearSchedule
    ?? ((id) => clearTimeout(id));
  const slots = new Map<string, RuntimeSlot>();

  const getSlot = (sessionId: string, create: boolean): RuntimeSlot | null => {
    const existing = slots.get(sessionId);
    if (existing) return existing;
    if (!create) return null;
    const slot = createSlot(sessionId);
    slots.set(sessionId, slot);
    return slot;
  };

  const publish = (slot: RuntimeSlot) => {
    slot.snapshot = {
      ...slot.snapshot,
      sessionId: slot.sessionId,
      submissions: [...slot.submissions.values()],
      attachCount: slot.attachCount,
    };
    for (const listener of slot.snapshotListeners) listener(slot.snapshot);
  };

  /**
   * SSE 生命周期对齐服务端 host 保活语义：视图挂载或 run 进行中才保持连接；
   * 切走后无人观看且空闲的会话关闭 SSE，让服务端 idle dispose 释放 writer 租约，
   * 另一实例（31415/31416）才能打开同一会话。挂载/新 run 会重连（connectEvents）。
   */
  const closeIdleEventStream = (slot: RuntimeSlot) => {
    if (slot.idleCloseTimer) {
      clearSchedule(slot.idleCloseTimer);
      slot.idleCloseTimer = null;
    }
    if (slot.sseRetryTimer) {
      clearSchedule(slot.sseRetryTimer);
      slot.sseRetryTimer = null;
      slot.sseRetryAttempt = 0;
    }
    if (slot.viewAttached || slot.attachCount > 0) return;
    if (slot.snapshot.agentRunning || slot.snapshot.sendInFlight || slot.inFlight.size > 0) return;
    const manager = slot.eventStream;
    if (!manager) return;
    slot.eventStream = null;
    manager.close();
    publish(slot);
  };

  const scheduleIdleEventStreamClose = (slot: RuntimeSlot) => {
    if (slot.idleCloseTimer) {
      clearSchedule(slot.idleCloseTimer);
      slot.idleCloseTimer = null;
    }
    if (slot.viewAttached || slot.attachCount > 0) return;
    if (slot.snapshot.agentRunning || slot.snapshot.sendInFlight || slot.inFlight.size > 0) return;
    if (!slot.eventStream) return;
    slot.idleCloseTimer = schedule(() => {
      slot.idleCloseTimer = null;
      closeIdleEventStream(slot);
    }, IDLE_SSE_CLOSE_DELAY_MS);
  };

  const bumpTimeline = (slot: RuntimeSlot) => {
    slot.snapshot.timelineSeq += 1;
  };

  const appendMessageWithEntry = (
    slot: RuntimeSlot,
    message: AgentMessage,
    entryId: string | null,
  ): void => {
    const withEntry = {
      ...(message as unknown as Record<string, unknown>),
      entryId: entryId ?? (message as unknown as Record<string, unknown>).entryId ?? "",
    };
    const alignedEntryIds = alignEntryIds(slot.snapshot.messages, slot.snapshot.entryIds);
    slot.snapshot.messages = [...slot.snapshot.messages, withEntry as unknown as AgentMessage];
    slot.snapshot.entryIds = [...alignedEntryIds, entryId ?? ""];
    bumpTimeline(slot);
  };

  const alignEntryIds = (messages: readonly AgentMessage[], entryIds: readonly string[]): string[] =>
    messages.map((_message, index) => entryIds[index] ?? "");

  const settleSubmission = (
    slot: RuntimeSlot,
    submissionId: string,
    status: SubmissionStatus,
    error?: string,
  ) => {
    const submission = slot.submissions.get(submissionId);
    if (submission) {
      submission.status = status;
      submission.error = error;
    }
    slot.snapshot.sendInFlight = slot.inFlight.size > 0;
    // 当前 promise 在 settle 时仍位于 inFlight；size<=1 表示没有其它提交。
    // rejected/unknown 不是正在执行的 Agent run，必须结束本次乐观 running，
    // 否则失败恢复 draft 后会把会话永久留在 Stop/禁止再次发送状态。
    if (
      slot.inFlight.size <= 1
      && (status === "rejected" || status === "unknown")
    ) {
      slot.snapshot.agentRunning = false;
      slot.snapshot.completedRunId = slot.snapshot.promptRunId;
      slot.snapshot.streamState = emptyStream();
    }
  };

  const restoreDraftFor = (submission: PromptSubmission) => {
    restoreDraft(submission.draftKey, {
      value: submission.message,
      images: submission.images ?? [],
    });
  };

  const dropUnconfirmedOptimistic = (slot: RuntimeSlot, submissionId: string) => {
    const index = slot.submissionMessageIndexes.get(submissionId);
    slot.submissionMessageIndexes.delete(submissionId);
    if (index === undefined) return;
    const entryId = slot.snapshot.entryIds[index] ?? "";
    const message = slot.snapshot.messages[index];
    if (!message || message.role !== "user" || entryId) return;
    slot.snapshot.messages = slot.snapshot.messages.filter((_, i) => i !== index);
    slot.snapshot.entryIds = slot.snapshot.entryIds.filter((_, i) => i !== index);
    for (const [id, otherIndex] of slot.submissionMessageIndexes) {
      if (otherIndex > index) slot.submissionMessageIndexes.set(id, otherIndex - 1);
    }
    bumpTimeline(slot);
  };

  const applyEventToSlot = (slot: RuntimeSlot, event: AgentStreamEvent) => {
    const type = event.type;
    if (type === "agent_start") {
      slot.snapshot.promptRunId += 1;
      slot.snapshot.agentRunning = true;
      slot.snapshot.completedRunId = null;
      // 新 run 到来时，旧 run 的 finish 异步操作失去所有权；其 finally
      // 只能按 runId 条件释放，不能阻塞当前 run。
      slot.snapshot.finishingRunId = null;
      slot.snapshot.streamState = { isStreaming: true, streamingMessage: null };
    } else if (type === "agent_end" || type === "prompt_done") {
      slot.snapshot.agentRunning = false;
      slot.snapshot.completedRunId = slot.snapshot.promptRunId;
      slot.snapshot.streamState = emptyStream();
    } else if (type === "message_start" || type === "message_update") {
      const message = event.message as Partial<AgentMessage> | undefined;
      if (!slot.snapshot.agentRunning) return;
      if (message?.role === "user") return;
      if (message) {
        const rendered = attachCustomRenderedLines(
          message as AgentMessage,
          event.renderedLines,
        );
        slot.snapshot.streamState = {
          isStreaming: true,
          streamingMessage: normalizeToolCalls(rendered),
        };
      }
    } else if (type === "message_end") {
      const completed = event.message as AgentMessage | undefined;
      const entryId = typeof event.entryId === "string" && event.entryId ? event.entryId : null;
      if (completed?.role === "user") {
        if (entryId && slot.consumedEntryIds.has(entryId)) {
          publish(slot);
          return;
        }
        if (entryId) slot.consumedEntryIds.add(entryId);
        const match = [...slot.submissions.values()].find((sub) =>
          (sub.status === "accepted" || sub.status === "submitting")
          && !sub.entryId
          && slot.submissionMessageIndexes.has(sub.submissionId),
        );
        const messageIndex = match
          ? slot.submissionMessageIndexes.get(match.submissionId)
          : undefined;
        const currentMessage = messageIndex === undefined
          ? undefined
          : slot.snapshot.messages[messageIndex];
        const currentEntryIds = alignEntryIds(slot.snapshot.messages, slot.snapshot.entryIds);
        const currentEntryId = messageIndex === undefined ? undefined : currentEntryIds[messageIndex];
        if (
          messageIndex !== undefined
          && currentMessage?.role === "user"
          && !currentEntryId
        ) {
          const withEntry = {
            ...(completed as unknown as Record<string, unknown>),
            entryId: entryId ?? "",
          } as unknown as AgentMessage;
          const messages = [...slot.snapshot.messages];
          messages[messageIndex] = withEntry;
          currentEntryIds[messageIndex] = entryId ?? "";
          slot.snapshot.messages = messages;
          slot.snapshot.entryIds = currentEntryIds;
          bumpTimeline(slot);
        } else {
          const last = slot.snapshot.messages[slot.snapshot.messages.length - 1];
          const lastText = messageContentText(last && "content" in last ? (last as { content?: unknown }).content : undefined);
          const nextText = messageContentText(completed && "content" in completed ? (completed as { content?: unknown }).content : undefined);
          const isNextEntryPresent = entryId !== null
            ? slot.snapshot.messages.some((msg) => (msg as { entryId?: unknown }).entryId === entryId)
            : false;
          // 重复防御：磁盘 hydrate 后乐观/引导气泡（同文本、空 entryId）可能不在末尾。
          // 先找同文本且空 entryId 的 user 消息，命中则就地绑定 entryId，不追加。
          let bindIndex = -1;
          if (!isNextEntryPresent) {
            bindIndex = slot.snapshot.messages.findLastIndex((msg, index) =>
              msg?.role === "user"
              && !(slot.snapshot.entryIds[index])
              // 统一 string/blocks 两种 content 形状后比对文本。
              && (msg as { content?: unknown }).content !== undefined
              && messageContentText((msg as { content?: unknown }).content) === nextText
              && nextText.length > 0
            );
          }
          if (bindIndex >= 0) {
            const messages = [...slot.snapshot.messages];
            const aligned = alignEntryIds(slot.snapshot.messages, slot.snapshot.entryIds);
            messages[bindIndex] = {
              ...(completed as unknown as Record<string, unknown>),
              entryId: entryId ?? "",
            } as unknown as AgentMessage;
            aligned[bindIndex] = entryId ?? "";
            slot.snapshot.messages = messages;
            slot.snapshot.entryIds = aligned;
            bumpTimeline(slot);
          } else if (!isNextEntryPresent && (!last || last.role !== "user" || lastText !== nextText)) {
            appendMessageWithEntry(slot, completed, entryId);
          } else if (!isNextEntryPresent && entryId !== null && last?.role === "user") {
            const lastIndex = slot.snapshot.messages.length - 1;
            const aligned = alignEntryIds(slot.snapshot.messages, slot.snapshot.entryIds);
            if (!aligned[lastIndex]) {
              const messages = [...slot.snapshot.messages];
              messages[lastIndex] = {
                ...(last as unknown as Record<string, unknown>),
                entryId,
              } as unknown as AgentMessage;
              aligned[lastIndex] = entryId;
              slot.snapshot.messages = messages;
              slot.snapshot.entryIds = aligned;
              bumpTimeline(slot);
            }
          }
        }
        if (match && messageIndex !== undefined) {
          slot.submissionMessageIndexes.delete(match.submissionId);
        }
        // FIFO：下一个未绑定 entry 的 accepted/submitting submission。
        // 同一 entryId 不可二次消费，避免 SSE 重放把两条 submission 绑到同一 entry。
        if (match && entryId !== null) {
          match.status = "persisted";
          match.entryId = entryId;
        }
      } else if (completed?.role === "custom" && completed.customType === PIDANCE_BINARY_CUSTOM_TYPE) {
        const binary = parseBinaryMessageData(completed.details);
        const targetIndex = binary?.messageEntryId
          ? slot.snapshot.entryIds.indexOf(binary.messageEntryId)
          : -1;
        const fallbackIndex = targetIndex >= 0
          ? targetIndex
          : binary?.messageEntryId
            ? slot.snapshot.messages.findLastIndex((message, index) => message.role === "user" && !slot.snapshot.entryIds[index])
            : -1;
        const target = fallbackIndex >= 0 ? slot.snapshot.messages[fallbackIndex] : undefined;
        if (binary && target?.role === "user") {
          const existing = target.binaryBlocks ?? [];
          const alreadyAttached = existing.some((block) => (
            block.path === binary.path
            && block.previewPath === binary.previewPath
          ));
          if (!alreadyAttached) {
            slot.snapshot.messages = slot.snapshot.messages.map((message, index) => (
              index === fallbackIndex && message.role === "user"
                ? { ...message, binaryBlocks: [...(message.binaryBlocks ?? []), binary] }
                : message
            ));
            bumpTimeline(slot);
          }
        } else if (slot.snapshot.agentRunning) {
          appendMessageWithEntry(slot, completed, entryId);
        }
      } else if (completed && slot.snapshot.agentRunning) {
        const rendered = attachCustomRenderedLines(completed, event.renderedLines);
        appendMessageWithEntry(slot, normalizeToolCalls(rendered), entryId);
      }
      slot.snapshot.streamState = emptyStream();
    }
    publish(slot);
    for (const handler of slot.viewHandlers) {
      try {
        handler(event);
      } catch {
        /* view errors must not break the runtime */
      }
    }
    // 无视图且空闲（run 结束后无人观看）：调度延迟关闭 SSE，释放服务端 idle host。
    scheduleIdleEventStreamClose(slot);
  };

  /**
   * attach 后 SSE 确连失败的重试窗口（host dispose/创建竞态的瞬态 404）。
   * 有限次短重试：期间用户能看到投递/回复事件；全败则放弃，后续写动作
   * （ensureEventsConnected / submitPrompt）仍会重建。
   */
  const SSE_ENSURE_RETRY_DELAYS_MS = [500, 1_500, 3_000];

  const connectEvents = (slot: RuntimeSlot) => {
    // 挂载/新 run 到来：取消待执行的空闲关闭与重试，保持连接。
    if (slot.idleCloseTimer) {
      clearSchedule(slot.idleCloseTimer);
      slot.idleCloseTimer = null;
    }
    if (slot.sseRetryTimer) {
      clearSchedule(slot.sseRetryTimer);
      slot.sseRetryTimer = null;
      slot.sseRetryAttempt = 0;
    }
    const source = slot.eventStream?.getCurrentSource();
    if (slot.eventStream && source && source.readyState !== 2 && slot.eventStream.isCurrent(slot.sessionId)) {
      return;
    }
    slot.eventStream = null;
    const onEvent = (event: AgentStreamEvent) => applyEventToSlot(slot, event);
    const manager = deps.createEventStream
      ? deps.createEventStream(slot.sessionId, onEvent)
      : createEventStreamManager({
        // 弱网自动重连：仅当 slot 认为 agent 仍在跑且页面可见时自动重连；
        // 404/无 host（空闲 dispose 后）不无限重试，避免对空会话反复握手。
        shouldAutoReconnect: () => {
          if (!slot.snapshot.agentRunning) return false;
          if (typeof document === "undefined") return true;
          return document.visibilityState !== "hidden";
        },
      });
    slot.eventStream = manager;
    void manager.ensureConnected(slot.sessionId, onEvent).catch(() => {
      if (slot.eventStream === manager) slot.eventStream = null;
      // 视图仍在且无 run 在途：有限次重试，覆盖 host 瞬态 404（dispose/ensure 竞态）。
      if (!slot.viewAttached || slot.attachCount === 0) return;
      const attempt = slot.sseRetryAttempt;
      if (attempt >= SSE_ENSURE_RETRY_DELAYS_MS.length) return;
      const delay = SSE_ENSURE_RETRY_DELAYS_MS[attempt];
      slot.sseRetryAttempt = attempt + 1;
      if (slot.sseRetryTimer) clearSchedule(slot.sseRetryTimer);
      slot.sseRetryTimer = schedule(() => {
        slot.sseRetryTimer = null;
        // 重试前再确认：视图仍挂载、连接未重建、run 未结束。
        if (!slot.viewAttached || slot.attachCount === 0) return;
        if (slot.eventStream && slot.eventStream !== manager) return;
        if (slot.snapshot.agentRunning || slot.snapshot.sendInFlight) return;
        connectEvents(slot);
      }, delay);
    });
  };

  const rekey = (fromId: string, toId: string): RuntimeSlot => {
    const slot = getSlot(fromId, true)!;
    slot.sessionId = toId;
    slot.snapshot.sessionId = toId;
    slots.set(toId, slot);
    // pending id 继续指向同一 slot，ensure 完成后 Stop 仍能按原 intent 命中。
    slots.set(fromId, slot);
    return slot;
  };

  const registry: BrowserSessionRuntimeRegistry = {
    getSnapshot(sessionId) {
      const slot = slots.get(sessionId);
      return slot ? slot.snapshot : null;
    },
    subscribe(sessionId, listener) {
      const slot = getSlot(sessionId, true)!;
      slot.snapshotListeners.add(listener);
      listener(slot.snapshot);
      return () => {
        slot.snapshotListeners.delete(listener);
      };
    },
    attach(sessionId, onEvent) {
      const slot = getSlot(sessionId, true)!;
      slot.attachCount += 1;
      slot.viewAttached = true;
      if (onEvent) slot.viewHandlers.add(onEvent);
      // 打开会话只订阅已有 live；不在 attach 阶段 wake/创建 writer。
      // 首次写操作由 submitPrompt/ensureEventsConnected 明确唤醒，避免 31415/31416
      // 共用 agentDir 时仅浏览会话就抢占另一进程的 writer lease。
      connectEvents(slot);
      publish(slot);
      return {
        sessionId,
        dispose: () => {
          const current = slots.get(sessionId);
          if (!current) return;
          if (onEvent) current.viewHandlers.delete(onEvent);
          current.attachCount = Math.max(0, current.attachCount - 1);
          if (current.attachCount === 0) current.viewAttached = false;
          publish(current);
          // 切走后无人观看：延迟关闭 SSE，释放服务端 idle host 与 writer 租约。
          scheduleIdleEventStreamClose(current);
        },
      };
    },
    detach(sessionId, subscription) {
      subscription.dispose();
    },
    async submitPrompt(input) {
      const submissionId = input.submissionId?.trim() || makeSubmissionId();
      const initialSessionId = input.target.kind === "persisted"
        ? input.target.sessionId
        : pendingSessionId(input.target.intentId);
      const slot = getSlot(initialSessionId, true)!;
      const existing = slot.submissions.get(submissionId);
      if (existing && (existing.status === "accepted" || existing.status === "persisted" || existing.status === "submitting")) {
        return {
          submissionId,
          sessionId: slot.sessionId,
          status: "accepted",
        };
      }
      const inFlight = slot.inFlight.get(submissionId);
      if (inFlight) return inFlight;

      const submission: PromptSubmission = {
        submissionId,
        sessionId: initialSessionId,
        draftKey: input.draftKey,
        message: input.message,
        images: input.images,
        binaryBlocks: input.binaryBlocks,
        status: "submitting",
        entryId: null,
      };
      const controller = new AbortController();
      slot.submissions.set(submissionId, submission);
      slot.promptAborts.set(submissionId, controller);
      slot.snapshot.sendInFlight = true;
      slot.snapshot.agentRunning = true;
      slot.snapshot.promptRunId += 1;
      slot.snapshot.completedRunId = null;
      slot.snapshot.finishingRunId = null;
      const optimisticMessageIndex = slot.snapshot.messages.length;
      slot.snapshot.messages = [
        ...slot.snapshot.messages,
        userMessageFromSubmit(input.message, input.images, input.binaryBlocks, now()),
      ];
      slot.snapshot.entryIds = [...slot.snapshot.entryIds, ""];
      slot.submissionMessageIndexes.set(submissionId, optimisticMessageIndex);
      bumpTimeline(slot);
      publish(slot);

      const promise = (async (): Promise<SubmitPromptResult> => {
        let sessionId = initialSessionId;
        let newSessionJustEnsured = false;
        try {
          if (input.target.kind === "new") {
            if (deps.createAndPrompt) {
              // 一步创建+发送：服务端 POST /api/agent/new {type:"prompt"} 在同一
              // host 启动窗口内完成 ensure+prompt，返回真实 id；无两跳竞态。
              const { sessionId: created, receipt } = await deps.createAndPrompt(
                input.target.cwd,
                {
                  message: input.message,
                  images: input.images,
                  binaryBlocks: input.binaryBlocks,
                  submissionId,
                  ...(input.model?.provider ? { provider: input.model.provider, modelId: input.model.modelId } : {}),
                  ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
                  signal: controller.signal,
                },
              );
              if (controller.signal.aborted) {
                throw new DOMException("aborted", "AbortError");
              }
              sessionId = created;
              submission.sessionId = created;
              rekey(initialSessionId, created);
              newSessionJustEnsured = true;
              if (receipt.status === "rejected") {
                settleSubmission(slot, submissionId, "rejected", "rejected");
                dropUnconfirmedOptimistic(slot, submissionId);
                restoreDraftFor(submission);
                publish(slot);
                return { submissionId, sessionId, status: "rejected", error: "rejected" };
              }
              settleSubmission(slot, submissionId, "accepted");
              publish(slot);
              return { submissionId, sessionId, status: "accepted" };
            }
            if (!deps.ensureNewSession) {
              settleSubmission(slot, submissionId, "rejected", "no ensure implementation");
              dropUnconfirmedOptimistic(slot, submissionId);
              restoreDraftFor(submission);
              publish(slot);
              return { submissionId, sessionId, status: "rejected", error: "no ensure implementation" };
            }
            const created = await deps.ensureNewSession(input.target.cwd, input.model);
            if (controller.signal.aborted) {
              throw new DOMException("aborted", "AbortError");
            }
            sessionId = created;
            submission.sessionId = created;
            rekey(initialSessionId, created);
            // 刚 ensure 的新 host 必然 live（startup hold 保活窗口内），无需 wake；
            // wake 走磁盘 resolvePath，新会话文件尚未落盘会 404 → 发送被拒。
            newSessionJustEnsured = true;
          }
          // 先显式唤醒/确保 writer，再建立 SSE；attach 本身不会创建 live。
          // 否则无 live 的 SSE 请求会先被 404，随后真正 prompt 已开始却没有事件订阅。
          // （仅旧会话需要 wake；新会话跳过，见上）
          if (!newSessionJustEnsured && deps.wake) {
            await deps.wake(sessionId, controller.signal);
          }
          connectEvents(slot);
          const receipt = await deps.postPrompt(sessionId, {
            message: input.message,
            images: input.images,
            binaryBlocks: input.binaryBlocks,
            submissionId,
            signal: controller.signal,
          });
          if (receipt.status === "rejected") {
            settleSubmission(slot, submissionId, "rejected", "rejected");
            dropUnconfirmedOptimistic(slot, submissionId);
            restoreDraftFor(submission);
            publish(slot);
            return { submissionId, sessionId, status: "rejected", error: "rejected" };
          }
          settleSubmission(slot, submissionId, "accepted");
          publish(slot);
          return { submissionId, sessionId, status: "accepted" };
        } catch (error) {
          const aborted = error instanceof Error && (error.name === "AbortError" || controller.signal.aborted);
          if (aborted) {
            settleSubmission(slot, submissionId, "unknown", "aborted");
            publish(slot);
            return { submissionId, sessionId, status: "unknown" };
          }
          const message = error instanceof Error ? error.message : String(error);
          settleSubmission(slot, submissionId, "unknown", message);
          dropUnconfirmedOptimistic(slot, submissionId);
          restoreDraftFor(submission);
          publish(slot);
          return { submissionId, sessionId, status: "unknown", error: message };
        } finally {
          slot.inFlight.delete(submissionId);
          slot.promptAborts.delete(submissionId);
          slot.snapshot.sendInFlight = slot.inFlight.size > 0;
          publish(slot);
          // 提交结算后仍无视图且已空闲（rejected/unknown）：调度延迟关闭 SSE。
          scheduleIdleEventStreamClose(slot);
        }
      })();
      slot.inFlight.set(submissionId, promise);
      return promise;
    },
    cancellationFor(sessionId) {
      const slot = slots.get(sessionId);
      if (!slot) return null;
      const first = [...slot.promptAborts.entries()][0];
      if (!first) return null;
      const [submissionId, controller] = first;
      return { submissionId, cancel: () => controller.abort(), signal: controller.signal };
    },
    abortSubmission(sessionId, submissionId) {
      const slot = slots.get(sessionId);
      if (!slot) return Promise.resolve(null);
      const controller = submissionId
        ? slot.promptAborts.get(submissionId)
        : [...slot.promptAborts.values()][0];
      const inflight = submissionId
        ? slot.inFlight.get(submissionId)
        : [...slot.inFlight.values()][0];
      controller?.abort();
      if (inflight) return inflight;
      return Promise.resolve(null);
    },
    abort(sessionId) {
      const slot = slots.get(sessionId);
      if (!slot) return;
      for (const controller of slot.promptAborts.values()) controller.abort();
      slot.snapshot.agentRunning = false;
      slot.snapshot.sendInFlight = slot.inFlight.size > 0;
      publish(slot);
      scheduleIdleEventStreamClose(slot);
    },
    getRunState(sessionId) {
      const snapshot = slots.get(sessionId)?.snapshot;
      if (!snapshot) return null;
      return {
        promptRunId: snapshot.promptRunId,
        agentRunning: snapshot.agentRunning,
        sendInFlight: snapshot.sendInFlight,
        finishingRunId: snapshot.finishingRunId,
        completedRunId: snapshot.completedRunId,
      };
    },
    beginRunFinish(sessionId, runId) {
      const slot = slots.get(sessionId);
      if (!slot) return false;
      const snapshot = slot.snapshot;
      if (snapshot.promptRunId !== runId) return false;
      if (snapshot.finishingRunId !== null) return false;
      if (!snapshot.agentRunning && snapshot.completedRunId !== runId) return false;
      snapshot.finishingRunId = runId;
      publish(slot);
      return true;
    },
    releaseRunFinish(sessionId, runId) {
      const slot = slots.get(sessionId);
      if (!slot || slot.snapshot.finishingRunId !== runId) return;
      slot.snapshot.finishingRunId = null;
      publish(slot);
    },
    completeRun(sessionId, runId) {
      const slot = slots.get(sessionId);
      if (!slot || slot.snapshot.promptRunId !== runId) return false;
      slot.snapshot.agentRunning = false;
      slot.snapshot.completedRunId = runId;
      slot.snapshot.streamState = emptyStream();
      publish(slot);
      return true;
    },
    importRunningRun(sessionId, startedAt) {
      const slot = getSlot(sessionId, true)!;
      const snapshot = slot.snapshot;
      // 只在浏览器侧未感知 run 时导入（刷新/冷挂载后服务端已在跑）。
      // 已 running / 已有在途 send 不得重复导入（run id 会膨胀）。
      if (snapshot.agentRunning || snapshot.sendInFlight) return;
      snapshot.agentRunning = true;
      snapshot.completedRunId = null;
      snapshot.finishingRunId = null;
      snapshot.promptRunId += 1;
      snapshot.streamState = { isStreaming: true, streamingMessage: null };
      void startedAt;
      publish(slot);
    },
    async reconcile(sessionId) {
      const slot = slots.get(sessionId);
      if (!slot || !deps.getAgentState) return null;
      const runId = slot.snapshot.promptRunId;
      const data = await deps.getAgentState(sessionId);
      const current = slots.get(sessionId);
      if (current !== slot || current.snapshot.promptRunId !== runId) {
        return { runId, stale: true, live: false, shouldFinish: false };
      }
      const live = data.live === true || (data.live === undefined && data.running === true);
      const state = data.state;
      const knownIdleWithoutLive = data.activeRun === false && data.lockedByOther !== true;
      return {
        runId,
        stale: false,
        live,
        shouldFinish: shouldFinishFromReconcile({
          sendInFlight: current.snapshot.sendInFlight,
          clientRunning: current.snapshot.agentRunning,
          live,
          knownIdleWithoutLive,
          isStreaming: state?.isStreaming === true,
          isPromptRunning: state?.isPromptRunning === true,
          isCompacting: state?.isCompacting === true,
        }),
        state,
      };
    },
    beginHydrate(sessionId) {
      const slot = getSlot(sessionId, true)!;
      slot.hydrateSeq += 1;
      return slot.hydrateSeq;
    },
    hydrate(sessionId, messages, entryIds = [], options) {
      const slot = getSlot(sessionId, true)!;
      if (options?.sinceSeq !== undefined && slot.snapshot.timelineSeq > options.sinceSeq) {
        return false;
      }
      const requestSeq = options?.hydrateRequestSeq ?? ++slot.hydrateSeq;
      if (requestSeq <= slot.hydrateAppliedSeq) return false;
      slot.hydrateSeq = Math.max(slot.hydrateSeq, requestSeq);
      slot.hydrateAppliedSeq = requestSeq;
      const alignedEntryIds = alignEntryIds(messages, entryIds);
      slot.snapshot.messages = [...messages];
      slot.snapshot.entryIds = alignedEntryIds;
      for (const id of alignedEntryIds) {
        if (id) slot.consumedEntryIds.add(id);
      }
      publish(slot);
      return true;
    },
    appendLocal(sessionId, message) {
      const slot = getSlot(sessionId, true)!;
      const alignedEntryIds = alignEntryIds(slot.snapshot.messages, slot.snapshot.entryIds);
      slot.snapshot.messages = [...slot.snapshot.messages, message];
      slot.snapshot.entryIds = [...alignedEntryIds, ""];
      bumpTimeline(slot);
      publish(slot);
    },
    applyEvent(sessionId, event) {
      const slot = getSlot(sessionId, true)!;
      applyEventToSlot(slot, event);
    },
    ensureEventsConnected(sessionId) {
      // 重连也只尝试当前 live host；焦点/可见性恢复不得把冷历史会话唤醒。
      const slot = getSlot(sessionId, true)!;
      connectEvents(slot);
    },
    getEventSource(sessionId) {
      return slots.get(sessionId)?.eventStream?.getCurrentSource() ?? null;
    },
    getSubmission(sessionId, submissionId) {
      return slots.get(sessionId)?.submissions.get(submissionId);
    },
    resetForTests() {
      resetSingleton();
    },
  };

  return registry;
}

let singleton: BrowserSessionRuntimeRegistry | null = null;

export function getBrowserSessionRuntimeRegistry(
  deps?: BrowserSessionRuntimeRegistryDeps,
): BrowserSessionRuntimeRegistry {
  if (!singleton) {
    if (!deps) {
      throw new Error("BrowserSessionRuntimeRegistry requires deps on first initialization");
    }
    singleton = createBrowserSessionRuntimeRegistry(deps);
  }
  return singleton;
}

function resetSingleton(): void {
  singleton = null;
}

export function resetBrowserSessionRuntimeRegistryForTests(): void {
  resetSingleton();
}

function createBrowserFetchDeps(): BrowserSessionRuntimeRegistryDeps {
  return {
    async createAndPrompt(cwd, input) {
      const res = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          type: "prompt",
          message: input.message,
          submissionId: input.submissionId,
          ...(input.images?.length
            ? { images: input.images.map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType })) }
            : {}),
          ...(input.binaryBlocks?.length ? { binaryBlocks: input.binaryBlocks } : {}),
          ...(input.provider && input.modelId ? { provider: input.provider, modelId: input.modelId } : {}),
          ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
        }),
        signal: input.signal,
      });
      const body = await res.json().catch(() => ({})) as {
        sessionId?: string;
        data?: PromptReceipt | null;
        error?: string;
      };
      if (!res.ok || body.error || !body.sessionId) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const receipt = body.data ?? { submissionId: input.submissionId, sessionId: body.sessionId, status: "accepted" as const };
      return { sessionId: body.sessionId, receipt };
    },
    async postPrompt(sessionId, input) {
      const { submitAgentPrompt } = await import("./agent-client");
      return submitAgentPrompt(sessionId, input, { signal: input.signal });
    },
    async ensureNewSession(cwd, extras) {
      const res = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          type: "ensure_session",
          ...(extras?.provider && extras.modelId
            ? { provider: extras.provider, modelId: extras.modelId }
            : {}),
        }),
      });
      const body = await res.json().catch(() => ({})) as { sessionId?: string; error?: string };
      if (!res.ok || !body.sessionId) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return body.sessionId;
    },
    async wake(sessionId, signal) {
      const wake = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/state?wake=1`, { signal });
      if (!wake.ok) {
        const wakeBody = await wake.json().catch(() => ({})) as { error?: string };
        throw new Error(typeof wakeBody.error === "string" ? wakeBody.error : `HTTP ${wake.status}`);
      }
    },
    async getAgentState(sessionId) {
      const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({})) as RuntimeAgentState & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      return data;
    },
  };
}

export function getOrCreateBrowserSessionRuntimeRegistry(): BrowserSessionRuntimeRegistry {
  if (!singleton) {
    singleton = createBrowserSessionRuntimeRegistry(createBrowserFetchDeps());
  }
  return singleton;
}
