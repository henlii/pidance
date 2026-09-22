import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { isFilePathAllowed } from "@/lib/file-access";

export class FileOpsError extends Error {
  readonly code: "bad-request" | "forbidden" | "not-found" | "conflict";
  constructor(code: FileOpsError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export type AllowedRoots = Iterable<string>;

function asRootSet(roots: AllowedRoots): Set<string> {
  return roots instanceof Set ? roots : new Set(roots);
}

/** 单层文件/目录名：禁止路径分隔、空名、受保护名与环境文件。 */
export function validateEntryName(name: string): string | null {
  if (!name || name === "." || name === ".." || name.includes("\0")) {
    return "Invalid name";
  }
  if (name.includes("/") || name.includes("\\") || path.basename(name) !== name) {
    return "Name must not contain a path";
  }
  // 写入/上传/保存已不做名称限制：允许 node_modules/dist/.env 等任意单层名称。
  return null;
}

function mapFsError(error: unknown, fallback: string): never {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") throw new FileOpsError("not-found", fallback);
  if (code === "EACCES" || code === "EPERM") throw new FileOpsError("forbidden", "Access denied");
  if (code === "EEXIST") throw new FileOpsError("conflict", "Already exists");
  throw error;
}

function realpathRoots(allowedRoots: AllowedRoots): Set<string> {
  const realRoots = new Set<string>();
  for (const root of asRootSet(allowedRoots)) {
    try {
      realRoots.add(fs.realpathSync(root));
    } catch {
      // 忽略已消失的会话根
    }
  }
  return realRoots;
}

/**
 * 可写目录：路径在 allow-list 内、存在且为目录；
 * 解析 realpath 后再次校验，防止 symlink 逃逸。
 */
export function resolveWritableDirectory(
  directory: string,
  allowedRoots: AllowedRoots,
): string {
  if (!isFilePathAllowed(directory, asRootSet(allowedRoots))) {
    throw new FileOpsError("forbidden", "Access denied");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(directory);
  } catch (error) {
    return mapFsError(error, "Directory not found");
  }
  if (!stat.isDirectory()) {
    throw new FileOpsError("bad-request", "Target is not a directory");
  }
  let realDirectory: string;
  try {
    realDirectory = fs.realpathSync(directory);
  } catch (error) {
    return mapFsError(error, "Directory not found");
  }
  if (!isFilePathAllowed(realDirectory, realpathRoots(allowedRoots))) {
    throw new FileOpsError("forbidden", "Access denied");
  }
  return realDirectory;
}

function assertNoSymlinkParents(start: string, stopAt: string): void {
  let current = start;
  for (;;) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(current);
    } catch (error) {
      return mapFsError(error, "Path not found");
    }
    if (st.isSymbolicLink()) {
      throw new FileOpsError("forbidden", "Symbolic links are not allowed");
    }
    if (current === stopAt) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** 在已授权目录下创建空文件（wx，不覆盖）。 */
export function createEmptyFile(
  directory: string,
  name: string,
  allowedRoots: AllowedRoots,
): { path: string; name: string } {
  const nameError = validateEntryName(name);
  if (nameError) throw new FileOpsError("bad-request", nameError);
  const realDir = resolveWritableDirectory(directory, allowedRoots);
  const target = path.join(realDir, name);
  if (!isFilePathAllowed(target, realpathRoots(allowedRoots))) {
    throw new FileOpsError("forbidden", "Access denied");
  }
  try {
    fs.writeFileSync(target, Buffer.alloc(0), { flag: "wx", mode: 0o644 });
  } catch (error) {
    return mapFsError(error, "Failed to create file");
  }
  return { path: target, name };
}

/** 在已授权目录下创建子目录（不递归、不覆盖）。 */
export function createDirectory(
  directory: string,
  name: string,
  allowedRoots: AllowedRoots,
): { path: string; name: string } {
  const nameError = validateEntryName(name);
  if (nameError) throw new FileOpsError("bad-request", nameError);
  const realDir = resolveWritableDirectory(directory, allowedRoots);
  const target = path.join(realDir, name);
  if (!isFilePathAllowed(target, realpathRoots(allowedRoots))) {
    throw new FileOpsError("forbidden", "Access denied");
  }
  try {
    fs.mkdirSync(target, { recursive: false, mode: 0o755 });
  } catch (error) {
    return mapFsError(error, "Failed to create directory");
  }
  return { path: target, name };
}

/**
 * 同目录重命名：newName 仅 basename；源与目标均须在 allow-list 内；
 * 拒绝 symlink 源/目标路径组件。
 */
export function renameEntry(
  target: string,
  newName: string,
  allowedRoots: AllowedRoots,
): { path: string; name: string } {
  const nameError = validateEntryName(newName);
  if (nameError) throw new FileOpsError("bad-request", nameError);

  const roots = asRootSet(allowedRoots);
  if (!isFilePathAllowed(target, roots)) {
    throw new FileOpsError("forbidden", "Access denied");
  }

  let sourceStat: fs.Stats;
  try {
    sourceStat = fs.lstatSync(target);
  } catch (error) {
    return mapFsError(error, "Not found");
  }
  if (sourceStat.isSymbolicLink()) {
    throw new FileOpsError("forbidden", "Symbolic links are not allowed");
  }

  let realSource: string;
  try {
    realSource = fs.realpathSync(target);
  } catch (error) {
    return mapFsError(error, "Not found");
  }
  const realRoots = realpathRoots(allowedRoots);
  if (!isFilePathAllowed(realSource, realRoots)) {
    throw new FileOpsError("forbidden", "Access denied");
  }

  const parent = path.dirname(realSource);
  assertNoSymlinkParents(parent, parent);
  const destination = path.join(parent, newName);
  if (destination === realSource) {
    return { path: realSource, name: newName };
  }
  if (!isFilePathAllowed(destination, realRoots)) {
    throw new FileOpsError("forbidden", "Access denied");
  }
  if (fs.existsSync(destination)) {
    throw new FileOpsError("conflict", "Already exists");
  }

  try {
    fs.renameSync(realSource, destination);
  } catch (error) {
    return mapFsError(error, "Rename failed");
  }
  return { path: destination, name: newName };
}

/**
 * 跨目录移动（文件/目录）：源 → 目标目录。源与目标均须在 allow-list 内；
 * 拒绝 symlink 源；目标已存在 → conflict；目录不可移入自身子目录。
 */
export function moveEntry(
  source: string,
  targetDirectory: string,
  allowedRoots: AllowedRoots,
): { path: string; name: string } {
  const roots = asRootSet(allowedRoots);
  const realRoots = realpathRoots(allowedRoots);
  if (!isFilePathAllowed(source, roots)) {
    throw new FileOpsError("forbidden", "Access denied");
  }

  let sourceStat: fs.Stats;
  try {
    sourceStat = fs.lstatSync(source);
  } catch (error) {
    return mapFsError(error, "Not found");
  }
  if (sourceStat.isSymbolicLink()) {
    throw new FileOpsError("forbidden", "Symbolic links are not allowed");
  }

  let realSource: string;
  try {
    realSource = fs.realpathSync(source);
  } catch (error) {
    return mapFsError(error, "Not found");
  }
  if (!isFilePathAllowed(realSource, realRoots)) {
    throw new FileOpsError("forbidden", "Access denied");
  }
  assertNoSymlinkParents(path.dirname(realSource), realSource);

  const realTargetDir = resolveWritableDirectory(targetDirectory, allowedRoots);
  const destination = path.join(realTargetDir, path.basename(realSource));
  if (destination === realSource) {
    return { path: realSource, name: path.basename(realSource) };
  }
  if (!isFilePathAllowed(destination, realRoots)) {
    throw new FileOpsError("forbidden", "Access denied");
  }
  // 目录不可移入自身或自身子目录（rename 到自身子目录会破坏结构）。
  if (sourceStat.isDirectory()) {
    const rel = path.relative(realSource, realTargetDir);
    if (rel === "" || (!rel.startsWith("..") && rel !== ".." && !path.isAbsolute(rel))) {
      throw new FileOpsError("bad-request", "Cannot move a directory into itself");
    }
  }
  if (fs.existsSync(destination)) {
    throw new FileOpsError("conflict", "Already exists");
  }

  try {
    fs.renameSync(realSource, destination);
  } catch (error) {
    return mapFsError(error, "Move failed");
  }
  return { path: destination, name: path.basename(destination) };
}

/**
 * 复制（文件/目录）：源 → 目标目录。源与目标均须在 allow-list 内；
 * 拒绝 symlink 源（含目录内）；目标已存在 → conflict。
 */
export function copyEntry(
  source: string,
  targetDirectory: string,
  allowedRoots: AllowedRoots,
): { path: string; name: string } {
  const roots = asRootSet(allowedRoots);
  const realRoots = realpathRoots(allowedRoots);
  if (!isFilePathAllowed(source, roots)) {
    throw new FileOpsError("forbidden", "Access denied");
  }

  let sourceStat: fs.Stats;
  try {
    sourceStat = fs.lstatSync(source);
  } catch (error) {
    return mapFsError(error, "Not found");
  }
  if (sourceStat.isSymbolicLink()) {
    throw new FileOpsError("forbidden", "Symbolic links are not allowed");
  }

  let realSource: string;
  try {
    realSource = fs.realpathSync(source);
  } catch (error) {
    return mapFsError(error, "Not found");
  }
  if (!isFilePathAllowed(realSource, realRoots)) {
    throw new FileOpsError("forbidden", "Access denied");
  }
  assertNoSymlinkParents(path.dirname(realSource), realSource);

  const realTargetDir = resolveWritableDirectory(targetDirectory, allowedRoots);
  const destination = path.join(realTargetDir, path.basename(realSource));
  if (destination === realSource) {
    throw new FileOpsError("bad-request", "Cannot copy onto itself");
  }
  if (!isFilePathAllowed(destination, realRoots)) {
    throw new FileOpsError("forbidden", "Access denied");
  }
  if (fs.existsSync(destination)) {
    throw new FileOpsError("conflict", "Already exists");
  }

  try {
    if (sourceStat.isDirectory()) {
      fs.cpSync(realSource, destination, { recursive: true, dereference: false });
    } else {
      fs.copyFileSync(realSource, destination, fs.constants.COPYFILE_EXCL);
    }
  } catch (error) {
    return mapFsError(error, "Copy failed");
  }
  return { path: destination, name: path.basename(destination) };
}

/** 同名副本的序号后缀：` (1)`、` (2)`…（`name (1).png` 再加副本 → `name (2).png`）。 */
const COPY_SUFFIX_RE = / \((\d+)\)$/;

/**
 * 在目标目录里挑一个不冲突的文件名：优先原名，其次 `name (1).ext`、`name (2).ext`…
 *
 * 已带序号的名字先剥掉序号再编号，避免连续「另存为」叠成 `name (1) (1).png`。
 */
export function uniqueCopyName(directory: string, baseName: string): string {
  const ext = path.extname(baseName);
  const stem = ext ? baseName.slice(0, baseName.length - ext.length) : baseName;
  const bare = stem.replace(COPY_SUFFIX_RE, "");
  let candidate = baseName;
  for (let n = 1; n <= 1000; n += 1) {
    if (!fs.existsSync(path.join(directory, candidate))) return candidate;
    candidate = `${bare} (${n})${ext}`;
  }
  throw new FileOpsError("conflict", "Too many copies");
}

/**
 * 「另存为」：把源文件复制到用户选定的目录，**原文件保留**。
 *
 * 与 copyEntry 的差别只有冲突口径：同名时自动加 ` (n)` 后缀，而不是报冲突 ——
 * 用户点的是「另存为」，想要的是多一份副本，不该被一个已存在的同名文件挡住。
 * 校验沿用同一套：源必须在 allow-list 内且不是符号链接，目标目录必须存在、是目录、
 * realpath 后仍在 allow-list 内（当前访问范围已放开，等同 PTY）。
 */
export function saveFileAs(
  source: string,
  targetDirectory: string,
  allowedRoots: AllowedRoots = [],
): { path: string; name: string } {
  const roots = asRootSet(allowedRoots);
  if (!isFilePathAllowed(source, roots)) {
    throw new FileOpsError("forbidden", "Access denied");
  }
  let sourceStat: fs.Stats;
  try {
    sourceStat = fs.lstatSync(source);
  } catch (error) {
    return mapFsError(error, "Not found");
  }
  if (sourceStat.isSymbolicLink()) {
    throw new FileOpsError("forbidden", "Symbolic links are not allowed");
  }
  if (!sourceStat.isFile()) {
    throw new FileOpsError("bad-request", "Only files can be saved as");
  }
  let realSource: string;
  try {
    realSource = fs.realpathSync(source);
  } catch (error) {
    return mapFsError(error, "Not found");
  }
  if (!isFilePathAllowed(realSource, realpathRoots(allowedRoots))) {
    throw new FileOpsError("forbidden", "Access denied");
  }

  const realTargetDir = resolveWritableDirectory(targetDirectory, allowedRoots);
  const name = uniqueCopyName(realTargetDir, path.basename(realSource));
  const destination = path.join(realTargetDir, name);
  if (destination === realSource) {
    throw new FileOpsError("bad-request", "Cannot copy onto itself");
  }
  try {
    fs.copyFileSync(realSource, destination, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    return mapFsError(error, "Copy failed");
  }
  return { path: destination, name };
}

/**
 * 将目录打成 gzip tar 流（依赖系统 tar）。
 * 调用方须已完成 allow-list / realpath 校验。
 */
export function createDirectoryTarGzStream(directory: string): ReadableStream<Uint8Array> {
  const parent = path.dirname(directory);
  const base = path.basename(directory);
  const child = spawn("tar", ["-czf", "-", "-C", parent, base], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout) {
    child.kill();
    throw new FileOpsError("bad-request", "Failed to start archive");
  }
  child.stderr?.resume();
  child.on("error", () => {
    // spawn 失败时 Readable 会 error；路由层捕获
  });
  return Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
}

export function fileOpsStatus(code: FileOpsError["code"]): number {
  switch (code) {
    case "bad-request": return 400;
    case "forbidden": return 403;
    case "not-found": return 404;
    case "conflict": return 409;
    default: return 500;
  }
}
