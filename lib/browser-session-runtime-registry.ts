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
} from "./event-stream-manager";
import { pendingSessionId } from "./new-session-intent";
import type { PromptReceipt } from "./agent-commands";
import { generateSubmissionId } from "./agent-commands";
import { attachCustomRenderedLines } from "./custom-rendered-lines";
import { normalizeToolCalls } from "./normalize";
import type { AgentMessage, AttachedImage } from "./types";

export type SubmissionStatus = "submitting" | "accepted" | "persisted" | "rejected" | "unknown";

export type PromptSubmission = {
  submissionId: string;
  sessionId: string;
  draftKey: string;
  message: string;
  images?: AttachedImage[];
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
  attachCount: number;
  /** live 事件单调序号；hydrate 用 sinceSeq 避免陈旧磁盘覆盖较新 timeline */
  timelineSeq: number;
};

export type SubmitPromptTarget =
  | { kind: "persisted"; sessionId: string }
  | { kind: "new"; intentId: string; cwd: string };

export type SubmitPromptInput = {
  target: SubmitPromptTarget;
  submissionId?: string;
  message: string;
  images?: AttachedImage[];
  draftKey: string;
  model?: { provider: string; modelId: string };
};

export type SubmitPromptResult = {
  submissionId: string;
  sessionId: string;
  status: "accepted" | "rejected" | "unknown";
};

export type BrowserSessionRuntimeRegistryDeps = {
  postPrompt: (
    sessionId: string,
    input: {
      message: string;
      images?: AttachedImage[];
      submissionId: string;
      signal?: AbortSignal;
    },
  ) => Promise<PromptReceipt>;
  ensureNewSession?: (
    cwd: string,
    extras?: { provider?: string; modelId?: string },
  ) => Promise<string>;
  wake?: (sessionId: string, signal?: AbortSignal) => Promise<void>;
  createEventStream?: (sessionId: string, onEvent: (event: AgentStreamEvent) => void) => EventStreamManager;
  restoreDraft?: (draftKey: string, draft: { value: string; images: AttachedImage[] }) => void;
  now?: () => number;
  makeSubmissionId?: () => string;
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
};

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
  hydrate(
    sessionId: string,
    messages: AgentMessage[],
    entryIds?: string[],
    options?: { sinceSeq?: number },
  ): boolean;
  appendLocal(sessionId: string, message: AgentMessage): void;
  applyEvent(sessionId: string, event: AgentStreamEvent): void;
  ensureEventsConnected(sessionId: string): void;
  getEventSource(sessionId: string): EventSourceLike | null;
  getSubmission(sessionId: string, submissionId: string): PromptSubmission | undefined;
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
  };
}

function userMessageFromSubmit(message: string, images: AttachedImage[] | undefined, now: number): AgentMessage {
  const imageBlocks = images?.map((img) => ({
    type: "image" as const,
    source: { type: "base64" as const, media_type: img.mimeType, data: img.data },
  }));
  return {
    role: "user",
    content: imageBlocks?.length
      ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
      : message,
    timestamp: now,
  };
}

export function hashMessageIdentity(message: string, images: AttachedImage[] | undefined): string {
  const imageSig = (images ?? [])
    .map((img) => `${img.mimeType}:${img.data}`)
    .join("|");
  return `${message}\x1f${imageSig}`;
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

  const bumpTimeline = (slot: RuntimeSlot) => {
    slot.snapshot.timelineSeq += 1;
  };

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
    if (slot.inFlight.size === 0 && !slot.snapshot.agentRunning) {
      slot.snapshot.agentRunning = false;
    }
  };

  const restoreDraftFor = (submission: PromptSubmission) => {
    restoreDraft(submission.draftKey, {
      value: submission.message,
      images: submission.images ?? [],
    });
  };

  const applyEventToSlot = (slot: RuntimeSlot, event: AgentStreamEvent) => {
    bumpTimeline(slot);
    const type = event.type;
    if (type === "agent_start") {
      slot.snapshot.promptRunId += 1;
      slot.snapshot.agentRunning = true;
      slot.snapshot.streamState = { isStreaming: true, streamingMessage: null };
    } else if (type === "agent_end" || type === "prompt_done") {
      slot.snapshot.agentRunning = false;
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
        const last = slot.snapshot.messages[slot.snapshot.messages.length - 1];
        const lastContent = last && "content" in last ? (last as { content?: unknown }).content : undefined;
        const nextContent = completed && "content" in completed ? (completed as { content?: unknown }).content : undefined;
        const lastText = typeof lastContent === "string" ? lastContent : "";
        const nextText = typeof nextContent === "string" ? nextContent : "";
        const isNextEntryPresent = entryId !== null
          ? slot.snapshot.messages.some((msg) => (msg as { entryId?: unknown }).entryId === entryId)
          : false;
        if (!isNextEntryPresent && (!last || last.role !== "user" || lastText !== nextText)) {
          const withEntry = {
            ...(completed as unknown as Record<string, unknown>),
            entryId: entryId ?? (completed as unknown as Record<string, unknown>).entryId,
          };
          slot.snapshot.messages = [...slot.snapshot.messages, withEntry as unknown as AgentMessage];
        }
        // FIFO：下一个未绑定 entry 的 accepted/submitting submission。
        // 同一 entryId 不可二次消费，避免 SSE 重放把两条 submission 绑到同一 entry。
        if (entryId !== null) {
          const match = [...slot.submissions.values()].find((sub) =>
            (sub.status === "accepted" || sub.status === "submitting") && !sub.entryId,
          );
          if (match) {
            match.status = "persisted";
            match.entryId = entryId;
          }
        }
      } else if (completed && slot.snapshot.agentRunning) {
        const rendered = attachCustomRenderedLines(completed, event.renderedLines);
        slot.snapshot.messages = [...slot.snapshot.messages, normalizeToolCalls(rendered)];
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
  };

  const connectEvents = (slot: RuntimeSlot) => {
    const source = slot.eventStream?.getCurrentSource();
    if (slot.eventStream && source && source.readyState !== 2 && slot.eventStream.isCurrent(slot.sessionId)) {
      return;
    }
    slot.eventStream = null;
    const onEvent = (event: AgentStreamEvent) => applyEventToSlot(slot, event);
    const manager = deps.createEventStream
      ? deps.createEventStream(slot.sessionId, onEvent)
      : createEventStreamManager();
    slot.eventStream = manager;
    void manager.ensureConnected(slot.sessionId, onEvent).catch(() => {
      if (slot.eventStream === manager) slot.eventStream = null;
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
      if (onEvent) slot.viewHandlers.add(onEvent);
      connectEvents(slot);
      if (deps.wake) {
        void deps.wake(sessionId).catch(() => undefined);
      }
      publish(slot);
      return {
        sessionId,
        dispose: () => {
          const current = slots.get(sessionId);
          if (!current) return;
          if (onEvent) current.viewHandlers.delete(onEvent);
          current.attachCount = Math.max(0, current.attachCount - 1);
          publish(current);
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
        status: "submitting",
        entryId: null,
      };
      const controller = new AbortController();
      slot.submissions.set(submissionId, submission);
      slot.promptAborts.set(submissionId, controller);
      slot.snapshot.sendInFlight = true;
      slot.snapshot.agentRunning = true;
      slot.snapshot.promptRunId += 1;
      slot.snapshot.messages = [
        ...slot.snapshot.messages,
        userMessageFromSubmit(input.message, input.images, now()),
      ];
      bumpTimeline(slot);
      publish(slot);

      const promise = (async (): Promise<SubmitPromptResult> => {
        let sessionId = initialSessionId;
        try {
          if (input.target.kind === "new") {
            if (!deps.ensureNewSession) {
              settleSubmission(slot, submissionId, "rejected", "no ensure implementation");
              restoreDraftFor(submission);
              publish(slot);
              return { submissionId, sessionId, status: "rejected" };
            }
            const created = await deps.ensureNewSession(input.target.cwd, input.model);
            if (controller.signal.aborted) {
              throw new DOMException("aborted", "AbortError");
            }
            sessionId = created;
            submission.sessionId = created;
            rekey(initialSessionId, created);
          }
          connectEvents(slot);
          if (deps.wake) {
            void deps.wake(sessionId, controller.signal).catch(() => undefined);
          }
          const receipt = await deps.postPrompt(sessionId, {
            message: input.message,
            images: input.images,
            submissionId,
            signal: controller.signal,
          });
          if (receipt.status === "rejected") {
            settleSubmission(slot, submissionId, "rejected", "rejected");
            restoreDraftFor(submission);
            publish(slot);
            return { submissionId, sessionId, status: "rejected" };
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
          settleSubmission(slot, submissionId, "unknown", error instanceof Error ? error.message : String(error));
          restoreDraftFor(submission);
          publish(slot);
          return { submissionId, sessionId, status: "unknown" };
        } finally {
          slot.inFlight.delete(submissionId);
          slot.promptAborts.delete(submissionId);
          slot.snapshot.sendInFlight = slot.inFlight.size > 0;
          publish(slot);
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
    },
    hydrate(sessionId, messages, entryIds = [], options) {
      const slot = getSlot(sessionId, true)!;
      if (options?.sinceSeq !== undefined && slot.snapshot.timelineSeq > options.sinceSeq) {
        return false;
      }
      slot.snapshot.messages = [...messages];
      slot.snapshot.entryIds = [...entryIds];
      publish(slot);
      return true;
    },
    appendLocal(sessionId, message) {
      const slot = getSlot(sessionId, true)!;
      slot.snapshot.messages = [...slot.snapshot.messages, message];
      bumpTimeline(slot);
      publish(slot);
    },
    applyEvent(sessionId, event) {
      const slot = getSlot(sessionId, true)!;
      applyEventToSlot(slot, event);
    },
    ensureEventsConnected(sessionId) {
      const slot = getSlot(sessionId, true)!;
      connectEvents(slot);
      if (deps.wake) {
        void deps.wake(sessionId).catch(() => undefined);
      }
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
  };
}

export function getOrCreateBrowserSessionRuntimeRegistry(): BrowserSessionRuntimeRegistry {
  if (!singleton) {
    singleton = createBrowserSessionRuntimeRegistry(createBrowserFetchDeps());
  }
  return singleton;
}
