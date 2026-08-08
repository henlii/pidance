/**
 * 运行时版本探测：Pidance / 管理面 pi npm / 外部 RPC runtime。
 * 纯只读，无副作用；供 /api/runtime 与 About 使用。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAgentRuntimeMode,
  resolveRuntimeBinary,
  type ResolvedRuntimeBinary,
  type RuntimeBinarySource,
} from "./resolve-binary";
import {
  buildUpgradeSnapshot,
  resolveFromSlots,
  type RuntimeUpgradeSnapshot,
} from "./runtime-upgrade";

export type RuntimeCapabilityFlags = {
  deltaOnlyMessageUpdate: boolean;
  agentSettled: boolean;
  bashExecutionUpdate: boolean;
  extensionUi: boolean;
  getEntries: boolean;
  getTree: boolean;
};

export type RuntimeInfo = {
  pidanceVersion: string;
  agentRuntimeMode: "inprocess" | "rpc";
  managementPiVersion: string | null;
  runtime: {
    path: string | null;
    version: string | null;
    source: RuntimeBinarySource;
    protocol: "rpc" | "inprocess";
    compatible: boolean;
  };
  /** 能力启发式（按版本号推断；未探针时为保守默认） */
  capabilities: RuntimeCapabilityFlags;
  /** 托管升级 slot / 策略（只读探测；不自动执行升级） */
  upgrade: RuntimeUpgradeSnapshot;
  notes: string[];
};

function readPackageVersion(pkgPath: string): string | null {
  try {
    const raw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : null;
  } catch {
    return null;
  }
}

function parseSemver(v: string | null): { major: number; minor: number; patch: number } | null {
  if (!v) return null;
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** 0.84+ 起 RPC message_update 可能为 delta-only。 */
function inferCapabilities(version: string | null, mode: "inprocess" | "rpc"): RuntimeCapabilityFlags {
  const sv = parseSemver(version);
  const is084Plus = !!sv && (sv.major > 0 || (sv.major === 0 && sv.minor >= 84));
  if (mode === "inprocess") {
    return {
      deltaOnlyMessageUpdate: false,
      agentSettled: false,
      bashExecutionUpdate: false,
      extensionUi: true,
      getEntries: false,
      getTree: false,
    };
  }
  return {
    deltaOnlyMessageUpdate: is084Plus,
    agentSettled: true,
    bashExecutionUpdate: is084Plus,
    extensionUi: true,
    getEntries: true,
    getTree: true,
  };
}

function isCompatible(mode: "inprocess" | "rpc", resolved: ResolvedRuntimeBinary): boolean {
  if (mode === "inprocess") return true;
  if (!resolved.path) return false;
  const sv = parseSemver(resolved.version);
  // 一期支持 0.81+ RPC；未知版本标记不兼容以便 UI 提示
  if (!sv) return false;
  if (sv.major === 0 && sv.minor < 81) return false;
  return true;
}

export function buildRuntimeInfo(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): RuntimeInfo {
  const mode = getAgentRuntimeMode(env);
  const pidanceVersion =
    readPackageVersion(join(cwd, "package.json")) ??
    env.NEXT_PUBLIC_APP_VERSION?.trim() ??
    "0.0.0";
  // slot current 优先于 PATH（若存在），便于托管升级切 current
  let resolved: ResolvedRuntimeBinary;
  if (mode === "rpc") {
    const fromSlot = resolveFromSlots(env);
    if (fromSlot) {
      resolved = {
        path: fromSlot.path,
        source: "configured-path",
        version: fromSlot.version,
      };
    } else {
      resolved = resolveRuntimeBinary(env);
    }
  } else {
    resolved = {
      path: null,
      source: "none",
      version: env.NEXT_PUBLIC_PI_VERSION?.trim() ?? null,
    };
  }

  // 管理面不再依赖 pi npm 包版本：与外部 runtime 同轨展示（或 env 覆盖）
  const runtimeVersion = mode === "rpc" ? resolved.version : resolved.version;
  const managementPiVersion =
    env.NEXT_PUBLIC_PI_VERSION?.trim() ||
    runtimeVersion ||
    null;
  const notes: string[] = [];
  if (mode === "rpc" && !resolved.path) {
    notes.push("未解析到外部 Pi 二进制；设置 PIDANCE_PI_RUNTIME 或将 pi 加入 PATH");
  }
  if (mode === "rpc" && resolved.source === "bundled-fallback") {
    notes.push("当前使用 bundled fallback CLI，不是独立可升级引擎");
  }

  const upgrade = buildUpgradeSnapshot(env, runtimeVersion);
  if (upgrade.recommendation === "available") {
    notes.push(upgrade.reason);
  }

  return {
    pidanceVersion,
    agentRuntimeMode: mode,
    managementPiVersion,
    runtime: {
      path: mode === "rpc" ? resolved.path : null,
      version: runtimeVersion,
      source: mode === "rpc" ? resolved.source : "none",
      protocol: mode === "rpc" ? "rpc" : "inprocess",
      compatible: isCompatible(mode, resolved),
    },
    capabilities: inferCapabilities(runtimeVersion, mode),
    upgrade,
    notes,
  };
}
