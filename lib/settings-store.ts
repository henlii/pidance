/**
 * 自管 settings.json（不依赖 SettingsManager）。
 * 全局：~/.pi/agent/settings.json；项目：<cwd>/.pi/settings.json（仅在 projectTrusted 时合并）。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir, getSettingsPath } from "./pi-paths";
import type {
  AgentSettingsReader,
  AgentSettingsWriter,
  AgentThinkingLevel,
  QueueMode,
} from "./agent-settings";

export type SettingsObject = Record<string, unknown>;

const PROJECT_CONFIG_DIR = ".pi";

export function getProjectSettingsPath(cwd: string): string {
  return join(resolve(cwd), PROJECT_CONFIG_DIR, "settings.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 损坏或缺失 → 空对象（不抛） */
export function loadSettingsFile(path: string): SettingsObject {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isPlainObject(parsed) ? { ...parsed } : {};
  } catch {
    return {};
  }
}

/** 原子写：temp + rename */
export function saveSettingsFile(path: string, data: SettingsObject): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(data, null, 2)}\n`;
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

function deepMergeSettings(base: SettingsObject, overlay: SettingsObject): SettingsObject {
  const out: SettingsObject = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMergeSettings(out[key] as SettingsObject, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 合并全局 +（可选）项目 settings。
 * projectTrusted=false 时不读项目文件（对齐 SDK 信任门禁）。
 */
export function loadMergedSettings(
  cwd: string | null | undefined,
  options: { agentDir?: string; projectTrusted?: boolean } = {},
): SettingsObject {
  const agentDir = options.agentDir ?? getAgentDir();
  const globalPath = join(resolve(agentDir), "settings.json");
  const global = loadSettingsFile(globalPath);
  if (!cwd || options.projectTrusted === false) return global;
  const project = loadSettingsFile(getProjectSettingsPath(cwd));
  return deepMergeSettings(global, project);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asQueueMode(value: unknown, fallback: QueueMode): QueueMode {
  return value === "all" || value === "one-at-a-time" ? value : fallback;
}

/**
 * 全局 settings 读写适配器（AgentSettingsReader/Writer）。
 * 写操作只改全局 settings.json，不写项目级。
 */
export class GlobalSettingsStore implements AgentSettingsWriter {
  private global: SettingsObject;
  private readonly globalPath: string;
  private readonly projectTrusted: boolean;
  private dirty = false;

  constructor(options: { agentDir?: string; projectTrusted?: boolean } = {}) {
    const agentDir = options.agentDir ?? getAgentDir();
    this.globalPath = join(resolve(agentDir), "settings.json");
    this.global = loadSettingsFile(this.globalPath);
    this.projectTrusted = options.projectTrusted ?? false;
  }

  static create(
    _cwd: string | null | undefined,
    agentDir?: string,
    options?: { projectTrusted?: boolean },
  ): GlobalSettingsStore {
    return new GlobalSettingsStore({
      agentDir,
      projectTrusted: options?.projectTrusted,
    });
  }

  /** 当前生效视图：仅全局（agent-settings 产品为 scope:global） */
  private view(): SettingsObject {
    return this.global;
  }

  getDefaultProvider(): string | undefined {
    return asString(this.view().defaultProvider);
  }

  getDefaultModel(): string | undefined {
    return asString(this.view().defaultModel);
  }

  getDefaultThinkingLevel(): string | undefined {
    return asString(this.view().defaultThinkingLevel);
  }

  getSteeringMode(): QueueMode {
    return asQueueMode(this.view().steeringMode, "one-at-a-time");
  }

  getFollowUpMode(): QueueMode {
    return asQueueMode(this.view().followUpMode, "one-at-a-time");
  }

  getCompactionSettings(): {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
  } {
    const c = isPlainObject(this.view().compaction) ? (this.view().compaction as SettingsObject) : {};
    return {
      enabled: typeof c.enabled === "boolean" ? c.enabled : true,
      reserveTokens: typeof c.reserveTokens === "number" ? c.reserveTokens : 16384,
      keepRecentTokens: typeof c.keepRecentTokens === "number" ? c.keepRecentTokens : 20000,
    };
  }

  getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
    const r = isPlainObject(this.view().retry) ? (this.view().retry as SettingsObject) : {};
    return {
      enabled: typeof r.enabled === "boolean" ? r.enabled : true,
      maxRetries: typeof r.maxRetries === "number" ? r.maxRetries : 3,
      baseDelayMs: typeof r.baseDelayMs === "number" ? r.baseDelayMs : 2000,
    };
  }

  isProjectTrusted(): boolean {
    return this.projectTrusted;
  }

  getDefaultProjectTrust(): "ask" | "always" | "never" {
    const v = this.global.defaultProjectTrust;
    return v === "ask" || v === "always" || v === "never" ? v : "ask";
  }

  getPackages(): unknown {
    return this.global.packages;
  }

  setDefaultProvider(provider: string): void {
    this.global.defaultProvider = provider;
    this.dirty = true;
  }

  setDefaultModel(modelId: string): void {
    this.global.defaultModel = modelId;
    this.dirty = true;
  }

  setDefaultModelAndProvider(provider: string, modelId: string): void {
    this.global.defaultProvider = provider;
    this.global.defaultModel = modelId;
    this.dirty = true;
  }

  setDefaultThinkingLevel(level: AgentThinkingLevel): void {
    this.global.defaultThinkingLevel = level;
    this.dirty = true;
  }

  setSteeringMode(mode: QueueMode): void {
    this.global.steeringMode = mode;
    this.dirty = true;
  }

  setFollowUpMode(mode: QueueMode): void {
    this.global.followUpMode = mode;
    this.dirty = true;
  }

  setCompactionEnabled(enabled: boolean): void {
    const c = isPlainObject(this.global.compaction)
      ? { ...(this.global.compaction as SettingsObject) }
      : {};
    c.enabled = enabled;
    this.global.compaction = c;
    this.dirty = true;
  }

  setRetryEnabled(enabled: boolean): void {
    const r = isPlainObject(this.global.retry)
      ? { ...(this.global.retry as SettingsObject) }
      : {};
    r.enabled = enabled;
    this.global.retry = r;
    this.dirty = true;
  }

  setPackages(packages: unknown): void {
    this.global.packages = packages;
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    saveSettingsFile(this.globalPath, this.global);
    this.dirty = false;
  }

  /** 同步 flush（插件路径用） */
  flushSync(): void {
    if (!this.dirty) return;
    saveSettingsFile(this.globalPath, this.global);
    this.dirty = false;
  }
}

export type PackageSourceEntry =
  | string
  | {
      source: string;
      extensions?: string[];
      skills?: string[];
      prompts?: string[];
      themes?: string[];
      [key: string]: unknown;
    };

function asPackageList(value: unknown): PackageSourceEntry[] {
  return Array.isArray(value) ? (value as PackageSourceEntry[]) : [];
}

function packageSourceOf(entry: PackageSourceEntry): string {
  return typeof entry === "string" ? entry : entry.source;
}

function isDisabledPackageEntry(entry: PackageSourceEntry): boolean {
  if (typeof entry === "string") return false;
  return (
    Array.isArray(entry.extensions) &&
    entry.extensions.length === 0 &&
    Array.isArray(entry.skills) &&
    entry.skills.length === 0 &&
    Array.isArray(entry.prompts) &&
    entry.prompts.length === 0 &&
    Array.isArray(entry.themes) &&
    entry.themes.length === 0
  );
}

/** 读全局/项目 packages 列表 */
export function loadPackages(
  scope: "global" | "project",
  options: { agentDir?: string; cwd?: string } = {},
): PackageSourceEntry[] {
  if (scope === "global") {
    const path = options.agentDir
      ? join(resolve(options.agentDir), "settings.json")
      : getSettingsPath();
    return asPackageList(loadSettingsFile(path).packages);
  }
  if (!options.cwd) return [];
  return asPackageList(loadSettingsFile(getProjectSettingsPath(options.cwd)).packages);
}

/** 写 packages 列表（disable/enable 用） */
export function savePackages(
  scope: "global" | "project",
  packages: PackageSourceEntry[],
  options: { agentDir?: string; cwd?: string } = {},
): void {
  if (scope === "global") {
    const path = options.agentDir
      ? join(resolve(options.agentDir), "settings.json")
      : getSettingsPath();
    const data = loadSettingsFile(path);
    data.packages = packages;
    saveSettingsFile(path, data);
    return;
  }
  if (!options.cwd) throw new Error("project packages 需要 cwd");
  const path = getProjectSettingsPath(options.cwd);
  const data = loadSettingsFile(path);
  data.packages = packages;
  saveSettingsFile(path, data);
}

/**
 * 禁用/启用包：禁用时写空 extensions/skills/prompts/themes 数组；启用时还原为 source 字符串。
 * @returns 是否改动了列表
 */
export function setPackageDisabledInSettings(
  source: string,
  scope: "global" | "project",
  disabled: boolean,
  options: { agentDir?: string; cwd?: string } = {},
): boolean {
  const current = loadPackages(scope, options);
  let changed = false;
  const next = current.map((entry): PackageSourceEntry => {
    if (packageSourceOf(entry) !== source) return entry;
    changed = true;
    if (disabled) {
      return {
        ...(typeof entry === "string" ? { source: entry } : entry),
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
      };
    }
    return packageSourceOf(entry);
  });
  if (!changed) return false;
  savePackages(scope, next, options);
  return true;
}

export function listDisabledPackageKeys(options: {
  agentDir?: string;
  cwd?: string;
}): Map<string, boolean> {
  const disabled = new Map<string, boolean>();
  for (const entry of loadPackages("global", options)) {
    disabled.set(`global\0${packageSourceOf(entry)}`, isDisabledPackageEntry(entry));
  }
  if (options.cwd) {
    for (const entry of loadPackages("project", options)) {
      disabled.set(`project\0${packageSourceOf(entry)}`, isDisabledPackageEntry(entry));
    }
  }
  return disabled;
}

/** 仅读 defaultProjectTrust（不构造完整 store 也可） */
export function readDefaultProjectTrustFromDisk(agentDir?: string): "ask" | "always" | "never" {
  try {
    const path = agentDir
      ? join(resolve(agentDir), "settings.json")
      : getSettingsPath();
    const data = loadSettingsFile(path);
    const v = data.defaultProjectTrust;
    if (v === "ask" || v === "always" || v === "never") return v;
    return "ask";
  } catch {
    return "ask";
  }
}

/** 类型收窄：GlobalSettingsStore 满足 AgentSettingsReader */
export function asAgentSettingsReader(store: GlobalSettingsStore): AgentSettingsReader {
  return store;
}
