import { readdirSync } from "fs";
import { homedir } from "os";
import path from "path";
import { getAgentDir } from "./pi-paths";
import { getAdditionalAllowedRoots, normalizeSlashes } from "./allowed-roots";
import { getChatAttachmentsDir } from "./chat-attachments";
import { listAllSessions } from "./session-reader";
export { allowFileRoot, normalizeSlashes } from "./allowed-roots";

// Short-TTL cache for the allowed-roots set. Without this, every file list/read
// request re-scans every pi session on disk just to check access. 5s is short
// enough that newly-created cwds appear promptly; stored on globalThis so it
// survives Next.js hot-reload.
const ALLOWED_ROOTS_TTL_MS = 5_000;
const WINDOWS_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;

export function isWindowsAbsolutePath(filePath: string): boolean {
  return WINDOWS_ABSOLUTE_RE.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("//");
}

export async function getAllowedFileRoots(): Promise<Set<string>> {
  const now = Date.now();
  const cached = globalThis.__piAllowedRootsCache;
  if (cached && cached.expiresAt > now) return cached.roots;

  const sessions = await listAllSessions();
  const roots = getAllowedRootsFromSessions(sessions);

  // Also allow ~/pi-cwd-* directories created by the default-cwd endpoint.
  try {
    for (const name of readdirSync(homedir())) {
      if (/^pi-cwd-\d{8}$/.test(name)) {
        roots.add(normalizeSlashes(path.join(homedir(), name)));
      }
    }
  } catch {
    // ignore if home is unreadable
  }

  for (const root of getAdditionalAllowedRoots()) roots.add(root);

  // 聊天附件独立目录（~/.pi/agent/pidance-attachments），始终可预览/下载
  try {
    roots.add(getChatAttachmentsDir(getAgentDir()));
  } catch {
    // agentDir 不可用时跳过
  }

  globalThis.__piAllowedRootsCache = { roots, expiresAt: now + ALLOWED_ROOTS_TTL_MS };
  return roots;
}

export function getAllowedRootsFromSessions(sessions: Awaited<ReturnType<typeof listAllSessions>>): Set<string> {
  const roots = new Set<string>();
  for (const s of sessions) {
    if (s.readOnly !== true && s.cwd) roots.add(normalizeSlashes(s.cwd));
    // The project root (main repo shared by all worktrees) is browsable too —
    // the project dropdown lists it even when only worktrees have sessions.
    if (s.readOnly !== true && s.projectRoot) roots.add(normalizeSlashes(s.projectRoot));
  }

  return roots;
}

export function isFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  for (const root of allowedRoots) {
    const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
    const resolver = useWindowsRules ? path.win32 : path;
    const sep = useWindowsRules ? "\\" : path.sep;
    const normalized = resolver.resolve(target);
    const normalizedRoot = resolver.resolve(root);
    const comparable = useWindowsRules ? normalized.toLowerCase() : normalized;
    const comparableRoot = useWindowsRules ? normalizedRoot.toLowerCase() : normalizedRoot;
    const rootWithSep = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
    if (comparable === comparableRoot || comparable.startsWith(rootWithSep)) {
      return true;
    }
  }
  return false;
}
