/**
 * 技能列表服务（自管磁盘发现，不再依赖 pi SDK 的 ResourceLoader）。
 *
 * 技能发现逻辑下沉到 lib/skill-discovery.ts（纯磁盘扫描，可测）；
 * 本模块负责组装会话上下文并补充安装信息（skills-lock.json）。
 */

import { getAgentDir } from "./pi-paths";
import { resolveProjectTrustedForSession } from "./project-trust";
import { discoverSkills } from "./skill-discovery";
import { annotateSkillsWithInstallInfo } from "./skill-lock";

export async function loadSkillsWithInstallInfo(cwd: string) {
  const agentDir = getAgentDir();
  const projectTrusted = resolveProjectTrustedForSession(cwd, agentDir);
  const { skills, diagnostics } = discoverSkills({ cwd, agentDir, projectTrusted });
  return {
    skills: annotateSkillsWithInstallInfo(skills, { cwd, agentDir }),
    diagnostics,
  };
}
