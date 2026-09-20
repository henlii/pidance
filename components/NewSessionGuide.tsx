"use client";

/**
 * 新会话引导选择器：空态时在输入框上方提供项目下拉。
 * - 项目来源唯一：侧栏项目列表（projectRoots），与侧栏项目区同源；不再聚合会话 cwd，
 *   所以下拉里不会出现侧栏看不到的目录
 * - 项目 = 目录（一对一）：新会话 cwd 就是所选项目路径
 * - 选择目录经 onTargetChange 同步全局项目身份（文件栏/Git/标题）
 * - 不创建会话、不跳转路由（发送第一条消息才建会话，Pidance 懒创建）
 * - 目标不在列表里时补一个临时项，保证「下拉显示的目标 = 实际建会话的目录」
 */
import { useMemo } from "react";
import { Folder } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { projectDisplayName } from "@/lib/project-context";
import { guideProjectOptions } from "@/lib/guide-projects";

type Props = {
  /** 侧栏项目列表（唯一来源） */
  projectRoots: readonly string[];
  /** 当前新会话目标目录；null = 未选择 */
  targetCwd: string | null;
  /** 选择目标目录 */
  onTargetChange: (cwd: string | null) => void;
};

export function NewSessionGuide({ projectRoots, targetCwd, onTargetChange }: Props) {
  const { t } = useI18n();
  const options = useMemo(
    () => guideProjectOptions(projectRoots, targetCwd),
    [projectRoots, targetCwd],
  );

  return (
    <div className="guide-selectors">
      <div className="guide-selector">
        <Folder size={12} className="guide-selector-icon" aria-hidden />
        <select
          className="guide-select"
          value={targetCwd ?? ""}
          disabled={options.length === 0}
          onChange={(event) => {
            const cwd = event.target.value;
            if (cwd) onTargetChange(cwd);
          }}
          aria-label={t("guide_projectTitle")}
        >
          <option value="" disabled>
            {options.length === 0 ? t("guide_noProjects") : t("guide_projectPlaceholder")}
          </option>
          {options.map((cwd) => (
            <option key={cwd} value={cwd} title={cwd}>
              {projectDisplayName(cwd)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
