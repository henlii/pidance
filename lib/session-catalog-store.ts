/**
 * Single owner for session list, optimistic pending, archive, running/starting,
 * and unread. Sidebar and chat only consume snapshots and dispatch actions.
 */

import type { SessionInfo } from "./types";
import {
  mergeOptimisticSessions,
  reconcilePendingSessionIds,
} from "../components/session-sidebar-state";
import {
  applyRunningUnreadStateTransition,
  emptyUnreadSessionState,
  markSessionRead,
  pruneUnreadSessionState,
  unreadIdsFromState,
  type UnreadSessionState,
} from "./unread-sessions-storage";

export type SessionCatalogListStatus = "idle" | "loading" | "ready" | "error";

export type SessionCatalogState = {
  serverSessions: SessionInfo[];
  pendingById: Map<string, SessionInfo>;
  pendingIds: Set<string>;
  deletedIds: Set<string>;
  archivedSessions: SessionInfo[];
  archivedCount: number;
  runningIds: Set<string>;
  startingIds: Set<string>;
  runningStartedAt: Map<string, number>;
  runningEpoch: Map<string, number>;
  unread: UnreadSessionState;
  loading: boolean;
  error: string | null;
  serverListLoaded: boolean;
  listStatus: SessionCatalogListStatus;
};

export type SessionCatalogSnapshot = {
  sessions: SessionInfo[];
  archivedSessions: SessionInfo[];
  archivedCount: number;
  runningIds: Set<string>;
  startingIds: Set<string>;
  effectiveRunningIds: Set<string>;
  unreadIds: Set<string>;
  loading: boolean;
  error: string | null;
  serverListLoaded: boolean;
  listStatus: SessionCatalogListStatus;
  runningStartedAt: Map<string, number>;
};

function cloneMap<K, V>(input: Map<K, V>): Map<K, V> {
  return new Map(input);
}

function cloneSet<T>(input: Set<T>): Set<T> {
  return new Set(input);
}

function unionSets(a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> {
  const next = new Set(a);
  for (const id of b) next.add(id);
  return next;
}

export type SessionCatalogStore = {
  getState(): SessionCatalogState;
  getSnapshot(selectedSessionId?: string | null): SessionCatalogSnapshot;
  subscribe(listener: () => void): () => void;
  applyServerList(input: {
    sessions: SessionInfo[];
    archivedSessions?: SessionInfo[];
    archivedCount?: number;
    runningSessionIds?: string[];
    runningStartedAt?: Record<string, number>;
    selectedSessionId?: string | null;
    now?: number;
  }): void;
  applyListError(message: string): void;
  beginListLoad(): void;
  upsertPending(session: SessionInfo): void;
  removePending(sessionId: string): void;
  markDeleted(sessionId: string): void;
  markStarting(sessionId: string, startedAt?: number): void;
  clearStarting(sessionId: string): void;
  applyRunningSnapshot(input: {
    runningIds: readonly string[];
    runningStartedAt?: Record<string, number>;
    selectedSessionId?: string | null;
    now?: number;
  }): void;
  markRead(sessionId: string, atIso?: string): void;
  replaceUnread(state: UnreadSessionState): void;
};

function initialState(): SessionCatalogState {
  return {
    serverSessions: [],
    pendingById: new Map(),
    pendingIds: new Set(),
    deletedIds: new Set(),
    archivedSessions: [],
    archivedCount: 0,
    runningIds: new Set(),
    startingIds: new Set(),
    runningStartedAt: new Map(),
    runningEpoch: new Map(),
    unread: emptyUnreadSessionState(),
    loading: false,
    error: null,
    serverListLoaded: false,
    listStatus: "idle",
  };
}

export function createSessionCatalogStore(options?: {
  now?: () => number;
}): SessionCatalogStore {
  const nowMs = options?.now ?? (() => Date.now());
  const state = initialState();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };

  const effectiveRunning = (): Set<string> => unionSets(state.runningIds, state.startingIds);

  const recyclePending = (serverSessions: readonly SessionInfo[], archivedSessions: readonly SessionInfo[]) => {
    const archivedIds = new Set(archivedSessions.map((session) => session.id));
    const serverIds = new Set(serverSessions.map((session) => session.id));
    let pendingChanged = false;
    const nextPending = new Map(state.pendingById);
    for (const id of [...nextPending.keys()]) {
      if (serverIds.has(id) || archivedIds.has(id) || state.deletedIds.has(id)) {
        nextPending.delete(id);
        pendingChanged = true;
      }
    }
    const nextPendingIds = reconcilePendingSessionIds(state.pendingIds, serverSessions);
    for (const id of [...nextPendingIds]) {
      if (archivedIds.has(id) || state.deletedIds.has(id)) {
        nextPendingIds.delete(id);
      }
    }
    if (pendingChanged) state.pendingById = nextPending;
    state.pendingIds = nextPendingIds;
  };

  const store: SessionCatalogStore = {
    getState() {
      return state;
    },
    getSnapshot(selectedSessionId = null) {
      const sessions = mergeOptimisticSessions({
        serverSessions: state.serverSessions,
        pendingSessions: [...state.pendingById.values()],
        pendingIds: state.pendingIds,
        deletedIds: state.deletedIds,
      });
      const running = effectiveRunning();
      const unreadIds = unreadIdsFromState(state.unread);
      for (const id of running) unreadIds.delete(id);
      if (selectedSessionId) unreadIds.delete(selectedSessionId);
      return {
        sessions,
        archivedSessions: state.archivedSessions,
        archivedCount: state.archivedCount,
        runningIds: cloneSet(state.runningIds),
        startingIds: cloneSet(state.startingIds),
        effectiveRunningIds: running,
        unreadIds,
        loading: state.loading,
        error: state.error,
        serverListLoaded: state.serverListLoaded,
        listStatus: state.listStatus,
        runningStartedAt: cloneMap(state.runningStartedAt),
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    applyServerList(input) {
      const archivedSessions = input.archivedSessions ?? [];
      state.serverSessions = [...input.sessions];
      state.archivedSessions = archivedSessions;
      state.archivedCount = input.archivedCount ?? archivedSessions.length;
      state.loading = false;
      state.error = null;
      state.serverListLoaded = true;
      state.listStatus = "ready";
      recyclePending(input.sessions, archivedSessions);
      const keep = new Set([
        ...input.sessions.map((session) => session.id),
        ...state.pendingIds,
      ]);
      state.unread = pruneUnreadSessionState(state.unread, keep);
      if (input.runningSessionIds && state.runningIds.size === 0 && state.startingIds.size === 0) {
        store.applyRunningSnapshot({
          runningIds: input.runningSessionIds,
          runningStartedAt: input.runningStartedAt,
          selectedSessionId: input.selectedSessionId,
          now: input.now,
        });
      } else if (input.runningStartedAt) {
        const nextStarted = new Map(state.runningStartedAt);
        for (const [id, ts] of Object.entries(input.runningStartedAt)) {
          if (!nextStarted.has(id) && typeof ts === "number") nextStarted.set(id, ts);
        }
        state.runningStartedAt = nextStarted;
      }
      emit();
    },
    applyListError(message) {
      state.loading = false;
      state.error = message;
      state.listStatus = "error";
      emit();
    },
    beginListLoad() {
      if (state.listStatus === "idle") state.listStatus = "loading";
      state.loading = state.serverSessions.length === 0 && state.pendingById.size === 0;
      emit();
    },
    upsertPending(session) {
      if (state.deletedIds.has(session.id)) return;
      const next = new Map(state.pendingById);
      next.set(session.id, session);
      state.pendingById = next;
      const ids = new Set(state.pendingIds);
      ids.add(session.id);
      state.pendingIds = ids;
      emit();
    },
    removePending(sessionId) {
      if (!state.pendingById.has(sessionId) && !state.pendingIds.has(sessionId)) return;
      const next = new Map(state.pendingById);
      next.delete(sessionId);
      state.pendingById = next;
      const ids = new Set(state.pendingIds);
      ids.delete(sessionId);
      state.pendingIds = ids;
      emit();
    },
    markDeleted(sessionId) {
      const deleted = new Set(state.deletedIds);
      deleted.add(sessionId);
      state.deletedIds = deleted;
      store.removePending(sessionId);
      const starting = new Set(state.startingIds);
      starting.delete(sessionId);
      state.startingIds = starting;
      emit();
    },
    markStarting(sessionId, startedAt = nowMs()) {
      if (!sessionId) return;
      const starting = new Set(state.startingIds);
      starting.add(sessionId);
      state.startingIds = starting;
      const started = new Map(state.runningStartedAt);
      if (!started.has(sessionId)) started.set(sessionId, startedAt);
      state.runningStartedAt = started;
      emit();
    },
    clearStarting(sessionId) {
      if (!state.startingIds.has(sessionId)) return;
      const starting = new Set(state.startingIds);
      starting.delete(sessionId);
      state.startingIds = starting;
      emit();
    },
    applyRunningSnapshot(input) {
      const nextRunning = new Set(input.runningIds);
      const previousEffective = effectiveRunning();
      const nextStarted = new Map(state.runningStartedAt);
      const nextEpoch = new Map(state.runningEpoch);
      const now = input.now ?? nowMs();
      const nowIso = new Date(now).toISOString();

      if (input.runningStartedAt) {
        for (const [id, ts] of Object.entries(input.runningStartedAt)) {
          if (typeof ts !== "number") continue;
          const previous = nextStarted.get(id);
          if (previous !== undefined && previous !== ts && nextRunning.has(id)) {
            nextEpoch.set(id, (nextEpoch.get(id) ?? 0) + 1);
            state.unread = applyRunningUnreadStateTransition(
              state.unread,
              new Set([id]),
              new Set(),
              input.selectedSessionId ?? null,
              nowIso,
            );
          }
          nextStarted.set(id, ts);
        }
      }

      for (const id of nextRunning) {
        if (!nextStarted.has(id)) nextStarted.set(id, now);
      }
      for (const id of [...nextStarted.keys()]) {
        if (!nextRunning.has(id) && !state.startingIds.has(id)) nextStarted.delete(id);
      }

      const nextEffective = unionSets(nextRunning, state.startingIds);
      state.unread = applyRunningUnreadStateTransition(
        state.unread,
        previousEffective,
        nextEffective,
        input.selectedSessionId ?? null,
        nowIso,
      );
      state.runningIds = nextRunning;
      state.runningStartedAt = nextStarted;
      state.runningEpoch = nextEpoch;
      for (const id of nextRunning) {
        if (state.startingIds.has(id)) {
          const starting = new Set(state.startingIds);
          starting.delete(id);
          state.startingIds = starting;
        }
      }
      emit();
    },
    markRead(sessionId, atIso = new Date(nowMs()).toISOString()) {
      const next = markSessionRead(state.unread, sessionId, atIso);
      if (next === state.unread) return;
      state.unread = next;
      emit();
    },
    replaceUnread(next) {
      state.unread = next;
      emit();
    },
  };

  return store;
}
