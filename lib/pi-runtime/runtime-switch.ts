/**
 * 显式切换 runtime slot 的 current 符号链接（管理员操作）。
 * 不下载、不 npm install、不自动升级；仅在已有 slot 间切换。
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  listRuntimeSlots,
  resolveSlotBinary,
  resolveUpgradePolicy,
} from "./runtime-upgrade";
import { readPiVersion } from "./resolve-binary";

export type SwitchRuntimeResult =
  | {
      ok: true;
      version: string;
      path: string;
      binary: string;
      binaryVersion: string | null;
    }
  | {
      ok: false;
      error: string;
      code:
        | "forbidden"
        | "not_found"
        | "invalid_version"
        | "no_binary"
        | "io_error";
    };

/**
 * 将 slotsRoot/current 指向指定 version 目录。
 * 门禁：policy.allowExplicitUpgrade 必须为 true（31415 默认 false 除非显式 env）。
 */
export function switchRuntimeSlot(
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): SwitchRuntimeResult {
  const policy = resolveUpgradePolicy(env);
  if (!policy.allowExplicitUpgrade) {
    return {
      ok: false,
      error: "当前策略禁止显式切换 runtime（31415 默认关闭；设 PIDANCE_PI_RUNTIME_EXPLICIT_UPGRADE=1）",
      code: "forbidden",
    };
  }

  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
    return { ok: false, error: `非法版本号: ${version}`, code: "invalid_version" };
  }

  const { slots } = listRuntimeSlots(policy.slotsRoot);
  const target = slots.find((s) => s.version === version);
  if (!target) {
    return {
      ok: false,
      error: `slot 不存在: ${version}（根目录 ${policy.slotsRoot}）`,
      code: "not_found",
    };
  }

  const binary = resolveSlotBinary(target.path);
  if (!binary) {
    return {
      ok: false,
      error: `slot ${version} 内未找到可执行 pi`,
      code: "no_binary",
    };
  }

  // 探针 --version（失败不切换）
  const binaryVersion = readPiVersion(binary);
  if (!binaryVersion) {
    return {
      ok: false,
      error: `slot ${version} 的 pi --version 失败`,
      code: "no_binary",
    };
  }

  const currentLink = join(policy.slotsRoot, "current");
  const tmpLink = join(policy.slotsRoot, `.current.tmp-${process.pid}`);

  try {
    mkdirSync(policy.slotsRoot, { recursive: true });
    // 原子替换：先写临时 symlink 再 rename
    try {
      if (existsSync(tmpLink)) unlinkSync(tmpLink);
    } catch {
      /* ignore */
    }
    symlinkSync(target.path, tmpLink);
    try {
      if (existsSync(currentLink) || lstatSync(currentLink).isSymbolicLink()) {
        // Windows/部分 FS：rename 覆盖 symlink 需先删
        try {
          unlinkSync(currentLink);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* current 不存在 */
    }
    renameSync(tmpLink, currentLink);
  } catch (err) {
    try {
      if (existsSync(tmpLink)) unlinkSync(tmpLink);
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: "io_error",
    };
  }

  return {
    ok: true,
    version,
    path: resolve(target.path),
    binary: resolve(binary),
    binaryVersion,
  };
}
