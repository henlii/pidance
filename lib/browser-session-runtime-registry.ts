/**
 * Page-level owner of per-session submit, EventStreamManager, run token, and
 * live timeline. ChatWindow unmount only detaches the view; it cannot cancel POST.
 */

import { setDraft } from "./draft-store";
import {
  createEventStreamManager,
  type AgentStreamEvent,
  type EventStreamManager,
} from "./event-stream-manager";
import { pendingSessionId } from "./new-session-intent";
import type { PromptReceipt } from "./agent-commands";
import { generateSubmissionId } from "./agent-commands";
import type { AgentMessage, AttachedImage } from "./types";

export type SubmissionStatus = "submitting" | "accepted" | "persisted" | "rejected" | "unknown";

export type PromptSubmission = {
  submissionId: string;
  sessionId: string;
  draftKey: string;
  message: string;
  status: SubmissionStatus;
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
    },
  ) => Promise<PromptReceipt>;
  ensureNewSession?: (
    cwd: string,
    extras?: { provider?: string; modelId?: string },
  ) => Promise<string>;
  wake?: (sessionId: string, signal?: AbortSignal) => Promise<void>;
  createEventStream?: (sessionId: string, onEvent: (event: AgentStreamEvent) => void) => EventStreamManager;
  restoreDraft?: (draftKey: string, message: string) => void;
  now?: () => number;
  makeSubmissionId?: () => string;
};

type RuntimeSlot = {
  sessionId: string;
  snapshot: SessionRuntimeSnapshot;
  submissions: Map<string, PromptSubmission>;
  eventStream: EventStreamManager | null;
  viewHandlers: Set<(event: AgentStreamEvent) => void>;
  snapshotListeners: Set<() => void>;
  attachCount: number;
  promptAbort: AbortController | null;
};

function emptyStream(): StreamSnapshot {
  return { isStreaming: false, streamingMessage: null };
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

function defaultRestoreDraft(draftKey: string, message: string): void {
  setDraft(draftKey, { value: message, images: [] });
}

export type BrowserSessionRuntimeRegistry = {
  getSnapshot(sessionId: string): SessionRuntimeSnapshot | null;
  subscribe(sessionId: string, listener: () => void): () => void;
  attach(sessionId: string, onEvent?: (event: AgentStreamEvent) => void): SessionRuntimeSnapshot;
  detach(sessionId: string, onEvent?: (event: AgentStreamEvent) => void): void;
  submitPrompt(input: SubmitPromptInput): Promise<SubmitPromptResult>;
  abort(sessionId: string): void;
  hydrate(sessionId: string, messages: AgentMessage[], entryIds?: string[]): void;
  applyEvent(sessionId: string, event: AgentStreamEvent): void;
  getSubmission(sessionId: string, submissionId: string): PromptSubmission | undefined;
};

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
    },
    submissions: new Map(),
    eventStream: null,
    viewHandlers: new Set(),
    snapshotListeners: new Set(),
    attachCount: 0,
    promptAbort: null,
  };
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
    for (const listener of slot.snapshotListeners) listener();
  };

  const applyEventToSlot = (slot: RuntimeSlot, event: AgentStreamEvent) => {
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
        slot.snapshot.streamState = { isStreaming: true, streamingMessage: message };
      }
    } else if (type === "message_end") {
      const completed = event.message as AgentMessage | undefined;
      if (completed?.role === "user") {
        const last = slot.snapshot.messages[slot.snapshot.messages.length - 1];
        const lastContent = last && "content" in last ? (last as { content?: unknown }).content : undefined;
        const nextContent = completed && "content" in completed ? (completed as { content?: unknown }).content : undefined;
        const lastText = typeof lastContent === "string" ? lastContent : "";
        const nextText = typeof nextContent === "string" ? nextContent : "";
        if (!last || last.role !== "user" || lastText !== nextText) {
          slot.snapshot.messages = [...slot.snapshot.messages, completed];
        }
        for (const submission of slot.submissions.values()) {
          if (submission.status === "accepted" && submission.message === nextText) {
            submission.status = "persisted";
          }
        }
      } else if (completed && slot.snapshot.agentRunning) {
        slot.snapshot.messages = [...slot.snapshot.messages, completed];
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
    if (slot.eventStream) return;
    const onEvent = (event: AgentStreamEvent) => applyEventToSlot(slot, event);
    const manager = deps.createEventStream
      ? deps.createEventStream(slot.sessionId, onEvent)
      : createEventStreamManager();
    slot.eventStream = manager;
    void manager.ensureConnected(slot.sessionId, onEvent).catch(() => {
      /* SSE is observation only; POST does not depend on it */
    });
  };

  const rekey = (fromId: string, toId: string): RuntimeSlot => {
    const slot = getSlot(fromId, true)!;
    slots.delete(fromId);
    slot.sessionId = toId;
    slot.snapshot.sessionId = toId;
    slots.set(toId, slot);
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
      return slot.snapshot;
    },
    detach(sessionId, onEvent) {
      const slot = slots.get(sessionId);
      if (!slot) return;
      if (onEvent) slot.viewHandlers.delete(onEvent);
      slot.attachCount = Math.max(0, slot.attachCount - 1);
      publish(slot);
    },
    async submitPrompt(input) {
      const submissionId = input.submissionId?.trim() || makeSubmissionId();
      let sessionId = input.target.kind === "persisted"
        ? input.target.sessionId
        : pendingSessionId(input.target.intentId);

      if (input.target.kind === "new") {
        if (!deps.ensureNewSession) {
          restoreDraft(input.draftKey, input.message);
          return { submissionId, sessionId, status: "rejected" };
        }
        const created = await deps.ensureNewSession(input.target.cwd, input.model);
        const pending = getSlot(sessionId, true)!;
        sessionId = created;
        rekey(pending.sessionId, created);
      }

      const slot = getSlot(sessionId, true)!;
      const existing = slot.submissions.get(submissionId);
      if (existing && (existing.status === "accepted" || existing.status === "persisted" || existing.status === "submitting")) {
        return {
          submissionId,
          sessionId,
          status: existing.status === "submitting" ? "accepted" : existing.status === "persisted" ? "accepted" : existing.status,
        };
      }

      const submission: PromptSubmission = {
        submissionId,
        sessionId,
        draftKey: input.draftKey,
        message: input.message,
        status: "submitting",
      };
      slot.submissions.set(submissionId, submission);
      slot.snapshot.sendInFlight = true;
      slot.snapshot.agentRunning = true;
      slot.snapshot.promptRunId += 1;
      slot.snapshot.messages = [
        ...slot.snapshot.messages,
        userMessageFromSubmit(input.message, input.images, now()),
      ];
      publish(slot);
      connectEvents(slot);
      if (deps.wake) {
        void deps.wake(sessionId, slot.promptAbort?.signal).catch(() => undefined);
      }

      try {
        const receipt = await deps.postPrompt(sessionId, {
          message: input.message,
          images: input.images,
          submissionId,
        });
        if (receipt.status === "rejected") {
          submission.status = "rejected";
          submission.error = "rejected";
          slot.snapshot.sendInFlight = false;
          slot.snapshot.agentRunning = false;
          restoreDraft(input.draftKey, input.message);
          publish(slot);
          return { submissionId, sessionId, status: "rejected" };
        }
        submission.status = "accepted";
        slot.snapshot.sendInFlight = false;
        publish(slot);
        return { submissionId, sessionId, status: "accepted" };
      } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        if (aborted) {
          slot.snapshot.sendInFlight = false;
          publish(slot);
          return { submissionId, sessionId, status: "unknown" };
        }
        submission.status = "unknown";
        slot.snapshot.sendInFlight = false;
        slot.snapshot.agentRunning = false;
        restoreDraft(input.draftKey, input.message);
        publish(slot);
        return { submissionId, sessionId, status: "unknown" };
      }
    },
    abort(sessionId) {
      const slot = slots.get(sessionId);
      if (!slot) return;
      slot.promptAbort?.abort();
      slot.snapshot.agentRunning = false;
      slot.snapshot.sendInFlight = false;
      publish(slot);
    },
    hydrate(sessionId, messages, entryIds = []) {
      const slot = getSlot(sessionId, true)!;
      slot.snapshot.messages = [...messages];
      slot.snapshot.entryIds = [...entryIds];
      publish(slot);
    },
    applyEvent(sessionId, event) {
      const slot = getSlot(sessionId, true)!;
      applyEventToSlot(slot, event);
    },
    getSubmission(sessionId, submissionId) {
      return slots.get(sessionId)?.submissions.get(submissionId);
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

export function resetBrowserSessionRuntimeRegistryForTests(): void {
  singleton = null;
}

function createBrowserFetchDeps(): BrowserSessionRuntimeRegistryDeps {
  return {
    async postPrompt(sessionId, input) {
      const { submitAgentPrompt } = await import("./agent-client");
      return submitAgentPrompt(sessionId, input);
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
