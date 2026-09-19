import { closeSync, lstatSync, openSync, readdirSync, readSync, realpathSync, rmdirSync, unlinkSync } from "fs";
import { basename, dirname, join, relative, resolve } from "path";
import type { SessionHeader } from "./types";

export type DiscoveredSubagent = {
  path: string;
  header: SessionHeader;
  runIndex: number;
  parentSessionId: string;
  runId: string;
  agent?: string;
};

const MAX_CHILDREN = 256;
const MAX_DEPTH = 16;
const MAX_SCAN_ENTRIES = 2048;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_LINE_BYTES = 128 * 1024;
const MAX_METADATA_CANDIDATES = 512;
/**
 * run 目录名：旧版（0.46.0）是 8 位 hex，0.68.0 起是完整 UUID
 * （同步 run 的目录名 == toolResult details.runId）。
 */
const RUN_ID_DIR = /^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const RUN_DIR = /^run-(\d+)$/;

const ASYNC_RUN = /^async-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SUBAGENT_DISCOVERY_LIMITS = {
  maxChildren: MAX_CHILDREN,
  maxDepth: MAX_DEPTH,
  maxScanEntries: MAX_SCAN_ENTRIES,
  maxMetadataBytes: MAX_METADATA_BYTES,
  maxMetadataLineBytes: MAX_METADATA_LINE_BYTES,
  maxMetadataCandidates: MAX_METADATA_CANDIDATES,
} as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRealFile(file: string, root: string): string | null {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || !file.endsWith(".jsonl")) return null;
    const real = realpathSync(file);
    const realRoot = realpathSync(root);
    const rel = relative(realRoot, real);
    if (!rel || rel.startsWith("..") || rel.includes("/../") || rel.includes("\\..\\")) return null;
    // 逐级检查，避免 realpath 把中间 symlink 隐藏后仍被当作候选。
    let current = realRoot;
    for (const part of rel.split(/[\\/]/)) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) return null;
    }
    return real;
  } catch { return null; }
}

function readHeader(file: string): SessionHeader | null {
  let fd = -1;
  try {
    fd = openSync(file, "r");
    const chunks: Buffer[] = [];
    let total = 0;
    let found = false;
    while (total < 65536 && !found) {
      const buffer = Buffer.allocUnsafe(Math.min(4096, 65536 - total));
      const count = readSync(fd, buffer, 0, buffer.length, total);
      if (!count) break;
      const part = buffer.subarray(0, count);
      const newline = part.indexOf(0x0a);
      chunks.push(newline >= 0 ? part.subarray(0, newline) : part);
      total += count;
      found = newline >= 0;
    }
    if (!found && total >= 65536) return null;
    const line = Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
    const value = JSON.parse(line) as unknown;
    if (!record(value) || value.type !== "session" || typeof value.id !== "string" || !value.id ||
      typeof value.cwd !== "string" || typeof value.timestamp !== "string") return null;
    return value as unknown as SessionHeader;
  } catch { return null; }
  finally { if (fd >= 0) closeSync(fd); }
}

function runIndex(file: string): number | null {
  const match = RUN_DIR.exec(basename(dirname(file)));
  return match ? Number(match[1]) : null;
}

function isDiscoveredLayout(file: string, root: string): boolean {
  const parts = relative(resolve(root), resolve(file)).split(/[\\/]/);
  // 同步/前台 run 布局：<root>/<runId>/run-<N>/session.jsonl
  if (parts.length === 3 && RUN_ID_DIR.test(parts[0]) && RUN_DIR.test(parts[1]) && parts[2] === "session.jsonl") return true;
  // async 布局（pi-subagents sessionDir）：<root>/async-<uuid>/*.jsonl（扁平）
  return parts.length === 2 && ASYNC_RUN.test(parts[0]) && parts[1].endsWith(".jsonl");
}

type MetadataCandidate = { path: string; runId?: string; agent?: string };
type MetadataScan = { candidates: MetadataCandidate[]; agents: Map<string, string> };

function metadataPaths(parentFile: string): MetadataScan {
  const candidates: MetadataCandidate[] = [];
  // 0.68.0 的 toolResult 不再给 results[].sessionFile，但 details.runId 与同步 run
  // 的目录名一致，用它把 agent 标签补回来（异步 run 目录名是另一个 UUID，走 activity）。
  const agents = new Map<string, string>();
  let fd = -1;
  try {
    fd = openSync(parentFile, "r");
    let carry = "";
    let total = 0;
    while (total < MAX_METADATA_BYTES && candidates.length < MAX_METADATA_CANDIDATES) {
      const buffer = Buffer.allocUnsafe(Math.min(65536, MAX_METADATA_BYTES - total));
      const count = readSync(fd, buffer, 0, buffer.length, total);
      if (!count) break;
      total += count;
      carry += buffer.subarray(0, count).toString("utf8");
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length > MAX_METADATA_LINE_BYTES) continue;
        parseMetadataLine(line, candidates, agents);
        if (candidates.length >= MAX_METADATA_CANDIDATES) break;
      }
    }
    if (carry.length <= MAX_METADATA_LINE_BYTES && candidates.length < MAX_METADATA_CANDIDATES) parseMetadataLine(carry, candidates, agents);
  } catch { /* 损坏的父文件不会阻断其它会话 */ }
  finally { if (fd >= 0) closeSync(fd); }
  return { candidates, agents };
}

export function validateSubagentFileForDeletion(file: string, parentRoot: string, expectedId: string): boolean {
  try {
    const checked = safeRealFile(file, parentRoot);
    return checked === realpathSync(file) && readHeader(file)?.id === expectedId;
  } catch { return false; }
}

export function deleteValidatedSubagents(
  children: DiscoveredSubagent[],
  parentRoot: string,
  invalidatePath: (id: string) => void,
): number {
  let skipped = 0;
  for (const child of [...children].sort((a, b) => b.path.length - a.path.length)) {
    try {
      if (!validateSubagentFileForDeletion(child.path, parentRoot, child.header.id)) {
        skipped++;
        continue;
      }
      // 删除前再次取得 realpath，避免路径在验证后被替换到受控根之外。
      const real = realpathSync(child.path);
      const root = realpathSync(parentRoot);
      const rel = relative(root, real);
      if (!rel || rel.startsWith("..") || rel.includes("/../") || rel.includes("\\..\\")) {
        skipped++;
        continue;
      }
      unlinkSync(child.path);
      invalidatePath(child.header.id);
      let directory = dirname(child.path);
      for (let level = 0; level < 4; level++) {
        try {
          const directoryStat = lstatSync(directory);
          if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) break;
          rmdirSync(directory);
        } catch { break; }
        directory = dirname(directory);
      }
    } catch { skipped++; }
  }
  return skipped;
}

function parseMetadataLine(line: string, candidates: MetadataCandidate[], agents: Map<string, string>): void {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return; }
  if (!record(value) || value.type !== "message" || !record(value.message) ||
    value.message.role !== "toolResult" || value.message.toolName !== "subagent" ||
    !record(value.message.details) || !Array.isArray(value.message.details.results)) return;
  const details = value.message.details as Record<string, unknown>;
  const results = details.results as unknown[];
  const runId = typeof details.runId === "string" ? details.runId : undefined;
  for (const result of results) {
    if (!record(result)) continue;
    const agent = typeof result.agent === "string" ? result.agent : typeof details.agent === "string" ? details.agent : undefined;
    if (runId && agent) agents.set(runId, agent);
    if (typeof result.sessionFile === "string") candidates.push({ path: result.sessionFile, runId, agent });
  }
}

function fallbackPaths(parentFile: string): string[] {
  const root = parentFile.endsWith(".jsonl") ? parentFile.slice(0, -6) : "";
  const result: string[] = [];
  if (!root) return result;
  try {
    for (const runId of readdirSync(root, { withFileTypes: true })) {
      if (!runId.isDirectory() || runId.isSymbolicLink() || !RUN_ID_DIR.test(runId.name)) continue;
      const runRoot = join(root, runId.name);
      for (const run of readdirSync(runRoot, { withFileTypes: true })) {
        if (!run.isDirectory() || run.isSymbolicLink() || !RUN_DIR.test(run.name)) continue;
        result.push(join(runRoot, run.name, "session.jsonl"));
        if (result.length >= MAX_SCAN_ENTRIES) return result;
      }
    }
    // async 布局：<root>/async-<uuid>/<timestamp>_<uuid>.jsonl（扁平，无 run-N）
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !ASYNC_RUN.test(entry.name)) continue;
      const asyncRoot = join(root, entry.name);
      const names = readdirSync(asyncRoot, { withFileTypes: true })
        .filter((file) => file.isFile() && !file.isSymbolicLink() && file.name.endsWith(".jsonl"))
        .map((file) => file.name)
        .sort();
      for (const name of names) {
        result.push(join(asyncRoot, name));
        if (result.length >= MAX_SCAN_ENTRIES) return result;
      }
    }
  } catch { /* 回退扫描失败即安全忽略 */ }
  return result;
}

export function discoverSubagentSessions(parentFile: string, parentId: string): DiscoveredSubagent[] {
  const parentRoot = parentFile.endsWith(".jsonl") ? parentFile.slice(0, -6) : "";
  if (!parentRoot) return [];
  const seenPaths = new Set<string>();
  const seenIds = new Set<string>();
  const found: DiscoveredSubagent[] = [];
  const scan = metadataPaths(parentFile);
  const candidates: MetadataCandidate[] = [...scan.candidates, ...fallbackPaths(parentFile).map((path) => ({ path }))];
  for (const candidate of candidates) {
    if (found.length >= MAX_CHILDREN) break;
    const absolute = resolve(candidate.path);
    const file = safeRealFile(absolute, parentRoot);
    if (!file || !isDiscoveredLayout(file, parentRoot) || seenPaths.has(file)) continue;
    const rel = relative(resolve(parentRoot), resolve(file)).split(/[\\/]/);
    const asyncLayout = rel.length === 2 && ASYNC_RUN.test(rel[0]);
    const index = asyncLayout ? 0 : runIndex(file);
    if (index === null || index < 0) continue;
    const header = readHeader(file);
    if (!header || seenIds.has(header.id) || header.id === parentId) continue;
    // 防止同一条祖先链被恶意 header 重新指回自身。
    const runId = asyncLayout ? rel[0].slice("async-".length) : candidate.runId ?? basename(dirname(dirname(file)));
    seenPaths.add(file);
    seenIds.add(header.id);
    found.push({ path: file, header, runIndex: index, parentSessionId: parentId, runId, agent: candidate.agent ?? scan.agents.get(runId) });
  }
  return found;
}

export function collectSubagentTree(parentFile: string, parentId: string): DiscoveredSubagent[] {
  const all: DiscoveredSubagent[] = [];
  const paths = new Set<string>([resolve(parentFile)]);
  const ids = new Set<string>([parentId]);
  const queue: Array<{ file: string; id: string; depth: number }> = [{ file: parentFile, id: parentId, depth: 0 }];
  while (queue.length && all.length < MAX_CHILDREN) {
    const current = queue.shift()!;
    if (current.depth >= MAX_DEPTH) continue;
    for (const child of discoverSubagentSessions(current.file, current.id)) {
      if (paths.has(child.path) || ids.has(child.header.id)) continue;
      paths.add(child.path); ids.add(child.header.id); all.push(child);
      queue.push({ file: child.path, id: child.header.id, depth: current.depth + 1 });
    }
  }
  return all;
}
