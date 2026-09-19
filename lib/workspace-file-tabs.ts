/**
 * File tabs in the secondary panel are scoped to the current workspace cwd.
 * Switching project/worktree (cwd change) must close the previous workspace's
 * files. Same-cwd session switches and projectRoot metadata fills do not.
 */

export type WorkspaceFileTab = {
  id: string;
  bufferKey?: string;
};

export function shouldResetFileTabsOnCwdChange(
  previousCwd: string | null,
  currentCwd: string | null,
): boolean {
  return previousCwd !== currentCwd;
}

export function planWorkspaceFileTabReset(input: {
  tabs: readonly WorkspaceFileTab[];
  dirtyBufferKeys: ReadonlySet<string>;
}): {
  closeIds: string[];
  removeBufferKeys: string[];
  keepTabs: WorkspaceFileTab[];
  pendingCloseTabId: string | null;
  closePanel: boolean;
} {
  const keepTabs: WorkspaceFileTab[] = [];
  const closeIds: string[] = [];
  const removeBufferKeys: string[] = [];
  for (const tab of input.tabs) {
    const dirty = Boolean(tab.bufferKey && input.dirtyBufferKeys.has(tab.bufferKey));
    if (dirty) {
      keepTabs.push(tab);
      continue;
    }
    closeIds.push(tab.id);
    if (tab.bufferKey) removeBufferKeys.push(tab.bufferKey);
  }
  return {
    closeIds,
    removeBufferKeys,
    keepTabs,
    pendingCloseTabId: keepTabs[0]?.id ?? null,
    closePanel: keepTabs.length === 0,
  };
}

export function nextActiveFileTabId(
  currentActiveId: string | null,
  keepTabs: readonly WorkspaceFileTab[],
): string | null {
  if (keepTabs.length === 0) return null;
  if (currentActiveId && keepTabs.some((tab) => tab.id === currentActiveId)) return currentActiveId;
  return keepTabs[0]?.id ?? null;
}
