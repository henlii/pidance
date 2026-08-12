/** Pi 文令文件名（SYSTEM / APPEND_SYSTEM / AGENTS）。 */
export const PROMPT_FILES = {
  system: "SYSTEM.md",
  systemAppend: "APPEND_SYSTEM.md",
  agents: "AGENTS.md",
} as const;

export type PromptKey = keyof typeof PROMPT_FILES;
