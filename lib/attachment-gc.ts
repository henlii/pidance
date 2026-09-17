/**
 * 附件目录的兜底回收。
 *
 * 前端在「用户删除输入框附件」时会显式删服务端文件，但关标签、崩溃、清队、
 * 会话删除之后仍会留下没人引用的文件；这里按「引用 + 保留期」兜底清扫：
 * 只删**没有任何引用、且 mtime 早于保留期**的文件。
 *
 * 安全前提：引用集合必须完整。偏好文件读不出来、会话目录列不出来、单个会话文件
 * 读不出来，都视为「可能有引用没看到」→ 本轮一个文件都不删（宁可留垃圾）。
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { getAgentDir } from "./pi-paths";
import {
  CHAT_ATTACHMENTS_DIR_NAME,
  deleteChatAttachmentMedia,
  getChatAttachmentsDir,
  listChatAttachmentFiles,
} from "./chat-attachments";
import { getPidancePrefsPath, isPlainRecord, type PidancePrefs } from "./pidance-prefs-file";

/**
 * 未被引用的附件保留期。草稿（draft-store 服务端 GC）的引用窗口是 30 天，
 * 取同一档：任何还活着的引用都不会比它更久。
 */
export const ATTACHMENT_GC_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AttachmentGcResult {
  /** 附件目录里的常规文件总数 */
  scanned: number;
  /** 超过保留期、进入删除判定的文件数 */
  candidates: number;
  deleted: number;
  /** 回收的字节数 */
  bytes: number;
  /** 引用集合是否完整（false = 已放弃本轮回收，一个文件都没删） */
  complete: boolean;
}

/**
 * 仍被引用的附件路径集合；引用集合不完整时返回 null（调用方必须放弃回收）。
 *
 * 引用来源不跟具体 schema 走：偏好文件里任何指向附件目录的字符串都算引用
 * （队列条目、草稿，以及以后新增的引用位置），会话 JSONL 里同理。
 */
export function collectReferencedAttachmentPaths(agentDir: string = getAgentDir()): Set<string> | null {
  const root = getChatAttachmentsDir(agentDir);
  const prefs = readPrefsStrict(agentDir);
  if (prefs === null) return null;

  const referenced = new Set<string>();
  collectReferences(prefs, root, referenced);

  const sessionFiles = listSessionFiles(join(agentDir, "sessions"));
  if (sessionFiles === null) return null;
  for (const file of sessionFiles) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      // 读不出一个会话就可能在漏引用：整轮放弃
      return null;
    }
    if (content.includes(CHAT_ATTACHMENTS_DIR_NAME)) collectReferencesFromText(content, root, referenced);
  }
  return referenced;
}

/** 删除超过保留期且无人引用的附件文件。 */
export function sweepUnreferencedAttachments(options: {
  agentDir?: string;
  ttlMs?: number;
  now?: number;
} = {}): AttachmentGcResult {
  const agentDir = options.agentDir ?? getAgentDir();
  const ttlMs = options.ttlMs ?? ATTACHMENT_GC_TTL_MS;
  const now = options.now ?? Date.now();

  const files = listChatAttachmentFiles(agentDir);
  const candidates = files.filter((file) => now - file.mtimeMs > ttlMs);
  if (candidates.length === 0) {
    // 没有过期候选就完全不读会话（常见路径，避免每次启动扫全量 JSONL）
    return { scanned: files.length, candidates: 0, deleted: 0, bytes: 0, complete: true };
  }

  const referenced = collectReferencedAttachmentPaths(agentDir);
  if (referenced === null) {
    return { scanned: files.length, candidates: candidates.length, deleted: 0, bytes: 0, complete: false };
  }

  let deleted = 0;
  let bytes = 0;
  for (const candidate of candidates) {
    if (referenced.has(candidate.path)) continue;
    if (!deleteChatAttachmentMedia(candidate.path, agentDir)) continue;
    deleted += 1;
    bytes += candidate.size;
  }
  return { scanned: files.length, candidates: candidates.length, deleted, bytes, complete: true };
}

/** 偏好文件严格读取：损坏/非对象返回 null（区别于「没有偏好文件」）。 */
function readPrefsStrict(agentDir: string): PidancePrefs | null {
  const path = getPidancePrefsPath(agentDir);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function collectReferences(value: unknown, root: string, out: Set<string>, depth = 0): void {
  if (depth > 16) return;
  if (typeof value === "string") {
    if (value.startsWith(root)) out.add(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, root, out, depth + 1);
    return;
  }
  if (isPlainRecord(value)) {
    for (const item of Object.values(value)) collectReferences(item, root, out, depth + 1);
  }
}

/**
 * 从会话 JSONL 文本里提取附件路径。
 *
 * 落盘名不含引号/反斜杠（sanitizeAttachmentFileName 保证），所以取到分隔符即可；
 * 多认几个终止符是保守做法：漏认只会多留文件，不会多删。
 */
function collectReferencesFromText(content: string, root: string, out: Set<string>): void {
  let index = content.indexOf(root);
  while (index >= 0) {
    let end = index;
    while (end < content.length && !/["'\\\s,)\]]/.test(content[end]!)) end += 1;
    out.add(content.slice(index, end));
    index = content.indexOf(root, end);
  }
}

/** 会话 JSONL 文件列表；目录存在但列不出来时返回 null（调用方放弃回收）。 */
function listSessionFiles(dir: string): string[] | null {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  const walk = (current: string): boolean => {
    const entries = (() => {
      try {
        return readdirSync(current, { withFileTypes: true });
      } catch {
        return null;
      }
    })();
    if (entries === null) return false;
    for (const entry of entries) {
      const target = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!walk(target)) return false;
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(target);
    }
    return true;
  };
  return walk(dir) ? files : null;
}
