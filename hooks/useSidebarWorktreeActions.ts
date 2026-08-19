import { useCallback, useEffect, useState } from "react";
import { upsertProjectWorktreeSnapshot, type ProjectWorktreeSnapshots } from "@/components/session-sidebar-state";

export interface UseSidebarWorktreeActionsParams {
  selectedCwd: string | null;
  selectCwd: (cwd: string, projectRoot: string) => void;
  commitWorktreeSnapshots: (updater: (prev: ProjectWorktreeSnapshots) => ProjectWorktreeSnapshots) => void;
  setWtRefreshKey: React.Dispatch<React.SetStateAction<number>>;
}

/**
 * 侧栏 worktree 创建/删除动作。预加载快照仍由 useWorktreePreload 拥有。
 */
export function useSidebarWorktreeActions({
  selectedCwd,
  selectCwd,
  commitWorktreeSnapshots,
  setWtRefreshKey,
}: UseSidebarWorktreeActionsParams) {
  const [wtNewForProject, setWtNewForProject] = useState<string | null>(null);
  const [wtNewBranch, setWtNewBranch] = useState("");
  const [wtError, setWtError] = useState<string | null>(null);
  const [wtErrorRoot, setWtErrorRoot] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtConfirmRemove, setWtConfirmRemove] = useState<string | null>(null);

  useEffect(() => {
    setWtNewForProject(null);
    setWtNewBranch("");
    setWtError(null);
    setWtErrorRoot(null);
    setWtConfirmRemove(null);
  }, [selectedCwd]);

  const handleCreateWorktree = useCallback(async () => {
    const projectRoot = wtNewForProject;
    const branch = wtNewBranch.trim();
    if (!branch || wtBusy || !projectRoot) return;
    setWtBusy(true);
    setWtError(null);
    setWtErrorRoot(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectRoot, branch }),
      });
      const data = await res.json().catch(() => ({})) as { path?: string; error?: string };
      if (!res.ok || data.error || !data.path) {
        setWtError(data.error ?? `HTTP ${res.status}`);
        setWtErrorRoot(projectRoot);
        return;
      }
      setWtNewForProject(null);
      setWtNewBranch("");
      commitWorktreeSnapshots((prev) => upsertProjectWorktreeSnapshot(prev, projectRoot, {
        status: "ready",
        worktrees: [...(prev[projectRoot]?.worktrees ?? []), { path: data.path!, branch, isMain: false }],
      }));
      selectCwd(data.path, projectRoot);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
      setWtErrorRoot(projectRoot);
    } finally {
      setWtBusy(false);
    }
  }, [wtNewForProject, wtNewBranch, wtBusy, commitWorktreeSnapshots, selectCwd, setWtRefreshKey]);

  const handleRemoveWorktree = useCallback(async (projectRoot: string, path: string, force: boolean) => {
    if (wtBusy) return;
    setWtBusy(true);
    setWtError(null);
    setWtErrorRoot(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectRoot, path, force }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean };
      if (!res.ok) {
        if (data.dirty && !force) {
          setWtConfirmRemove(path);
          return;
        }
        setWtError(data.error ?? `HTTP ${res.status}`);
        setWtErrorRoot(projectRoot);
        return;
      }
      setWtConfirmRemove(null);
      if (selectedCwd === path) selectCwd(projectRoot, projectRoot);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
      setWtErrorRoot(projectRoot);
    } finally {
      setWtBusy(false);
    }
  }, [wtBusy, selectedCwd, selectCwd, setWtRefreshKey]);

  return {
    wtNewForProject,
    setWtNewForProject,
    wtNewBranch,
    setWtNewBranch,
    wtError,
    setWtError,
    wtErrorRoot,
    setWtErrorRoot,
    wtBusy,
    wtConfirmRemove,
    setWtConfirmRemove,
    handleCreateWorktree,
    handleRemoveWorktree,
  };
}
