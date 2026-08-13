/**
 * Pidance 产品自检升级：查 npm 最新版、判定是否可一键升级、执行正式安装位切换。
 * 不自动 version/tag/publish；升级仅针对已安装的正式目录（releases + current）。
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PIDANCE_PACKAGE_NAME = "@henlii/pidance";
export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";

export type UpgradeMode = "formal-install" | "workspace" | "unknown";

export type PidanceUpdateCheck = {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  upgradeSupported: boolean;
  upgradeMode: UpgradeMode;
  installRoot: string | null;
  packageName: string;
  registry: string;
  reason: string;
  checkedAt: string;
};

export type PidanceUpdateApplyResult = {
  ok: boolean;
  status: "upgraded" | "already_latest" | "not_supported" | "error";
  currentVersion: string;
  targetVersion: string | null;
  message: string;
  restarted?: boolean;
};

/** 升级阶段（供 SSE / 全屏进度条） */
export type UpgradePhase =
  | "preparing"
  | "downloading"
  | "installing"
  | "linking"
  | "restarting"
  | "waiting"
  | "done"
  | "error";

export type UpgradeProgressEvent = {
  phase: UpgradePhase;
  /** 0–100 粗粒度进度 */
  percent: number;
  message: string;
};

type CacheEntry = { latest: string; ts: number };

declare global {
  var __piPidanceLatestCache: CacheEntry | undefined;
}

const LATEST_CACHE_TTL_MS = 30 * 60 * 1000;

export function getNpmRegistry(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.PIDANCE_NPM_REGISTRY || env.npm_config_registry || DEFAULT_NPM_REGISTRY).trim();
  if (!raw) return DEFAULT_NPM_REGISTRY;
  return raw.endsWith("/") ? raw : `${raw}/`;
}

/** 宽松 semver 比较：a>b → 1，a<b → -1，相等/不可比 → 0 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] > pb.core[i]) return 1;
    if (pa.core[i] < pb.core[i]) return -1;
  }
  // 预发布：无预发布 > 有预发布；字符串比较
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
}

function parseSemver(raw: string): { core: [number, number, number]; pre: string | null } | null {
  const s = raw.trim().replace(/^v/i, "");
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s);
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ?? null,
  };
}

/**
 * 正式安装根：.../releases/<ver>/node_modules/@henlii/pidance 或 .../releases/<ver>
 * 可由 PIDANCE_INSTALL_ROOT 覆盖。
 */
export function resolveFormalInstallRoot(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const fromEnv = env.PIDANCE_INSTALL_ROOT?.trim();
  if (fromEnv) {
    try {
      return resolve(fromEnv);
    } catch {
      return null;
    }
  }
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    real = resolve(cwd);
  }
  const norm = real.replace(/\\/g, "/");
  const m1 = /^(.*)\/releases\/[^/]+\/node_modules\/@henlii\/pidance$/.exec(norm);
  if (m1) return resolve(m1[1]);
  const m2 = /^(.*)\/releases\/[^/]+$/.exec(norm);
  if (m2) return resolve(m2[1]);
  return null;
}

export function readInstalledPidanceVersion(cwd: string = process.cwd()): string {
  const candidates = [
    join(cwd, "package.json"),
    join(cwd, "node_modules", "@henlii", "pidance", "package.json"),
  ];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const pkg = JSON.parse(readFileSync(p, "utf8")) as {
        name?: unknown;
        version?: unknown;
        dependencies?: Record<string, unknown>;
      };
      if (pkg.name === PIDANCE_PACKAGE_NAME && typeof pkg.version === "string" && pkg.version.trim()) {
        return pkg.version.trim();
      }
      // wrapper package.json（name=pidance-<ver>, version=1.0.0）只认产品依赖号
      const dep = pkg.dependencies?.[PIDANCE_PACKAGE_NAME];
      if (typeof dep === "string" && dep.trim() && !dep.startsWith("file:")) {
        return dep.trim().replace(/^[\^~>=<\s]+/, "");
      }
    } catch {
      /* try next */
    }
  }
  const envVer = process.env.NEXT_PUBLIC_APP_VERSION?.trim();
  if (envVer && envVer !== "unknown") return envVer;
  return "0.0.0";
}

export function detectUpgradeMode(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): { mode: UpgradeMode; installRoot: string | null } {
  const installRoot = resolveFormalInstallRoot(cwd, env);
  if (installRoot) return { mode: "formal-install", installRoot };
  try {
    const pkgPath = join(cwd, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown };
      if (pkg.name === PIDANCE_PACKAGE_NAME) {
        return { mode: "workspace", installRoot: null };
      }
    }
  } catch {
    /* ignore */
  }
  return { mode: "unknown", installRoot: null };
}

/**
 * 升级成功后只留 keepVersions + current 指向的目录。
 * 不跟随 releases/ 外的符号链接；删失败由调用方忽略。
 */
export function pruneOldReleases(installRoot: string, keepVersions: string[]): string[] {
  const releasesDir = join(installRoot, "releases");
  if (!existsSync(releasesDir)) return [];

  const keep = new Set(keepVersions.map((v) => v.trim()).filter(Boolean));
  try {
    const currentReal = realpathSync(join(installRoot, "current"));
    const m = /\/releases\/([^/]+)$/.exec(currentReal.replace(/\\/g, "/"));
    if (m) keep.add(m[1]);
  } catch {
    /* current 不存在则只按 keepVersions */
  }

  let releasesReal = releasesDir;
  try {
    releasesReal = realpathSync(releasesDir);
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const ent of readdirSync(releasesDir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
    if (ent.name === "." || ent.name === ".." || ent.name.includes("/") || ent.name.includes("\\")) {
      continue;
    }
    if (keep.has(ent.name)) continue;
    const abs = join(releasesDir, ent.name);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      continue;
    }
    const prefix = releasesReal.endsWith("/") ? releasesReal : `${releasesReal}/`;
    if (real !== releasesReal && !real.startsWith(prefix)) continue;
    rmSync(abs, { recursive: true, force: true });
    removed.push(ent.name);
  }
  return removed;
}

export function isSelfUpgradeAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  // 显式关闭
  if (env.PIDANCE_ALLOW_SELF_UPGRADE === "0") return false;
  // 默认：正式安装允许；工作区不允许（由 upgradeSupported 再收紧）
  return true;
}

/** 从 npm registry 取 latest（HTTP，不依赖 shell）。 */
export async function fetchLatestPidanceVersion(
  registry: string = getNpmRegistry(),
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<string | null> {
  const base = registry.endsWith("/") ? registry : `${registry}/`;
  // registry.npmjs.org/@henlii%2Fpidance/latest
  const url = new URL(`@henlii%2Fpidance/latest`, base).toString();
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === "string" && data.version.trim() ? data.version.trim() : null;
  } catch {
    return null;
  }
}

export async function getCachedLatestVersion(
  registry: string = getNpmRegistry(),
  now: number = Date.now(),
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  /** 用户点「检查更新」时跳过进程内缓存，避免刚发版仍显示旧 latest */
  force = false,
): Promise<string | null> {
  const hit = globalThis.__piPidanceLatestCache;
  if (!force && hit && now - hit.ts < LATEST_CACHE_TTL_MS && hit.latest) {
    return hit.latest;
  }
  const latest = await fetchLatestPidanceVersion(registry, fetchImpl);
  if (latest) {
    globalThis.__piPidanceLatestCache = { latest, ts: now };
  }
  return latest;
}

export async function checkPidanceUpdate(options?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: number;
  /** true：强制拉 npm（检查更新按钮 / API GET） */
  forceRefresh?: boolean;
}): Promise<PidanceUpdateCheck> {
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? process.env;
  const registry = getNpmRegistry(env);
  const currentVersion = readInstalledPidanceVersion(cwd);
  const { mode, installRoot } = detectUpgradeMode(cwd, env);
  const latestVersion = await getCachedLatestVersion(
    registry,
    options?.now,
    options?.fetchImpl,
    options?.forceRefresh === true,
  );
  const updateAvailable =
    latestVersion != null && compareSemver(latestVersion, currentVersion) > 0;
  const allow = isSelfUpgradeAllowed(env);
  const upgradeSupported = allow && mode === "formal-install" && installRoot != null;

  let reason: string;
  if (!latestVersion) {
    reason = "无法从 npm registry 获取最新版本";
  } else if (!updateAvailable) {
    reason = "已是最新版本";
  } else if (!upgradeSupported) {
    if (mode === "workspace") {
      reason = "当前为工作区/测试部署，仅提示有新版本；请在正式安装位（31415）一键升级";
    } else if (!allow) {
      reason = "已禁用自升级（PIDANCE_ALLOW_SELF_UPGRADE=0）";
    } else {
      reason = "未检测到正式安装目录，无法一键升级";
    }
  } else {
    reason = `可升级到 ${latestVersion}`;
  }

  return {
    currentVersion,
    latestVersion,
    updateAvailable,
    upgradeSupported,
    upgradeMode: mode,
    installRoot,
    packageName: PIDANCE_PACKAGE_NAME,
    registry,
    reason,
    checkedAt: new Date(options?.now ?? Date.now()).toISOString(),
  };
}

/**
 * 正式安装位升级：releases/<ver> 内 npm install 官方包 → 切换 current → 可选 systemctl restart。
 */
export async function applyPidanceUpdate(options?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  targetVersion?: string;
  fetchImpl?: typeof fetch;
  execFileImpl?: typeof execFileAsync;
  restartService?: boolean;
  onProgress?: (event: UpgradeProgressEvent) => void;
}): Promise<PidanceUpdateApplyResult> {
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? process.env;
  const exec = options?.execFileImpl ?? execFileAsync;
  const report = (phase: UpgradePhase, percent: number, message: string) => {
    try {
      options?.onProgress?.({ phase, percent, message });
    } catch {
      /* ignore listener errors */
    }
  };
  report("preparing", 5, "准备升级…");
  const check = await checkPidanceUpdate({
    cwd,
    env,
    fetchImpl: options?.fetchImpl,
  });

  if (!check.upgradeSupported || !check.installRoot) {
    report("error", 100, check.reason);
    return {
      ok: false,
      status: "not_supported",
      currentVersion: check.currentVersion,
      targetVersion: check.latestVersion,
      message: check.reason,
    };
  }

  const target =
    (options?.targetVersion?.trim() || check.latestVersion || "").trim();
  if (!target) {
    return {
      ok: false,
      status: "error",
      currentVersion: check.currentVersion,
      targetVersion: null,
      message: "无目标版本",
    };
  }

  if (compareSemver(target, check.currentVersion) <= 0 && !options?.targetVersion) {
    report("done", 100, "已是最新版本");
    return {
      ok: true,
      status: "already_latest",
      currentVersion: check.currentVersion,
      targetVersion: target,
      message: "已是最新版本",
    };
  }

  // 防止路径穿越：版本名必须是 semver 风格
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(target)) {
    return {
      ok: false,
      status: "error",
      currentVersion: check.currentVersion,
      targetVersion: target,
      message: "非法版本号",
    };
  }

  const installRoot = check.installRoot;
  const releaseDir = join(installRoot, "releases", target);
  const registry = check.registry;

  try {
    report("preparing", 12, `创建发布目录 ${target}…`);
    mkdirSync(releaseDir, { recursive: true });
    const wrapperPkg = {
      name: `pidance-${target}`,
      version: "1.0.0",
      private: true,
      dependencies: {
        [PIDANCE_PACKAGE_NAME]: target,
      },
    };
    writeFileSync(join(releaseDir, "package.json"), `${JSON.stringify(wrapperPkg, null, 2)}\n`, "utf8");

    report("downloading", 20, "正在从 npm 下载包…");
    await exec(
      "npm",
      ["install", "--omit=dev", `--registry=${registry}`, "--no-fund", "--no-audit"],
      {
        cwd: releaseDir,
        env: { ...env, npm_config_registry: registry },
        timeout: 600_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    report("installing", 82, "校验安装结果…");

    const installedPkg = join(releaseDir, "node_modules", "@henlii", "pidance", "package.json");
    if (!existsSync(installedPkg)) {
      throw new Error("安装后未找到 @henlii/pidance 包");
    }
    const installed = JSON.parse(readFileSync(installedPkg, "utf8")) as { version?: string };
    if (installed.version !== target) {
      throw new Error(`安装版本不符：期望 ${target}，实际 ${installed.version ?? "?"}`);
    }

    report("linking", 88, "切换 current 符号链接…");
    // 原子切换 current：先写临时链接再 rename
    const currentLink = join(installRoot, "current");
    const tmpLink = join(installRoot, `.current-tmp-${process.pid}`);
    try {
      if (existsSync(tmpLink)) rmSync(tmpLink, { force: true, recursive: true });
    } catch {
      /* ignore */
    }
    symlinkSync(releaseDir, tmpLink);
    renameSync(tmpLink, currentLink);

    let restarted = false;
    const shouldRestart = options?.restartService !== false && env.PIDANCE_SKIP_SERVICE_RESTART !== "1";
    if (shouldRestart) {
      try {
        report("restarting", 94, "正在重启服务…");
        await exec("systemctl", ["restart", "pidance.service"], {
          timeout: 120_000,
          env,
        });
        restarted = true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const result = {
          ok: true as const,
          status: "upgraded" as const,
          currentVersion: check.currentVersion,
          targetVersion: target,
          message: `已切换到 ${target}，但重启 pidance.service 失败：${msg}`,
          restarted: false,
        };
        try {
          pruneOldReleases(installRoot, [target, check.currentVersion]);
        } catch {
          /* 旧目录删不掉不影响已切换的 current */
        }
        report("done", 100, result.message);
        return result;
      }
    }

    try {
      pruneOldReleases(installRoot, [target, check.currentVersion]);
    } catch {
      /* 旧目录删不掉不影响已切换的 current */
    }

    const result = {
      ok: true as const,
      status: "upgraded" as const,
      currentVersion: check.currentVersion,
      targetVersion: target,
      message: restarted
        ? `已升级到 ${target} 并重启服务`
        : `已升级到 ${target}（未重启服务）`,
      restarted,
    };
    report("done", 100, result.message);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    report("error", 100, `升级失败：${msg}`);
    return {
      ok: false,
      status: "error",
      currentVersion: check.currentVersion,
      targetVersion: target,
      message: `升级失败：${msg}`,
    };
  }
}

