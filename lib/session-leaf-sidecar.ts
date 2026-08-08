/**
 * 会话 leaf 指针 sidecar（业务附加元数据，不写入 Pi 原生 session JSONL）。
 *
 * 背景：外部 Pi RPC（0.83）打开 session 文件时 leaf = 文件最后一条 entry，
 * 且无公开 navigate/leaf 恢复命令。Pidance 导航到非末尾分支后需要记住目标
 * leaf，供磁盘写（activity/label/继续对话前校验）使用。
 *
 * 位置：`<session>.jsonl.leaf.json`（与 session 文件同目录）。
 * 结构：{ "version": 1, "leafId": "<entry id>" }
 *
 * 写入必须遵守单写者：调用方需确保外部 Pi 进程已 quiesce/destroy。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const LEAF_SIDECAR_VERSION = 1;
export const LEAF_SIDECAR_SUFFIX = ".leaf.json";

export type LeafSidecar = {
  version: number;
  leafId: string;
};

export function leafSidecarPath(sessionFile: string): string {
  return `${sessionFile}${LEAF_SIDECAR_SUFFIX}`;
}

/** 读取 sidecar；缺失/损坏 → null（安全降级，不抛错）。 */
export function readLeafSidecar(sessionFile: string): string | null {
  const path = leafSidecarPath(sessionFile);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const leafId = (parsed as { leafId?: unknown }).leafId;
    return typeof leafId === "string" && leafId ? leafId : null;
  } catch {
    return null;
  }
}

/** 原子写 sidecar；失败抛错（调用方决定是否降级）。 */
export function writeLeafSidecar(sessionFile: string, leafId: string): void {
  const path = leafSidecarPath(sessionFile);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const serialized = JSON.stringify(
    { version: LEAF_SIDECAR_VERSION, leafId },
    null,
    2,
  );
  const temp = join(dir, `.leaf-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, serialized, { encoding: "utf8", flag: "wx" });
    renameSync(temp, path);
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // 清理失败不覆盖原错误
    }
    throw error;
  }
}

/** 删除 sidecar（失败静默）。 */
export function clearLeafSidecar(sessionFile: string): void {
  try {
    const path = leafSidecarPath(sessionFile);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // 删除失败不影响 session 本身
  }
}
