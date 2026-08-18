import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { SessionInfo } from "@/lib/types";
import {
  getRecentProjects,
  shouldApplyWorktreeIdentityPatch,
  type WorktreeEntry,
  type WorktreeState,
} from "@/lib/project-context";
import type { ProjectIdentitySnapshot } from "@/lib/project-context";
import {
  buildKnownProjectRoots,
  buildWorktreePreloadGeneration,
  upsertCanonicalProjectWorktreeSnapshot,
  upsertProjectWorktreeSnapshot,
  type ProjectWorktreeSnapshots,
} from "@/components/session-sidebar-state";

export interface UseWorktreePreloadParams {
  allSessions: SessionInfo[];
  selectedCwd: string | null;
  selectedProjectRoot: string | null;
  setIdentity: (patch: Partial<ProjectIdentitySnapshot>) => void;
  getIdentitySnapshot: () => ProjectIdentitySnapshot;
  mountedRef: MutableRefObject<boolean>;
}

export interface UseWorktreePreloadResult {
  worktreeSnapshots: ProjectWorktreeSnapshots;
  worktreeSnapshotsRef: MutableRefObject<ProjectWorktreeSnapshots>;
  worktreeMetadata: Readonly<Record<string, Pick<WorktreeState, "isGit" | "isTopLevel">>>;
  wtRefreshKey: number;
  setWtRefreshKey: React.Dispatch<React.SetStateAction<number>>;
  commitWorktreeSnapshots: (updater: (prev: ProjectWorktreeSnapshots) => ProjectWorktreeSnapshots) => void;
  fetchProjectWorktrees: (projectRoot: string) => Promise<void>;
  knownProjectRoots: readonly string[];
}

/**
 * worktree 快照预加载：每个项目 root 独立拉取，请求去重，结果只写自身 key，
 * 旧请求不能覆盖别的项目。卸载后（mountedRef=false 或 token 失效）不再 setState。
 * mountedRef 由主组件持有（会话列表加载等多处共用），此处只读。
 */
export function useWorktreePreload({
  allSessions,
  selectedCwd,
  selectedProjectRoot,
  setIdentity,
  getIdentitySnapshot,
  mountedRef,
}: UseWorktreePreloadParams): UseWorktreePreloadResult {
  // 每个项目独立的 worktree 快照：缓存优先，后台限流预加载。
  const [worktreeSnapshots, setWorktreeSnapshots] = useState<ProjectWorktreeSnapshots>({});
  const worktreeSnapshotsRef = useRef<ProjectWorktreeSnapshots>({});
  const [worktreeMetadata, setWorktreeMetadata] = useState<Readonly<Record<string, Pick<WorktreeState, "isGit" | "isTopLevel">>>>({});
  const worktreeRequestsRef = useRef(new Set<string>());
  const worktreeRequestTokenRef = useRef(new Map<string, string>());
  const [wtRefreshKey, setWtRefreshKey] = useState(0);

  const commitWorktreeSnapshots = useCallback((updater: (prev: ProjectWorktreeSnapshots) => ProjectWorktreeSnapshots) => {
    setWorktreeSnapshots((prev) => {
      const next = updater(prev);
      worktreeSnapshotsRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => () => {
    worktreeRequestTokenRef.current.clear();
  }, []);

  // 每个项目 root 独立拉取；请求中去重，结果只写自身 key，旧请求不能覆盖别的项目。
  const fetchProjectWorktrees = useCallback(async (projectRoot: string) => {
    if (worktreeRequestsRef.current.has(projectRoot)) return;
    const token = `${Date.now()}:${Math.random()}`;
    worktreeRequestsRef.current.add(projectRoot);
    worktreeRequestTokenRef.current.set(projectRoot, token);
    commitWorktreeSnapshots((prev) => upsertProjectWorktreeSnapshot(prev, projectRoot, { status: "loading" }));
    try {
      const response = await fetch(`/api/worktrees?cwd=${encodeURIComponent(projectRoot)}`);
      const data = await response.json().catch(() => ({})) as {
        projectRoot?: string;
        isGit?: boolean;
        isTopLevel?: boolean;
        worktrees?: WorktreeEntry[];
        error?: string;
      };
      if (!response.ok || data.error || !data.projectRoot) throw new Error(data.error ?? `HTTP ${response.status}`);
      if (!mountedRef.current || worktreeRequestTokenRef.current.get(projectRoot) !== token) return;
      const canonicalRoot = data.projectRoot;
      const worktrees = data.worktrees ?? [];
      // 服务端返回的权威 projectRoot 才是快照 key；请求 root 是 worktree 路径时
      // 只写 canonicalRoot 并移除请求 root（含 loading 条目），避免 buildSidebarTree
      // 把 worktree 路径当项目根创建「项目 + 工作树」分组。
      commitWorktreeSnapshots((prev) =>
        upsertCanonicalProjectWorktreeSnapshot(prev, projectRoot, canonicalRoot, worktrees),
      );
      setWorktreeMetadata((prev) => {
        const metadata = { isGit: data.isGit ?? false, isTopLevel: data.isTopLevel ?? false };
        return canonicalRoot === projectRoot
          ? { ...prev, [projectRoot]: metadata }
          : { ...prev, [canonicalRoot]: metadata };
      });
      const snap = getIdentitySnapshot();
      if (shouldApplyWorktreeIdentityPatch({
        snapshotCwd: snap.cwd,
        snapshotProjectRoot: snap.projectRoot,
        requestedRoot: projectRoot,
        canonicalRoot,
      })) {
        setIdentity({
          cwd: snap.cwd,
          projectRoot: canonicalRoot,
          branch: worktrees.find((worktree) => worktree.path === snap.cwd)?.branch ?? snap.branch,
          isGit: data.isGit ?? false,
          isTopLevel: data.isTopLevel ?? false,
          status: "ready",
          error: null,
        });
      }
    } catch (error) {
      if (!mountedRef.current || worktreeRequestTokenRef.current.get(projectRoot) !== token) return;
      commitWorktreeSnapshots((prev) => upsertProjectWorktreeSnapshot(prev, projectRoot, {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      if (worktreeRequestTokenRef.current.get(projectRoot) === token) {
        worktreeRequestTokenRef.current.delete(projectRoot);
        worktreeRequestsRef.current.delete(projectRoot);
      }
    }
  }, [commitWorktreeSnapshots, getIdentitySnapshot, setIdentity, mountedRef]);

  const knownProjectRoots = useMemo(
    () => buildKnownProjectRoots(getRecentProjects(allSessions), selectedCwd, selectedProjectRoot),
    [allSessions, selectedCwd, selectedProjectRoot],
  );
  // worktree 预加载只跟 wtRefreshKey + known roots；session list refresh 不得重抓 worktree。
  // generation 不含 refreshKey（见 buildWorktreePreloadGeneration）。
  const worktreePreloadGenerationRef = useRef(new Map<string, string>());
  useEffect(() => {
    const generation = buildWorktreePreloadGeneration(wtRefreshKey);
    const queue = knownProjectRoots.filter((root) => worktreePreloadGenerationRef.current.get(root) !== generation);
    for (const root of queue) worktreePreloadGenerationRef.current.set(root, generation);
    let cancelled = false;
    const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (!cancelled) {
        const root = queue.shift();
        if (!root) return;
        await fetchProjectWorktrees(root);
      }
    });
    void Promise.all(workers);
    return () => { cancelled = true; };
  }, [knownProjectRoots, wtRefreshKey, fetchProjectWorktrees]);

  return {
    worktreeSnapshots,
    worktreeSnapshotsRef,
    worktreeMetadata,
    wtRefreshKey,
    setWtRefreshKey,
    commitWorktreeSnapshots,
    fetchProjectWorktrees,
    knownProjectRoots,
  };
}
