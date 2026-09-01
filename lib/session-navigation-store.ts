/**
 * Session target state machine. Atomic owner of selection, new-session intent,
 * URL restore, and identity-follow decisions. No suppress refs or time gates.
 */

import { createNewSessionIntent, type NewSessionIntent } from "./new-session-intent";

export type SessionTarget =
  | { kind: "none" }
  | { kind: "new"; intentId: string; cwd: string; generation: number }
  | { kind: "persisted"; sessionId: string; cwd: string; projectRoot?: string };

export type UrlRestoreState =
  | { kind: "idle" }
  | { kind: "loading"; sessionId: string }
  | { kind: "ready" }
  | { kind: "not-found"; sessionId: string }
  | { kind: "error"; sessionId: string; message: string };

export type SessionNavigationState = {
  target: SessionTarget;
  urlRestore: UrlRestoreState;
  intentGeneration: number;
};

export type PersistedSessionRef = {
  id: string;
  cwd: string;
  projectRoot?: string | null;
};

export type IdentityRef = {
  cwd: string | null;
  projectRoot?: string | null;
};

export type UrlRestoreResult =
  | { found: true; session: PersistedSessionRef }
  | { found: false }
  | { error: string };

function sameTarget(a: SessionTarget, b: SessionTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "none" && b.kind === "none") return true;
  if (a.kind === "new" && b.kind === "new") {
    return a.intentId === b.intentId && a.cwd === b.cwd && a.generation === b.generation;
  }
  if (a.kind === "persisted" && b.kind === "persisted") {
    return a.sessionId === b.sessionId && a.cwd === b.cwd && a.projectRoot === b.projectRoot;
  }
  return false;
}

function sameRestore(a: UrlRestoreState, b: UrlRestoreState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "loading" && b.kind === "loading") return a.sessionId === b.sessionId;
  if (a.kind === "not-found" && b.kind === "not-found") return a.sessionId === b.sessionId;
  if (a.kind === "error" && b.kind === "error") {
    return a.sessionId === b.sessionId && a.message === b.message;
  }
  return true;
}

function targetMatchesIdentity(target: SessionTarget, identity: IdentityRef): boolean {
  if (!identity.cwd) return false;
  if (target.kind === "new") return target.cwd === identity.cwd;
  if (target.kind === "persisted") {
    if (target.cwd === identity.cwd) return true;
    if (identity.projectRoot && (target.projectRoot ?? target.cwd) === identity.projectRoot) {
      return true;
    }
  }
  return false;
}

export type SessionNavigationStore = {
  getState(): SessionNavigationState;
  subscribe(listener: () => void): () => void;
  selectPersisted(session: PersistedSessionRef): SessionNavigationState;
  startNew(cwd: string): SessionNavigationState;
  promote(intentId: string, session: PersistedSessionRef): boolean;
  applyHydrate(session: PersistedSessionRef): boolean;
  applyIdentityChange(identity: IdentityRef, previous: IdentityRef): SessionNavigationState;
  deleteSession(sessionId: string, nextCwd?: string | null): SessionNavigationState;
  forkTo(session: PersistedSessionRef): SessionNavigationState;
  beginUrlRestore(sessionId: string): SessionNavigationState;
  completeUrlRestore(result: UrlRestoreResult): SessionNavigationState;
  retryUrlRestore(): string | null;
  currentIntent(): NewSessionIntent | null;
  selectedSessionId(): string | null;
};

export function createSessionNavigationStore(options?: {
  makeIntentId?: () => string;
}): SessionNavigationStore {
  const makeIntentId = options?.makeIntentId;
  let state: SessionNavigationState = {
    target: { kind: "none" },
    urlRestore: { kind: "idle" },
    intentGeneration: 0,
  };
  const listeners = new Set<() => void>();

  const emit = (next: SessionNavigationState): SessionNavigationState => {
    if (
      sameTarget(state.target, next.target)
      && sameRestore(state.urlRestore, next.urlRestore)
      && state.intentGeneration === next.intentGeneration
    ) {
      return state;
    }
    state = next;
    for (const listener of listeners) listener();
    return state;
  };

  const startNew = (cwd: string): SessionNavigationState => {
    state.intentGeneration += 1;
    const intent = createNewSessionIntent(cwd, state.intentGeneration, makeIntentId);
    return emit({
      target: {
        kind: "new",
        intentId: intent.id,
        cwd: intent.cwd,
        generation: intent.generation,
      },
      urlRestore: { kind: "ready" },
      intentGeneration: state.intentGeneration,
    });
  };

  const store: SessionNavigationStore = {
    getState() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    selectPersisted(session) {
      return emit({
        target: {
          kind: "persisted",
          sessionId: session.id,
          cwd: session.cwd,
          projectRoot: session.projectRoot ?? undefined,
        },
        urlRestore: { kind: "ready" },
        intentGeneration: state.intentGeneration,
      });
    },
    startNew,
    promote(intentId, session) {
      const current = state.target;
      if (current.kind !== "new" || current.intentId !== intentId) return false;
      emit({
        target: {
          kind: "persisted",
          sessionId: session.id,
          cwd: session.cwd || current.cwd,
          projectRoot: session.projectRoot ?? undefined,
        },
        urlRestore: { kind: "ready" },
        intentGeneration: state.intentGeneration,
      });
      return true;
    },
    applyHydrate(session) {
      const current = state.target;
      if (current.kind !== "persisted" || current.sessionId !== session.id) return false;
      emit({
        ...state,
        target: {
          kind: "persisted",
          sessionId: session.id,
          cwd: session.cwd || current.cwd,
          projectRoot: session.projectRoot ?? current.projectRoot,
        },
      });
      return true;
    },
    applyIdentityChange(identity, previous) {
      const cwdChanged = previous.cwd !== identity.cwd;
      const projectChanged = previous.projectRoot !== identity.projectRoot;
      if (!cwdChanged && !projectChanged) return state;

      if (!previous.cwd && !previous.projectRoot) {
        if (state.target.kind === "none" && identity.cwd) return startNew(identity.cwd);
        return state;
      }

      if (targetMatchesIdentity(state.target, identity)) {
        if (state.target.kind === "persisted" && identity.projectRoot && state.target.projectRoot !== identity.projectRoot) {
          return emit({
            ...state,
            target: { ...state.target, projectRoot: identity.projectRoot },
          });
        }
        return state;
      }

      if (identity.cwd) return startNew(identity.cwd);
      return emit({
        target: { kind: "none" },
        urlRestore: { kind: "ready" },
        intentGeneration: state.intentGeneration,
      });
    },
    deleteSession(sessionId, nextCwd) {
      const current = state.target;
      if (current.kind !== "persisted" || current.sessionId !== sessionId) return state;
      if (nextCwd) return startNew(nextCwd);
      return emit({
        target: { kind: "none" },
        urlRestore: { kind: "ready" },
        intentGeneration: state.intentGeneration,
      });
    },
    forkTo(session) {
      return store.selectPersisted(session);
    },
    beginUrlRestore(sessionId) {
      return emit({
        ...state,
        urlRestore: { kind: "loading", sessionId },
      });
    },
    completeUrlRestore(result) {
      const restore = state.urlRestore;
      const sessionId = restore.kind === "loading" || restore.kind === "error" || restore.kind === "not-found"
        ? restore.sessionId
        : null;
      if (!sessionId) return state;
      if ("error" in result) {
        return emit({
          ...state,
          urlRestore: { kind: "error", sessionId, message: result.error },
        });
      }
      if (result.found === true) {
        return store.selectPersisted(result.session);
      }
      return emit({
        target: state.target.kind === "persisted" && state.target.sessionId === sessionId
          ? { kind: "none" }
          : state.target,
        urlRestore: { kind: "not-found", sessionId },
        intentGeneration: state.intentGeneration,
      });
    },
    retryUrlRestore() {
      const restore = state.urlRestore;
      if (restore.kind !== "error") return null;
      emit({
        ...state,
        urlRestore: { kind: "loading", sessionId: restore.sessionId },
      });
      return restore.sessionId;
    },
    currentIntent() {
      const target = state.target;
      if (target.kind !== "new") return null;
      return { id: target.intentId, cwd: target.cwd, generation: target.generation };
    },
    selectedSessionId() {
      return state.target.kind === "persisted" ? state.target.sessionId : null;
    },
  };

  return store;
}
