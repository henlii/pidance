/**
 * 自管 trust.json + 项目资源探测（不依赖 ProjectTrustStore / hasTrustRequiringProjectResources）。
 * 语义对齐 pi-coding-agent dist/core/trust-manager.js。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const PROJECT_CONFIG_DIR = ".pi";

const TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES = [
  "settings.json",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
] as const;

export type TrustDecision = boolean | null;

export type TrustFileData = Record<string, TrustDecision>;

function normalizeCwd(cwd: string): string {
  try {
    return resolve(cwd);
  } catch {
    return cwd;
  }
}

function canonicalizeCwd(cwd: string): string {
  const resolved = normalizeCwd(cwd);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function readTrustFile(path: string): TrustFileData {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read trust store ${path}: ${message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid trust store ${path}: expected an object`);
  }
  const data: TrustFileData = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value !== true && value !== false && value !== null) {
      throw new Error(
        `Invalid trust store ${path}: value for ${JSON.stringify(key)} must be true, false, or null`,
      );
    }
    data[key] = value;
  }
  return data;
}

function writeTrustFile(path: string, data: TrustFileData): void {
  const sorted: TrustFileData = {};
  for (const key of Object.keys(data).sort()) {
    const value = data[key];
    if (value === true || value === false || value === null) {
      sorted[key] = value;
    }
  }
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(sorted, null, 2)}\n`;
  try {
    writeFileSync(temp, body, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

function findNearestTrustEntry(
  data: TrustFileData,
  cwd: string,
): { path: string; decision: boolean } | null {
  let currentDir = canonicalizeCwd(cwd);
  while (true) {
    const value = data[currentDir];
    if (value === true || value === false) {
      return { path: currentDir, decision: value };
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

/**
 * 项目是否含需信任才加载的资源（.pi/* 或祖先 .agents/skills，排除 ~/.agents/skills）。
 */
export function hasTrustRequiringProjectResources(cwd: string): boolean {
  const homeDir = canonicalizeCwd(process.env.HOME || homedir());
  const userAgentsSkillsDir = join(homeDir, ".agents", "skills");
  let currentDir = canonicalizeCwd(cwd);
  const configDir = join(currentDir, PROJECT_CONFIG_DIR);
  if (
    TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES.some((entry) =>
      existsSync(join(configDir, entry)),
    )
  ) {
    return true;
  }
  while (true) {
    const agentsSkillsDir = join(currentDir, ".agents", "skills");
    if (agentsSkillsDir !== userAgentsSkillsDir && existsSync(agentsSkillsDir)) {
      return true;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) return false;
    currentDir = parentDir;
  }
}

export class ProjectTrustStore {
  private readonly trustPath: string;

  constructor(agentDir: string) {
    this.trustPath = join(resolve(agentDir), "trust.json");
  }

  get(cwd: string): boolean | null {
    return this.getEntry(cwd)?.decision ?? null;
  }

  getEntry(cwd: string): { path: string; decision: boolean } | null {
    try {
      const data = readTrustFile(this.trustPath);
      return findNearestTrustEntry(data, cwd);
    } catch {
      return null;
    }
  }

  set(cwd: string, decision: TrustDecision): void {
    this.setMany([{ path: cwd, decision }]);
  }

  setMany(decisions: Array<{ path: string; decision: TrustDecision }>): void {
    let data: TrustFileData;
    try {
      data = readTrustFile(this.trustPath);
    } catch {
      data = {};
    }
    for (const { path, decision } of decisions) {
      const key = canonicalizeCwd(path);
      if (decision === null) {
        delete data[key];
      } else {
        data[key] = decision;
      }
    }
    writeTrustFile(this.trustPath, data);
  }
}
