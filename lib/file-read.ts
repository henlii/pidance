import fs from "node:fs";
import path from "node:path";
import { isStrictPathChild } from "./file-save";
import { isFileAccessUnrestricted } from "./file-access";

// /api/files 读路径统一收敛的安全解析（P0-2：allow-list 符号链接绕过修复）。
// 语义：允许在 realpath 校验后跟随符号链接，但解析结果必须仍位于某个授权根
// 的 realpath 之内 —— 根内 symlink 指向根外一律拒绝（文件与目录、目录浏览同规则）。
// 读取文件内容时另以 O_NOFOLLOW + fstat 复核，防「校验后被替换成符号链接」竞态。

export type ReadPathResult =
  | { kind: "ok"; realPath: string; stat: fs.Stats }
  | { kind: "outside-roots"; realPath: string; stat: fs.Stats }
  | { kind: "not-found" }
  | { kind: "denied" };

function isNotFoundError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function resolveReadablePath(filePath: string, allowedRoots: Set<string>): ReadPathResult {
  let realTarget: string;
  try {
    realTarget = fs.realpathSync(filePath);
  } catch (error) {
    if (isNotFoundError(error)) return { kind: "not-found" };
    return { kind: "denied" };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realTarget);
  } catch (error) {
    if (isNotFoundError(error)) return { kind: "not-found" };
    return { kind: "denied" };
  }

  if (isFileAccessUnrestricted()) {
    return { kind: "ok", realPath: realTarget, stat };
  }

  let anyRootResolved = false;
  for (const root of allowedRoots) {
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      continue; // 失效根（已被删除/不可达）跳过
    }
    anyRootResolved = true;
    if (realTarget === realRoot || isStrictPathChild(realTarget, realRoot)) {
      return { kind: "ok", realPath: realTarget, stat };
    }
  }
  if (!anyRootResolved) return { kind: "denied" };
  return { kind: "outside-roots", realPath: realTarget, stat };
}

function comparablePath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

// 会话引用豁免的附加门禁：字面路径与 realpath 一致 ⇒ 路径链上无符号链接重定向，
// 读取的就是会话中引用的那个文件本身（例如授权根之外的临时 bash 输出日志）。
export function isNoSymlinkRedirection(filePath: string, realPath: string): boolean {
  try {
    return comparablePath(path.resolve(filePath)) === comparablePath(realPath);
  } catch {
    return false;
  }
}

// O_NOFOLLOW 打开 + fstat 复核：拒绝「realpath 校验与真正读取之间最终组件被
// 替换成符号链接」的 TOCTOU 竞态（参考 lib/bash-output.ts 的 openRegularFileNoFollow）。
// 调用方负责在读取完成后关闭返回的 fd。
export function openRegularFileReadonly(realPath: string): number {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(realPath, fs.constants.O_RDONLY | noFollow);
  try {
    const fileInfo = fs.fstatSync(fd);
    if (!fileInfo.isFile()) throw new Error("Read path is not a regular file");
    return fd;
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // 关闭失败不覆盖原错误
    }
    throw error;
  }
}
