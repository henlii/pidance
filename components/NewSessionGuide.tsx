"use client";

/**
 * 新会话引导选择器（OpenChamber draft-target-selectors 语义）：
 * 空态时在输入框上方提供 项目 + 分支 两个紧凑下拉。
 * - 选择目标目录；同时经 onTargetChange 同步全局项目身份（文件栏/Git/标题）
 * - 不创建会话、不跳转路由（发送第一条消息才建会话）
 * - 发送第一条消息时新会话才在目标目录创建（Pidance 懒创建）
 * - 选择持久化到 localStorage（ChatWindow 管理），回到空态自动恢复
 * - 项目下拉：/api/sessions 聚合最近 cwd（去重、按最近使用排序）
 * - 分支下拉：选定项目后加载其 git 工作树（主工作树分组 + 工作树分组；/api/worktrees）
 * - 非 git 项目：无分支选择器，选项目即设为目标（OpenChamber 语义）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Folder, GitBranch, Plus } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { loadSidebarPreferences } from "@/lib/ui-preferences";
import { loadCachedSessionList, saveCachedSessionList } from "@/lib/session-list-cache";
import type { SessionInfo } from "@/lib/types";
import {
  GUIDE_WORKTREES_STORAGE_KEY,
  aggregateGuideProjects,
  beginWorktreeLoad,
  clearDefaultWorktreeCache,
  getDefaultWorktreeCache,
  hydrateWorktreeCache,
  parsePersistedWorktrees,
  resolveGuideTargetProject,
  serializePersistedWorktrees,
  type GuideProject,
  type GuideWorktreeInfo,
  type PersistedWorktreeEntry,
  type WorktreeCacheState,
} from "@/lib/guide-load-cache";

// localStorage 读写薄封装（与 session-list-cache 对称：隐私模式/配额/损坏静默降级）。
function readPersistedWorktrees(): Map<string, PersistedWorktreeEntry> {
  try {
    const raw =
      typeof window === "undefined"
        ? null
        : window.localStorage.getItem(GUIDE_WORKTREES_STORAGE_KEY);
    return parsePersistedWorktrees(raw, Date.now());
  } catch {
    return new Map();
  }
}

function writePersistedWorktrees(entries: Map<string, PersistedWorktreeEntry>): void {
  try {
    window.localStorage.setItem(
      GUIDE_WORKTREES_STORAGE_KEY,
      serializePersistedWorktrees(entries),
    );
  } catch {
    // ignore（隐私模式 / 配额）
  }
}

type Props = {
  /** 当前新会话目标目录（项目根或工作树路径）；null = 未选择 */
   targetCwd: string | null;
  /** 选择目标；projectRoot 为所属主仓（工作树时与 cwd 不同） */
   onTargetChange: (cwd: string | null, projectRoot?: string | null) => void;
 };

/** 项目下拉显示名：取路径末段（项目名）；全路径放 tooltip。 */
function projectDisplayName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const seg = trimmed.split(/[\\/]/).filter(Boolean).pop();
  return seg || cwd;
}

export function NewSessionGuide({ targetCwd, onTargetChange }: Props) {
  const { t } = useI18n();
  const [projects, setProjects] = useState<GuideProject[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  /** 项目级选择（驱动分支加载） */
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<GuideWorktreeInfo[] | null>(null);
  const [loadingWorktrees, setLoadingWorktrees] = useState(false);
  /**
   * 工作树加载缓存（纯逻辑：in-flight 去重 + stale-while-revalidate + TTL）。
   * 用模块级默认缓存单例而非组件实例级：引导页是条件渲染（空态才挂载），
   * 实例级缓存每次打开都会全空、同一项目工作树被迫重新 fetch；默认缓存跨
   * 组件挂载/卸载复用（SPA 生命周期内），页面刷新自然重建。
   */
  const worktreeCacheRef = useRef<WorktreeCacheState>(getDefaultWorktreeCache());
  /** 同步当前选中的项目，避免迟到的 worktree 响应覆盖新选中项 */
  const selectedCwdRef = useRef<string | null>(null);

  // 恢复持久化目标：targetCwd 匹配项目根/最长前缀 → 自动选中该项目并加载分支。
  const restoreTargetRef = useRef((sorted: GuideProject[]) => {
    if (!targetCwd) return;
    const resolved = resolveGuideTargetProject(sorted, targetCwd);
    if (resolved) {
      setSelectedCwd(resolved);
      void loadWorktreesRef.current(resolved);
    }
  });

  // 挂载时从 localStorage 恢复持久化工作树缓存（hydrate 只补缺失条目，不覆盖
  // 模块级缓存已有数据）。必须声明在本 effect 之前，使下方 restoreTarget 触发
  // 的 loadWorktrees 能直接命中 stale 秒渲染，避免刷新后首开引导页再等
  // /api/worktrees（服务端冷态 2.7s / 热态 22ms）。
  useEffect(() => {
    hydrateWorktreeCache(worktreeCacheRef.current, readPersistedWorktrees());
  }, []);

  // 项目下拉合并「主动添加的项目」（无会话也展示，可直接发起会话）。
  const addedProjectRoots = useMemo(() => loadSidebarPreferences().addedProjectRoots, []);

  useEffect(() => {
    let cancelled = false;
    // 先读本地缓存（localStorage，与 SessionSidebar 共享）：秒渲染最近项目，
    // 后台 fetch 刷新后覆盖（stale-while-revalidate）；拉取失败保留旧列表。
    const cached = loadCachedSessionList();
    if (cached && cached.length > 0) {
      const sorted = aggregateGuideProjects(cached, 12, addedProjectRoots);
      setProjects(sorted);
      setLoadingProjects(false);
      restoreTargetRef.current(sorted);
    }
    void (async () => {
      try {
        const res = await fetch("/api/sessions");
        const data = (await res.json()) as { sessions?: SessionInfo[] };
        const sessions = data.sessions ?? [];
        saveCachedSessionList(sessions);
        const sorted = aggregateGuideProjects(sessions, 12, addedProjectRoots);
        if (!cancelled) {
          setProjects(sorted);
          restoreTargetRef.current(sorted);
        }
      } catch {
        // 拉取失败：保留本地缓存渲染的旧列表（无缓存时保持空列表）
      } finally {
        if (!cancelled) setLoadingProjects(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // 仅 mount 时执行（targetCwd 的后续变化由分支选择链路处理）
  }, [addedProjectRoots]);

  const loadWorktrees = useCallback((cwd: string): Promise<void> => {
    setSelectedCwd(cwd);
    selectedCwdRef.current = cwd;
    const handle = beginWorktreeLoad(worktreeCacheRef.current, cwd, async () => {
      const params = new URLSearchParams({ cwd });
      const res = await fetch(`/api/worktrees?${params.toString()}`);
      const data = (await res.json()) as {
        worktrees?: GuideWorktreeInfo[];
        isGit?: boolean;
      };
      const wts = data.worktrees ?? [];
      // fetch 成功后写回 localStorage（合并该 cwd 条目；读取时已过滤过期条目，
      // 写入自然清理旧数据）。失败不写回，保留已有持久化数据。
      const persisted = readPersistedWorktrees();
      persisted.set(cwd, { items: wts, at: Date.now() });
      writePersistedWorktrees(persisted);
      return wts;
    });
    if (handle.stale) {
      // SWR：已有该 cwd 的旧列表 → 立即显示，后台刷新完成后覆盖
      setWorktrees(handle.stale);
      setLoadingWorktrees(false);
    } else {
      // 该 cwd 首次加载：无数据可显示，进入 loading（切换项目时清空旧项目的分支）
      setWorktrees(null);
      setLoadingWorktrees(true);
    }
    return handle.promise
      .then((wts) => {
        if (selectedCwdRef.current === cwd) {
          setWorktrees(wts);
          setLoadingWorktrees(false);
        }
      })
      .catch(() => {
        if (selectedCwdRef.current === cwd) {
          // 失败：保留旧数据（stale 已显示）或空列表
          setWorktrees((prev) => prev ?? []);
          setLoadingWorktrees(false);
        }
      });
  }, []);
  const loadWorktreesRef = useRef(loadWorktrees);
  loadWorktreesRef.current = loadWorktrees;

  const main = worktrees?.find((w) => w.isMain) ?? null;
  const branches = worktrees?.filter((w) => !w.isMain) ?? [];
  const isGit = worktrees !== null && worktrees.length > 0;

  // 分支下拉受控值：targetCwd 在工作树列表内则显示它，否则占位。
  const branchValue =
    targetCwd && worktrees?.some((w) => w.path === targetCwd) ? targetCwd : "";

  // ── 新建工作树（OpenChamber createInstantWorktreeDraft 语义）──
  const [showWorktreeForm, setShowWorktreeForm] = useState(false);
  const [worktreeName, setWorktreeName] = useState("");
  const [creatingWorktree, setCreatingWorktree] = useState(false);
  const [worktreeError, setWorktreeError] = useState<string | null>(null);
  const worktreeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showWorktreeForm) worktreeInputRef.current?.focus();
  }, [showWorktreeForm]);

  const createWorktree = useCallback(async () => {
    const branch = worktreeName.trim();
    if (!branch || !selectedCwd || creatingWorktree) return;
    setCreatingWorktree(true);
    setWorktreeError(null);
    try {
      // pending 期间分支下拉保持禁用（OpenChamber pendingWorktreeRequestId 锁定）
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: selectedCwd, branch }),
      });
      const data = (await res.json()) as { path?: string; error?: string };
      if (!res.ok || !data.path) {
        setWorktreeError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      // 创建成功：目标直接指向新工作树（bootstrapPendingDirectory 语义），
      // 使默认缓存失效并同步移除持久化条目（避免刷新后旧列表——不含新工作树——
      // 被恢复），再刷新分支列表让新条目出现。
      onTargetChange(data.path, selectedCwd ?? data.path);
      setShowWorktreeForm(false);
      setWorktreeName("");
      clearDefaultWorktreeCache(selectedCwd);
      const persisted = readPersistedWorktrees();
      persisted.delete(selectedCwd);
      writePersistedWorktrees(persisted);
      await loadWorktrees(selectedCwd);
    } catch (e) {
      setWorktreeError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingWorktree(false);
    }
  }, [worktreeName, selectedCwd, creatingWorktree, onTargetChange, loadWorktrees]);
  return (
    <div className="guide-selectors">
      {/* ── 项目下拉 ── */}
      <div className="guide-selector">
        <Folder size={12} className="guide-selector-icon" aria-hidden />
        <select
          className="guide-select"
          value={selectedCwd ?? ""}
          disabled={loadingProjects || projects.length === 0}
          onChange={(e) => {
            const cwd = e.target.value;
            if (cwd) {
              // OpenChamber handleDraftProjectChange：选项目即把目标重置为项目根，
              // 清除旧的分支目标（随后可选分支覆盖）。
              onTargetChange(cwd, cwd);
              void loadWorktrees(cwd);
            }
          }}
          aria-label={t("guide_projectTitle")}
        >
          <option value="" disabled>
            {loadingProjects
              ? t("guide_loading")
              : projects.length === 0
                ? t("guide_noProjects")
                : t("guide_projectPlaceholder")}
          </option>
          {projects.map((project) => (
            <option key={project.cwd} value={project.cwd} title={`${project.cwd} · ${t("guide_sessionCount", { count: project.count })}`}>
              {projectDisplayName(project.cwd)}
            </option>
          ))}
        </select>
      </div>

      {/* ── 分支下拉（非 git 项目隐藏，OpenChamber 语义）── */}
      {isGit && (
        <div className="guide-selector">
          <GitBranch size={12} className="guide-selector-icon" aria-hidden />
          <select
            className="guide-select"
            value={branchValue}
            disabled={!selectedCwd || loadingWorktrees || worktrees === null}
            onChange={(e) => {
              const path = e.target.value;
              if (path) onTargetChange(path, selectedCwd ?? path);
            }}
            aria-label={t("guide_worktreeTitle")}
          >
            <option value="" disabled>
              {t("guide_branchPlaceholder")}
            </option>
            {main && (
              <optgroup label={t("guide_mainWorktree")}>
                <option value={main.path}>{main.branch ?? main.path}</option>
              </optgroup>
            )}
            {branches.length > 0 && (
              <optgroup label={t("guide_worktree")}>
                {branches.map((wt) => (
                  <option key={wt.path} value={wt.path}>
                    {wt.branch ?? wt.path} · {wt.path}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          {/* 新建工作树入口（OpenChamber worktreeNew：仅 git 项目可用） */}
          {!creatingWorktree && !showWorktreeForm && (
            <button
              type="button"
              className="guide-new-worktree-btn"
              title={t("guide_newWorktree")}
              aria-label={t("guide_newWorktree")}
              disabled={!selectedCwd || loadingWorktrees}
              onClick={() => {
                setWorktreeError(null);
                setShowWorktreeForm(true);
              }}
            >
              <Plus size={12} />
            </button>
          )}
        </div>
      )}

      {/* 新建工作树表单（创建中锁定分支下拉，OpenChamber pending 语义） */}
      {isGit && showWorktreeForm && (
        <div className="guide-worktree-form">
          <input
            ref={worktreeInputRef}
            className="guide-worktree-input"
            value={worktreeName}
            placeholder={t("guide_newWorktreePlaceholder")}
            disabled={creatingWorktree}
            onChange={(e) => setWorktreeName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) void createWorktree();
              if (e.key === "Escape") {
                setShowWorktreeForm(false);
                setWorktreeName("");
                setWorktreeError(null);
              }
            }}
          />
          <button
            type="button"
            className="extension-card-btn"
            disabled={creatingWorktree || !worktreeName.trim()}
            onClick={() => void createWorktree()}
          >
            {creatingWorktree ? t("guide_creatingWorktree") : t("guide_createWorktree")}
          </button>
          <button
            type="button"
            className="extension-card-btn"
            disabled={creatingWorktree}
            onClick={() => {
              setShowWorktreeForm(false);
              setWorktreeName("");
              setWorktreeError(null);
            }}
          >
            {t("extension_cancel")}
          </button>
          {worktreeError && (
            <span className="guide-worktree-error">{worktreeError}</span>
          )}
        </div>
      )}
    </div>
  );
}
