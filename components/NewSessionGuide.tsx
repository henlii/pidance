"use client";

/**
 * 新会话引导选择器：空态时在输入框上方提供项目下拉。
 * - 项目 = 目录（一对一）：新会话 cwd 就是所选项目路径，没有分支/工作树下拉
 * - 选择目录同时经 onTargetChange 同步全局项目身份（文件栏/Git/标题）
 * - 不创建会话、不跳转路由（发送第一条消息才建会话，Pidance 懒创建）
 * - 项目下拉：/api/sessions 聚合最近 cwd（去重、按最近使用排序）+ 已添加项目
 * - 目标目录不在列表内（例如恢复的上次目标尚未加入项目）时作为临时项显示，
 *   保证「下拉显示的目标 = 实际建会话的目录」，但不写入项目列表
 */
import { useEffect, useMemo, useState } from "react";
import { Folder } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { loadSidebarPreferences } from "@/lib/ui-preferences";
import { loadCachedSessionList, saveCachedSessionList } from "@/lib/session-list-cache";
import type { SessionInfo } from "@/lib/types";
import {
  aggregateGuideProjects,
  mergeAddedProjectRoots,
  withTargetProject,
  type GuideProject,
} from "@/lib/guide-load-cache";

type Props = {
  /** 当前新会话目标目录；null = 未选择 */
  targetCwd: string | null;
  /** 选择目标目录 */
  onTargetChange: (cwd: string | null) => void;
  /** 侧栏新增项目后递增：把新项目并入项目下拉（偏好只在挂载时读一次） */
  addedProjectsToken?: number;
};

/** 项目下拉显示名：取路径末段（项目名）；全路径放 tooltip。 */
function projectDisplayName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const seg = trimmed.split(/[\\/]/).filter(Boolean).pop();
  return seg || cwd;
}

export function NewSessionGuide({ targetCwd, onTargetChange, addedProjectsToken }: Props) {
  const { t } = useI18n();
  const [projects, setProjects] = useState<GuideProject[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);

  // 项目下拉合并「主动添加的项目」（无会话也展示，可直接发起会话）。
  const projectRoots = useMemo(() => loadSidebarPreferences().projectRoots, []);

  useEffect(() => {
    let cancelled = false;
    // 先读本地缓存（localStorage，与 SessionSidebar 共享）：秒渲染最近项目，
    // 后台 fetch 刷新后覆盖（stale-while-revalidate）；拉取失败保留旧列表。
    const cached = loadCachedSessionList();
    if (cached && cached.length > 0) {
      setProjects(aggregateGuideProjects(cached, 12, projectRoots));
      setLoadingProjects(false);
    }
    void (async () => {
      try {
        const res = await fetch("/api/sessions");
        const data = (await res.json()) as { sessions?: SessionInfo[] };
        const sessions = data.sessions ?? [];
        saveCachedSessionList(sessions);
        // 响应回来时重读偏好：挂载后才添加的项目不能在覆盖列表时又被冲掉。
        const sorted = aggregateGuideProjects(sessions, 12, loadSidebarPreferences().projectRoots);
        if (!cancelled) setProjects(sorted);
      } catch {
        // 拉取失败：保留本地缓存渲染的旧列表（无缓存时保持空列表）
      } finally {
        if (!cancelled) setLoadingProjects(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectRoots]);

  // 侧栏新增项目（可能尚无任何会话，不会出现在 /api/sessions 聚合里）：
  // 必须并入项目下拉，否则刚切过去的目标在下拉里找不到对应项。
  useEffect(() => {
    if (addedProjectsToken === undefined) return;
    const roots = loadSidebarPreferences().projectRoots;
    setProjects((prev) => mergeAddedProjectRoots(prev, roots));
  }, [addedProjectsToken]);

  // 当前目标不在列表里（例如刷新恢复的上次目标、未加入项目的旧会话目录）：
  // 作为临时项补进下拉，避免「下拉显示 A、实际建到 B」。
  const options = useMemo(() => withTargetProject(projects, targetCwd), [projects, targetCwd]);

  return (
    <div className="guide-selectors">
      <div className="guide-selector">
        <Folder size={12} className="guide-selector-icon" aria-hidden />
        <select
          className="guide-select"
          value={targetCwd ?? ""}
          disabled={loadingProjects || options.length === 0}
          onChange={(e) => {
            const cwd = e.target.value;
            if (cwd) onTargetChange(cwd);
          }}
          aria-label={t("guide_projectTitle")}
        >
          <option value="" disabled>
            {loadingProjects
              ? t("guide_loading")
              : options.length === 0
                ? t("guide_noProjects")
                : t("guide_projectPlaceholder")}
          </option>
          {options.map((project) => (
            <option key={project.cwd} value={project.cwd} title={`${project.cwd} · ${t("guide_sessionCount", { count: project.count })}`}>
              {projectDisplayName(project.cwd)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
