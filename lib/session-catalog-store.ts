/**
 * Single owner for session list, optimistic pending, archive, running/starting,
 * and unread. Sidebar and chat only consume snapshots and dispatch actions.
 */

import type { SessionInfo } from "./types";
import type { BrowserSessionRuntimeRegistry } from "./browser-session-runtime-registry";
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
    /**
     * 本地仍在本进程在途的 send（registry 为准）。乐观 starting 标记只允许在这些 id
     * 上跨过「权威快照未含它」的时刻，其余一律回收。
     */
    localInFlightIds?: readonly string[];
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

/**
 * 乐观 starting 标记由当前 chat 上报，chat 切走后没人撤销：本地提交结算（被拒/失败）
 * 不会再产生任何权威快照，标记会永久残留「运行中」。因此已登记的标记直接订阅 registry
 * （run 的 owner，chat 卸载不影响它）：本地既无 run 也无在途 send → 立即回收；服务端
 * 已确认在跑 / 仍在提交中的标记不动（后续由权威快照规则接管）。
 *
 * @returns 解除挂钩（同时退订所有已登记标记）
 */
export function linkStartingMarksToRegistry(
  store: Pick<SessionCatalogStore, "getState" | "subscribe" | "clearStarting">,
  registry: Pick<BrowserSessionRuntimeRegistry, "subscribe">,
): () => void {
  const watchers = new Map<string, () => void>();
  const sync = () => {
    const starting = store.getState().startingIds;
    for (const [id, unsubscribe] of [...watchers]) {
      if (starting.has(id)) continue;
      unsubscribe();
      watchers.delete(id);
    }
    for (const id of starting) {
      if (watchers.has(id)) continue;
      // registry.subscribe 同步回调首个快照，回调可能立即回收标记并重入 sync()：
      // 先登记占位 token，subscribe 返回后按当前状态决定保存还是立即退订。
      watchers.set(id, () => {});
      const unsubscribe = registry.subscribe(id, (snapshot) => {
        if (snapshot.agentRunning || snapshot.sendInFlight) return;
        store.clearStarting(id);
      });
      const placeholder = watchers.get(id);
      if (placeholder !== undefined && store.getState().startingIds.has(id)) {
        watchers.set(id, unsubscribe);
      } else {
        unsubscribe();
        watchers.delete(id);
      }
    }
  };
  const unsubscribeStore = store.subscribe(sync);
  sync();
  return () => {
    unsubscribeStore();
    for (const unsubscribe of watchers.values()) unsubscribe();
    watchers.clear();
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

  /**
   * 下一组乐观 starting 标记：只保留「服务端尚未确认在跑」且「本地 send 仍在本进程
   * 在途」的 id。服务端已确认在跑 → 徽标由 runningIds 承担；权威快照不含且本地无
   * 在途 send → 这轮 run 已结束（或从未注册），标记必须回收，否则会永久残留
   * 「运行中」——例如切走会话后 run 结束，快照不再含该 id，没有任何视图负责撤销。
   */
  const nextStarting = (runningIds: ReadonlySet<string>, localInFlightIds: ReadonlySet<string>): Set<string> => {
    const next = new Set<string>();
    for (const id of state.startingIds) {
      if (runningIds.has(id)) continue;
      if (localInFlightIds.has(id)) next.add(id);
    }
    return next;
  };

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
      state.serverListLoaded = true;
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
      // 计时播种同步退出：registry 结算路径（提交被拒/失败）不会再产生全局快照，
      // 留着旧起点会让下一次发送沿用上一轮的时间。服务端仍在跑的 id 不动。
      if (!state.runningIds.has(sessionId) && state.runningStartedAt.has(sessionId)) {
        const started = new Map(state.runningStartedAt);
        started.delete(sessionId);
        state.runningStartedAt = started;
      }
      emit();
    },
    applyRunningSnapshot(input) {
      const nextRunning = new Set(input.runningIds);
      const nextStartingIds = nextStarting(nextRunning, new Set(input.localInFlightIds ?? []));
      // 完成判定只看服务端确认过的在跑集：乐观 starting 标记从未被服务端确认时
      // （发送被拒/失败），回收标记不得当成「跑完了一轮」而产生未读。
      const previousServerRunning = state.runningIds;
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
        if (!nextRunning.has(id) && !nextStartingIds.has(id)) nextStarted.delete(id);
      }

      const nextEffective = unionSets(nextRunning, nextStartingIds);
      state.unread = applyRunningUnreadStateTransition(
        state.unread,
        previousServerRunning,
        nextEffective,
        input.selectedSessionId ?? null,
        nowIso,
      );
      state.runningIds = nextRunning;
      state.startingIds = nextStartingIds;
      state.runningStartedAt = nextStarted;
      state.runningEpoch = nextEpoch;
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
