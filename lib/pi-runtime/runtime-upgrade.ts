/**
 * 托管 Pi runtime 升级：slot 布局与门禁（只读探测 + 显式升级入口骨架）。
 *
 * 硬规则：
 * - 31415 默认禁止静默自动升级
 * - 升级须白名单、隔离目录、--version 探针、可回滚 current 符号链接
 * - 本模块一期实现：slot 枚举、current 解析、升级策略判定；不执行 npm 全局安装
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type RuntimeSlot = {
  version: string;
  path: string;
  isCurrent: boolean;
};

export type RuntimeUpgradePolicy = {
  /** 是否允许自动升级（31415 默认 false） */
  allowAutoUpgrade: boolean;
  /** 是否允许管理员显式升级 API */
  allowExplicitUpgrade: boolean;
  /** slot 根目录 */
  slotsRoot: string;
};

export type RuntimeUpgradeSnapshot = {
  policy: RuntimeUpgradePolicy;
  slots: RuntimeSlot[];
  current: RuntimeSlot | null;
  /** 与已解析 runtime 对比后的提示 */
  recommendation: "none" | "available" | "blocked";
  reason: string;
};

const DEFAULT_SLOTS_REL = join(".pidance", "runtimes", "pi");

export function defaultSlotsRoot(home: string = homedir()): string {
  return join(home, DEFAULT_SLOTS_REL);
}

export function resolveUpgradePolicy(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeUpgradePolicy {
  const port = Number(env.PORT || env.PIDANCE_PORT || 0);
  // 31415 正式：默认禁自动；31416 测试：默认可显式，仍禁静默自动
  const isFormal = port === 31415;
  const allowAuto =
    env.PIDANCE_PI_RUNTIME_AUTO_UPGRADE === "1" && !isFormal;
  const allowExplicit =
    env.PIDANCE_PI_RUNTIME_EXPLICIT_UPGRADE === "1" ||
    (!isFormal && env.PIDANCE_PI_RUNTIME_EXPLICIT_UPGRADE !== "0");

  const slotsRoot =
    env.PIDANCE_PI_RUNTIME_SLOTS_DIR?.trim() ||
    defaultSlotsRoot(env.HOME || homedir());

  return {
    allowAutoUpgrade: allowAuto,
    allowExplicitUpgrade: allowExplicit,
    slotsRoot: resolve(slotsRoot),
  };
}

/**
 * 枚举 ~/.pidance/runtimes/pi/<version>/ 与 current 符号链接。
 * 目录不存在 → 空列表（不抛）。
 */
export function listRuntimeSlots(slotsRoot: string): {
  slots: RuntimeSlot[];
  current: RuntimeSlot | null;
} {
  if (!existsSync(slotsRoot)) {
    return { slots: [], current: null };
  }

  let currentTarget: string | null = null;
  const currentLink = join(slotsRoot, "current");
  try {
    if (existsSync(currentLink)) {
      const st = lstatSync(currentLink);
      if (st.isSymbolicLink()) {
        currentTarget = realpathSync(currentLink);
      } else if (st.isDirectory()) {
        currentTarget = resolve(currentLink);
      }
    }
  } catch {
    currentTarget = null;
  }

  const slots: RuntimeSlot[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(slotsRoot);
  } catch {
    return { slots: [], current: null };
  }

  for (const name of entries) {
    if (name === "current" || name.startsWith(".")) continue;
    // 版本目录名：semver 风格
    if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(name)) continue;
    const path = join(slotsRoot, name);
    try {
      if (!lstatSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    const resolved = resolve(path);
    slots.push({
      version: name,
      path: resolved,
      isCurrent: currentTarget !== null && resolved === currentTarget,
    });
  }

  slots.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
  const current = slots.find((s) => s.isCurrent) ?? null;
  return { slots, current };
}

export function buildUpgradeSnapshot(
  env: NodeJS.ProcessEnv = process.env,
  installedRuntimeVersion: string | null = null,
): RuntimeUpgradeSnapshot {
  const policy = resolveUpgradePolicy(env);
  const { slots, current } = listRuntimeSlots(policy.slotsRoot);

  if (!policy.allowAutoUpgrade && !policy.allowExplicitUpgrade) {
    return {
      policy,
      slots,
      current,
      recommendation: "blocked",
      reason: "当前端口/策略禁止 runtime 升级（31415 默认禁自动）",
    };
  }

  if (slots.length === 0) {
    return {
      policy,
      slots,
      current,
      recommendation: "none",
      reason: "无本地 runtime slot；可管理员显式安装到 slots 目录",
    };
  }

  // 有更高版本 slot 且非 current → available
  const latest = slots[slots.length - 1];
  if (current && latest.version !== current.version) {
    return {
      policy,
      slots,
      current,
      recommendation: policy.allowExplicitUpgrade ? "available" : "blocked",
      reason: `本地 slot 最新 ${latest.version}，current 为 ${current.version}`,
    };
  }

  if (
    installedRuntimeVersion &&
    latest &&
    latest.version !== installedRuntimeVersion
  ) {
    return {
      policy,
      slots,
      current,
      recommendation: policy.allowExplicitUpgrade ? "available" : "blocked",
      reason: `slot 最新 ${latest.version}，当前运行时 ${installedRuntimeVersion}`,
    };
  }

  return {
    policy,
    slots,
    current,
    recommendation: "none",
    reason: "current 已是本地最新 slot，或无可切换版本",
  };
}

/**
 * 解析 current slot 内的 pi 可执行文件路径（若存在）。
 * 约定：slot 目录下 `bin/pi` 或 `pi` 或 `dist/cli.js`。
 */
export function resolveSlotBinary(slotPath: string): string | null {
  const candidates = [
    join(slotPath, "bin", "pi"),
    join(slotPath, "pi"),
    join(slotPath, "dist", "cli.js"),
    join(slotPath, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return resolve(c);
    } catch {
      /* continue */
    }
  }
  // current 符号链接目标
  try {
    if (existsSync(slotPath) && lstatSync(slotPath).isSymbolicLink()) {
      return resolveSlotBinary(realpathSync(slotPath));
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 若存在 current slot 二进制，优先于 PATH（供 resolve 层可选接入）。 */
export function resolveFromSlots(
  env: NodeJS.ProcessEnv = process.env,
): { path: string; version: string } | null {
  const policy = resolveUpgradePolicy(env);
  const { current } = listRuntimeSlots(policy.slotsRoot);
  if (!current) return null;
  const bin = resolveSlotBinary(current.path);
  if (!bin) return null;
  return { path: bin, version: current.version };
}
