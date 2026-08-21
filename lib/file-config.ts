/**
 * 文件管理可调配置（服务端持久化到 pidance-preferences.json）。
 * 文件管理器顶部齿轮按钮写入；服务端读同一份 prefs。
 */
import { readPidancePrefs, type PidancePrefs } from "./pidance-prefs-file";
import { parseFileConfig, type FileConfig } from "./file-config-shared";

export type { FileConfig } from "./file-config-shared";
export { DEFAULT_FILE_CONFIG, parseFileConfig } from "./file-config-shared";

export function fileConfigFromPrefs(prefs: PidancePrefs): FileConfig {
  return parseFileConfig(prefs.fileConfig);
}

export function readFileConfig(agentDir?: string): FileConfig {
  return fileConfigFromPrefs(readPidancePrefs(agentDir));
}
