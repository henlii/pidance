"use client";

import {
  forwardRef,
  useState,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { getFileIcon, FolderIcon } from "./FileIcons";
import { MoreVerticalIcon, PencilIcon } from "./session-sidebar/display";
import {
  encodeFilePathForApi,
  getFileDirectory,
  getRelativeFilePath,
  joinFilePath,
  normalizeFilePathSlashes,
} from "@/lib/file-paths";
import { copyText } from "@/lib/clipboard";
import { FileTreePicker } from "./FileTreePicker";
import type { GitFileStatus, GitFileStatusKind, GitStatusResponse } from "@/lib/git-types";
import { useI18n } from "@/lib/i18n";
import { loadSidebarPreferences, saveFileExplorerState } from "@/lib/ui-preferences";
import { ensureServerPrefsLoaded, getServerPref, setServerPref, useServerPreferences } from "@/lib/server-preferences";
import { DEFAULT_FILE_CONFIG, parseFileConfig, type FileConfig } from "@/lib/file-config-shared";

interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

interface FileNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  children?: FileNode[];
  loaded?: boolean;
}

interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  refreshKey?: number;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  onUploadBusyChange?: (busy: boolean) => void;
}

export interface FileExplorerHandle {
  openUploadPicker: () => void;
  /** 在项目根 cwd 下开始新建文件（内联输入）。 */
  startCreateFile: () => void;
  /** 在项目根 cwd 下开始新建文件夹（内联输入）。 */
  startCreateDir: () => void;
  /** 打开/关闭文件设置面板。 */
  toggleConfig: () => void;
}

type UploadPhase = "idle" | "checking" | "uploading";
type UploadConflictStrategy = "error" | "overwrite" | "skip";

interface UploadError {
  name: string;
  error: string;
}

interface UploadResponse {
  uploaded?: string[];
  skipped?: string[];
  errors?: UploadError[];
  conflicts?: string[];
  nonReplaceable?: string[];
  error?: string;
}

interface UploadSummary {
  uploaded: string[];
  skipped: string[];
  errors: UploadError[];
}

interface PendingConflict {
  files: File[];
  conflicts: string[];
  nonReplaceable: string[];
}

async function fetchEntries(dirPath: string, t: ReturnType<typeof useI18n>["t"]): Promise<FileNode[]> {
  const encoded = encodeFilePathForApi(dirPath);
  const res = await fetch(`/api/files/${encoded}?type=list`);
  if (!res.ok) {
    let message = t("files_loadFailed", { status: res.status });
    try {
      const data = await res.json() as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(message);
  }
  const data = await res.json() as { entries?: FileEntry[] };
  return (data.entries ?? []).map((e) => ({
    name: e.name,
    fullPath: joinFilePath(dirPath, e.name),
    isDir: e.isDir,
    size: e.size,
    children: e.isDir ? [] : undefined,
    loaded: !e.isDir,
  }));
}

async function fetchGitStatus(cwd: string, t: ReturnType<typeof useI18n>["t"]): Promise<GitStatusResponse> {
  const params = new URLSearchParams({ cwd });
  const res = await fetch(`/api/git/status?${params.toString()}`);
  if (!res.ok) throw new Error(t("files_gitStatusLoadFailed", { status: res.status }));
  return res.json() as Promise<GitStatusResponse>;
}

export const GIT_STATUS_LABELS: Record<GitFileStatusKind, string> = {
  modified: "files_modified",
  added: "files_added",
  deleted: "files_deleted",
  renamed: "files_renamed",
  untracked: "files_untracked",
  conflict: "files_conflict",
};

const GIT_STATUS_KEYS = {
  modified: "files_modified", added: "files_added", deleted: "files_deleted",
  renamed: "files_renamed", untracked: "files_untracked", conflict: "files_conflict",
} as const;

export const GIT_STATUS_COLORS: Record<GitFileStatusKind, string> = {
  modified: "var(--status-warning)",
  added: "var(--status-success)",
  deleted: "var(--status-danger)",
  renamed: "var(--status-unread)",
  untracked: "var(--status-success)",
  conflict: "var(--status-danger)",
};

function uploadFiles(
  targetDirectory: string,
  files: File[],
  strategy: UploadConflictStrategy,
  onProgress: (progress: number) => void,
  t: ReturnType<typeof useI18n>["t"],
): Promise<{ status: number; data: UploadResponse }> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    files.forEach((file) => formData.append("files", file, file.name));

    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/files/${encodeFilePathForApi(targetDirectory)}?type=upload&conflict=${strategy}`,
    );
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new Error(t("files_uploadNetworkError")));
    xhr.onabort = () => reject(new Error(t("files_uploadCancelled")));
    xhr.onload = () => {
      let data: UploadResponse = {};
      try {
        data = JSON.parse(xhr.responseText) as UploadResponse;
      } catch {
        if (xhr.responseText) data.error = xhr.responseText;
      }
      resolve({ status: xhr.status, data });
    };
    xhr.send(formData);
  });
}

function MentionIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </svg>
  );
}

function DismissButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{ width: 24, height: 24, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "none", borderRadius: 4, background: "none", color: "var(--text-dim)", cursor: "pointer" }}
      onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text-muted)"; event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-dim)"; event.currentTarget.style.background = "none"; }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
        <path d="m6 6 12 12" />
        <path d="m18 6-12 12" />
      </svg>
    </button>
  );
}

// ---------------------------------------------------------------------------
// 文件行菜单：postFileOp / NameDraftRow / FileRowMenu
// ---------------------------------------------------------------------------

/** 文件创建/重命名/移动/复制统一入口：POST /api/files/...?type=... */
async function postFileOp(
  filePath: string,
  type: "create-file" | "create-dir" | "rename" | "move" | "copy",
  body: { name?: string; newName?: string; targetDirectory?: string },
): Promise<{ path: string; name: string }> {
  const res = await fetch(`/api/files/${encodeFilePathForApi(filePath)}?type=${type}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({})) as { path?: string; name?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return { path: data.path ?? filePath, name: data.name ?? "" };
}

/**
 * 内联命名输入行：Enter 提交、Escape 取消、空值 blur 取消；成功后回调 onDone(true)。
 * create-file/create-dir 时 targetPath 为目标目录；rename 时 targetPath 为被重命名条目本身。
 */
function NameDraftRow({ targetPath, type, defaultName, placeholder, paddingLeft, onDone, t }: {
  targetPath: string;
  type: "create-file" | "create-dir" | "rename";
  defaultName?: string;
  placeholder: string;
  /** 缩进：与所在行层级对齐。 */
  paddingLeft: number;
  onDone: (success: boolean) => void;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const [value, setValue] = useState(defaultName ?? "");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // 挂载后聚焦并全选（重命名场景便于直接覆盖旧名）。
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = useCallback(async () => {
    const name = value.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      if (type === "rename") {
        await postFileOp(targetPath, "rename", { newName: name });
      } else {
        await postFileOp(targetPath, type, { name });
      }
      onDoneRef.current(true);
    } catch (error) {
      // 失败时保留输入供修正重试，并提示原因。
      const message = error instanceof Error ? error.message : String(error);
      window.alert(`${type === "rename" ? t("files_renameFailed") : t("files_createFailed")}: ${message}`);
      setBusy(false);
    }
  }, [busy, t, targetPath, type, value]);

  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft, paddingRight: 8, height: 24 }}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            onDoneRef.current(false);
          }
        }}
        onBlur={() => { if (!busy) onDoneRef.current(false); }}
        placeholder={placeholder}
        disabled={busy}
        aria-label={placeholder}
        style={{
          flex: 1,
          minWidth: 0,
          height: 20,
          padding: "0 6px",
          fontSize: 12,
          border: "1px solid var(--accent)",
          borderRadius: 4,
          outline: "none",
          background: "var(--bg-panel)",
          color: "var(--text)",
          fontFamily: "inherit",
        }}
      />
      {busy && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
        </svg>
      )}
      {!busy && (
        <>
          <button
            type="button"
            disabled={!value.trim()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void submit()}
            aria-label={t("files_confirmRename")}
            title={t("files_confirmRename")}
            style={draftActionButtonStyle}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m5 12 4 4L19 6" />
            </svg>
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onDoneRef.current(false)}
            aria-label={t("files_cancelRename")}
            title={t("files_cancelRename")}
            style={draftActionButtonStyle}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </>
      )}
    </div>
  );
}

const draftActionButtonStyle: CSSProperties = {
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  padding: 0,
  border: "none",
  borderRadius: 4,
  background: "transparent",
  color: "var(--text-dim)",
  cursor: "pointer",
};

/**
 * 文件行三点菜单（风格对齐 SessionRowMenu）：fixed 定位，视口底部不足时向上翻转。
 * 下载（文件/目录均 tar.gz 由 ?type=download 统一处理）、重命名、复制路径；
 * 目录另有新建文件/新建文件夹。触发按钮带 data-menu-open 供 CSS 保持操作区可见。
 */
function FileRowMenu({ entryPath, name, isDir, cwd, onRename, onCreate, onMove, onCopy, onDelete, t }: {
  entryPath: string;
  name: string;
  isDir: boolean;
  cwd: string;
  onRename: () => void;
  onCreate: (kind: "create-file" | "create-dir") => void;
  onMove: () => void;
  onCopy: () => void;
  onDelete: () => void;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const [open, setOpen] = useState(false);
  // left/top 视口坐标；portal 到 body，避开 workspace transform 导致 fixed 错位
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const label = t("files_rowMenuLabel", { name });

  const close = useCallback((focus = false) => {
    setOpen(false);
    if (focus) triggerRef.current?.focus();
  }, []);

  // 点击外部/视口变化时关闭；打开后焦点移入首个菜单项。
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) close();
    };
    const viewport = () => close();
    document.addEventListener("mousedown", outside);
    window.addEventListener("resize", viewport);
    // 仅窗口滚动关闭；不监听 capture 滚动（面板内滚动会误关）
    window.addEventListener("scroll", viewport);
    const frame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus());
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("resize", viewport);
      window.removeEventListener("scroll", viewport);
    };
  }, [close, open]);

  const openMenu = () => {
    if (open) { close(); return; }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const estimatedMenuHeight = isDir ? 280 : 212;
      const estimatedMenuWidth = 200;
      const top = rect.bottom + 4 + estimatedMenuHeight <= window.innerHeight
        ? rect.bottom + 4
        : Math.max(8, rect.top - estimatedMenuHeight - 4);
      // 右对齐触发按钮，必要时向左夹紧
      let left = rect.right - estimatedMenuWidth;
      left = Math.max(8, Math.min(left, window.innerWidth - estimatedMenuWidth - 8));
      setPosition({ top, left });
    }
    setOpen(true);
  };

  const itemStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 8, width: "100%", minHeight: 32, padding: "6px 11px", boxSizing: "border-box", background: "var(--bg-elevated)", border: "none", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", textDecoration: "none", fontSize: 12, whiteSpace: "nowrap" };
  const hover = {
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; },
    onMouseLeave: (event: React.MouseEvent<HTMLElement>) => { event.currentTarget.style.background = "var(--bg-elevated)"; event.currentTarget.style.color = "var(--text-muted)"; },
  };
  const menuIcon = (child: ReactNode) => <span aria-hidden="true" style={{ display: "flex", color: "var(--text-dim)" }}>{child}</span>;

  return (
    <div
      style={{ display: "flex", flexShrink: 0 }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          e.stopPropagation();
          close(true);
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="file-row-action-btn"
        data-menu-open={open ? "true" : undefined}
        onClick={(e) => { e.stopPropagation(); openMenu(); }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
      >
        <MoreVerticalIcon size={12} />
      </button>
      {open && position && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          style={{ position: "fixed", top: position.top, left: position.left, zIndex: 10060, minWidth: 190, padding: 4, background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)" }}
        >
          <a
            role="menuitem"
            href={`/api/files/${encodeFilePathForApi(entryPath)}?type=download`}
            download
            style={itemStyle}
            {...hover}
            onClick={() => close()}
          >
            {menuIcon(
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            )}
            {t(isDir ? "files_downloadFolder" : "viewer_download", isDir ? { name } : undefined)}
          </a>
          {isDir && (
            <>
              <button type="button" role="menuitem" style={itemStyle} {...hover} onClick={() => { close(); onCreate("create-file"); }}>
                {menuIcon(
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
                    <path d="M14 2v6h6" />
                    <path d="M12 18v-6" />
                    <path d="M9 15h6" />
                  </svg>
                )}
                {t("files_newFile")}
              </button>
              <button type="button" role="menuitem" style={itemStyle} {...hover} onClick={() => { close(); onCreate("create-dir"); }}>
                {menuIcon(
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 8 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                    <path d="M12 11v6" />
                    <path d="M9 14h6" />
                  </svg>
                )}
                {t("files_newFolder")}
              </button>
            </>
          )}
          <button type="button" role="menuitem" style={itemStyle} {...hover} onClick={() => { close(); void copyText(getRelativeFilePath(entryPath, cwd)).catch(() => window.alert(t("files_copyPathFailed"))); }}>
            {menuIcon(
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
            {t("files_copyPath")}
          </button>
          <button type="button" role="menuitem" style={itemStyle} {...hover} onClick={() => { close(); onRename(); }}>
            {menuIcon(<PencilIcon size={13} />)}
            {t("files_rename")}
          </button>
          <button type="button" role="menuitem" style={itemStyle} {...hover} onClick={() => { close(); onMove(); }}>
            {menuIcon(
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
              </svg>
            )}
            {t("files_move")}
          </button>
          <button type="button" role="menuitem" style={itemStyle} {...hover} onClick={() => { close(); onCopy(); }}>
            {menuIcon(
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
            {t("files_copy")}
          </button>
          <button type="button" role="menuitem" style={{ ...itemStyle, color: "var(--status-danger)" }} {...hover} onClick={() => { close(); onDelete(); }}>
            {menuIcon(
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 6h18" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            )}
            {t("files_delete")}
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

function TreeNode({
  node,
  depth,
  cwd,
  onOpenFile,
  onAtMention,
  expandedPaths,
  onToggleExpanded,
  refreshToken,
  highlightedPaths,
  gitStatusByPath,
  changedDirectoryPaths,
  onMutated,
  onMoveEntry,
  onCopyEntry,
  onDeleteEntry,
  t,
}: {
  node: FileNode;
  depth: number;
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  refreshToken: string;
  highlightedPaths: Set<string>;
  gitStatusByPath: Map<string, GitFileStatus>;
  changedDirectoryPaths: Set<string>;
  /** 文件创建/重命名成功后回调，用于刷新树。 */
  onMutated: () => void;
  /** 打开移动/复制目标选择弹窗。 */
  onMoveEntry: (path: string, name: string) => void;
  onCopyEntry: (path: string, name: string) => void;
  onDeleteEntry: (path: string, name: string, isDir: boolean) => void;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const open = expandedPaths.has(node.fullPath);
  const highlighted = highlightedPaths.has(node.fullPath);
  const normalizedPath = normalizeFilePathSlashes(node.fullPath);
  const gitStatus = gitStatusByPath.get(normalizedPath);
  const containsGitChanges = node.isDir && (
    gitStatus !== undefined || changedDirectoryPaths.has(normalizedPath)
  );
  const [children, setChildren] = useState<FileNode[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const [loading, setLoading] = useState(false);
  /** 拖拽悬停高亮（仅目录可放置）。 */
  const [dragOver, setDragOver] = useState(false);
  /** 内联命名草稿：rename 替换当前行；create-file/create-dir 在目录行下方新建。 */
  const [draft, setDraft] = useState<{ kind: "create-file" | "create-dir" | "rename" } | null>(null);

  const loadChildren = useCallback(async (force = false) => {
    if (loaded && !force) return;
    setLoading(true);
    try {
      const entries = await fetchEntries(node.fullPath, t);
      setChildren(entries);
      setLoaded(true);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [loaded, node.fullPath, t]);

  // Re-fetch children when the tree refreshes and the directory is open.
  useEffect(() => {
    if (open && loaded) {
      loadChildren(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const handleClick = useCallback(() => {
    if (node.isDir) {
      onToggleExpanded(node.fullPath, !open);
    } else {
      onOpenFile(node.fullPath, node.name);
    }
  }, [node.isDir, node.fullPath, node.name, open, onOpenFile, onToggleExpanded]);

  // 展开（含从持久化偏好恢复的展开）时自动加载子目录；加载中重复调用由 loaded 去重。
  useEffect(() => {
    if (open && !loaded) loadChildren();
  }, [open, loaded, loadChildren]);

  // 键盘操作：行聚焦时 Enter/Space 等价点击（目录切换展开、文件打开）。
  // 仅处理行自身按键（e.target === e.currentTarget），行内按钮/下载链接自行响应，不冲突。
  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleClick();
    }
  }, [handleClick]);

  return (
    <div role="none">
      {draft?.kind === "rename" ? (
        <NameDraftRow
          targetPath={node.fullPath}
          type="rename"
          defaultName={node.name}
          placeholder={t("files_namePlaceholder")}
          paddingLeft={8 + depth * 14}
          onDone={(ok) => { setDraft(null); if (ok) onMutated(); }}
          t={t}
        />
      ) : (
      <div
        className="file-row"
        role="treeitem"
        tabIndex={0}
        aria-expanded={node.isDir ? open : undefined}
        aria-selected={false}
        draggable
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onDragStart={(event) => {
          // 拖拽移动：记录源路径；目录行 onDrop 执行 move。
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", node.fullPath);
        }}
        onDragOver={(event) => {
          if (!node.isDir) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          if (!node.isDir) return;
          event.preventDefault();
          setDragOver(false);
          const source = event.dataTransfer.getData("text/plain");
          if (!source || source === node.fullPath) return;
          void (async () => {
            try {
              await postFileOp(source, "move", { targetDirectory: node.fullPath });
              onMutated();
            } catch (error) {
              window.alert(`${t("files_moveFailed")}: ${error instanceof Error ? error.message : String(error)}`);
            }
          })();
        }}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 4,
          paddingLeft: 8 + depth * 14,
          paddingRight: 8,
          height: 24,
          cursor: "pointer",
          userSelect: "none",
          outline: dragOver ? "1px solid var(--accent)" : undefined,
          borderRadius: dragOver ? 5 : undefined,
          background: dragOver ? "var(--bg-selected)" : undefined,
        }}
      >
        {node.isDir && (
          <svg
            width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.1s" }}
          >
            <polyline points="3 2 7 5 3 8" />
          </svg>
        )}
        {!node.isDir && <span style={{ width: 10, flexShrink: 0 }} />}
        <span className="file-row-icon" style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
          {node.isDir ? <FolderIcon size={14} open={open} /> : getFileIcon(node.name, 14)}
        </span>
        <span
          style={{
            fontSize: 12,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
          title={node.fullPath}
        >
          {node.name}
        </span>
        {highlighted && (
          <span
            className="file-row-badge"
            title={t("files_uploaded")}
            aria-label={t("files_uploaded")}
            style={{ width: 6, height: 6, flexShrink: 0, borderRadius: "50%", background: "var(--status-unread)" }}
          />
        )}
        {!node.isDir && gitStatus && (
          <span
            className="file-row-badge"
            title={t(GIT_STATUS_KEYS[gitStatus.status])}
            aria-label={t(GIT_STATUS_KEYS[gitStatus.status])}
            style={{
              width: 14,
              flexShrink: 0,
              color: GIT_STATUS_COLORS[gitStatus.status],
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              fontWeight: 600,
              textAlign: "center",
            }}
          >
            {gitStatus.code}
          </span>
        )}
        {containsGitChanges && (
          <span
            className="file-row-badge"
            title={t("files_containsChanges")}
            aria-label={t("files_containsChanges")}
            style={{
              width: 6,
              height: 6,
              flexShrink: 0,
              borderRadius: "50%",
              background: "var(--status-warning)",
            }}
          />
        )}
        {loading && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
          </svg>
        )}
        {/* 行内操作恒渲染，由 CSS 渐进显露；粗指针恒显（触屏首点可达）。 */}
        <div className="file-row-actions">
          {onAtMention && (
          <button
            type="button"
            className="file-row-action-btn"
            onClick={(e) => {
              e.stopPropagation();
              onAtMention(getRelativeFilePath(node.fullPath, cwd), node.isDir);
            }}
            title={t("files_insertIntoChat", { name: node.name })}
            aria-label={t("files_insertIntoChat", { name: node.name })}
            style={{ color: "var(--accent)" }}
          >
            <MentionIcon />
          </button>
          )}
          <FileRowMenu
            entryPath={node.fullPath}
            name={node.name}
            isDir={node.isDir}
            cwd={cwd}
            onRename={() => setDraft({ kind: "rename" })}
            onCreate={(kind) => setDraft({ kind })}
            onMove={() => onMoveEntry(node.fullPath, node.name)}
            onCopy={() => onCopyEntry(node.fullPath, node.name)}
            onDelete={() => onDeleteEntry(node.fullPath, node.name, node.isDir)}
            t={t}
          />
        </div>
      </div>
      )}
      {/* 目录内新建草稿行：位于目录行之下、子项之前（不依赖展开态，保证输入可见）。 */}
      {draft && draft.kind !== "rename" && (
        <NameDraftRow
          targetPath={node.fullPath}
          type={draft.kind}
          placeholder={t("files_namePlaceholder")}
          paddingLeft={8 + (depth + 1) * 14}
          onDone={(ok) => { setDraft(null); if (ok) onMutated(); }}
          t={t}
        />
      )}
      {node.isDir && open && (
        <div role="group">
          {children.map((child) => (
            <TreeNode
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onAtMention={onAtMention}
              expandedPaths={expandedPaths}
              onToggleExpanded={onToggleExpanded}
              refreshToken={refreshToken}
              highlightedPaths={highlightedPaths}
              gitStatusByPath={gitStatusByPath}
              changedDirectoryPaths={changedDirectoryPaths}
              onMutated={onMutated}
              onMoveEntry={onMoveEntry}
              onCopyEntry={onCopyEntry}
              onDeleteEntry={onDeleteEntry}
              t={t}
            />
          ))}
          {children.length === 0 && loaded && (
            <div style={{ paddingLeft: 8 + (depth + 1) * 14, fontSize: 11, color: "var(--text-dim)", height: 22, display: "flex", alignItems: "center" }}>
              {t("files_noFiles")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const FileExplorer = forwardRef<FileExplorerHandle, Props>(function FileExplorer({
  cwd,
  onOpenFile,
  refreshKey,
  onAtMention,
  onAtMentions,
  onUploadBusyChange,
}, ref) {
  const { t } = useI18n();
  const serverPrefs = useServerPreferences();
  const [configOpen, setConfigOpen] = useState(false);
  const [draftConfig, setDraftConfig] = useState<FileConfig | null>(null);
  const fileConfig = useMemo(() => parseFileConfig(serverPrefs.fileConfig), [serverPrefs.fileConfig]);
  const updateFileConfig = useCallback((patch: Partial<FileConfig>) => {
    setServerPref("fileConfig", { ...fileConfig, ...patch });
  }, [fileConfig]);

  const toggleConfig = useCallback(() => {
    if (configOpen) {
      setConfigOpen(false);
      setDraftConfig(null);
    } else {
      setDraftConfig(fileConfig);
      setConfigOpen(true);
    }
  }, [configOpen, fileConfig]);
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 展开/滚动按 cwd 持久化（lib/ui-preferences.ts）。
  // 初始为空 Set 保证 SSR/CSR 首帧一致；持久化值在 cwd effect（含首挂载）中恢复，
  // 与 AppShell sidebarWidth「挂载后恢复」模式保持一致，避免 hydration mismatch。
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollSaveTimerRef = useRef<number | null>(null);
  /** 最新展开集镜像：cwd 切换兜底保存不引入 expandedPaths 依赖（避免 effect 重跑重抓根目录）。 */
  const expandedPathsRef = useRef(expandedPaths);
  expandedPathsRef.current = expandedPaths;
  /** cwd 切换后待恢复的滚动位置；roots 渲染完成后应用。 */
  const pendingScrollTopRef = useRef<number | null>(null);
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  /** 项目根 cwd 下的内联新建草稿（工具栏触发）。 */
  const [rootCreateKind, setRootCreateKind] = useState<"create-file" | "create-dir" | null>(null);
  const [highlightedPaths, setHighlightedPaths] = useState<Set<string>>(new Set());
  const [gitFiles, setGitFiles] = useState<GitFileStatus[]>([]);
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSummary, setUploadSummary] = useState<UploadSummary | null>(null);
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  const prevCwdRef = useRef<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  /** 上传目标目录：默认项目根，上传前可经目录选择器变更。 */
  const uploadTargetDirRef = useRef<string>(cwd);
  /** 目录选择弹窗：上传目标 / 移动 / 复制共用。 */
  const [picker, setPicker] = useState<{
    mode: "upload" | "move" | "copy";
    sourcePath?: string;
    initialPath: string;
  } | null>(null);
  const refreshToken = `${refreshKey ?? 0}:${treeRefreshKey}`;
  const uploadBusy = uploadPhase !== "idle";

  /** 首屏不抢带宽：文件树/git 请求延迟到浏览器空闲期（降级 250ms）。
   * 会话内容的加载与显示（/api/sessions、/api/home 等）优先完成。 */
  const deferToIdle = useCallback(() => {
    if (typeof requestIdleCallback === "function") {
      return new Promise<void>((resolve) => requestIdleCallback(() => resolve(), { timeout: 800 }));
    }
    return new Promise<void>((resolve) => setTimeout(resolve, 250));
  }, []);
  const gitStatusByPath = useMemo(() => new Map(
    gitFiles.map((status) => [normalizeFilePathSlashes(status.filePath), status]),
  ), [gitFiles]);

  const changedDirectoryPaths = useMemo(() => {
    const directories = new Set<string>();
    const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
    for (const status of gitFiles) {
      let directory = getFileDirectory(normalizeFilePathSlashes(status.filePath));
      while (directory === normalizedCwd || directory.startsWith(`${normalizedCwd}/`)) {
        directories.add(directory);
        if (directory === normalizedCwd) break;
        const parent = getFileDirectory(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    return directories;
  }, [cwd, gitFiles]);

  const persistExplorerState = useCallback((expanded: Set<string>, scrollTop: number) => {
    const state = { expanded: [...expanded], scrollTop };
    saveFileExplorerState(cwd, state);
    // 服务端持久化（跨客户端同步）
    setServerPref(`fileTree.${cwd}`, state);
  }, [cwd]);

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    const next = new Set(expandedPaths);
    if (open) next.add(fullPath); else next.delete(fullPath);
    setExpandedPaths(next);
    persistExplorerState(next, scrollRef.current?.scrollTop ?? 0);
  }, [expandedPaths, persistExplorerState]);

  /** 文件创建/重命名成功后刷新整棵树（递增 treeRefreshKey 触发 roots 与已展开目录重取）。 */
  const handleMutated = useCallback(() => {
    setTreeRefreshKey((key) => key + 1);
  }, []);

  /** 删除文件/目录：二次确认后调用 DELETE /api/files/...。 */
  const handleDeleteEntry = useCallback(async (entryPath: string, name: string) => {
    if (!window.confirm(t("files_deleteConfirm", { name }))) return;
    try {
      const res = await fetch(`/api/files/${encodeFilePathForApi(entryPath)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(data?.error ?? t("files_deleteFailed"));
      }
      handleMutated();
    } catch (error) {
      window.alert(`${t("files_deleteFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [t, handleMutated]);

  /** 滚动位置防抖写回（200ms），避免高频滚动刷 localStorage。 */
  const handleScroll = useCallback(() => {
    if (scrollSaveTimerRef.current !== null) window.clearTimeout(scrollSaveTimerRef.current);
    scrollSaveTimerRef.current = window.setTimeout(() => {
      persistExplorerState(expandedPathsRef.current, scrollRef.current?.scrollTop ?? 0);
    }, 200);
  }, [persistExplorerState]);

  /** roots 渲染完成后应用待恢复的滚动位置。 */
  const restoreScrollAfterPaint = useCallback(() => {
    if (pendingScrollTopRef.current == null) return;
    const target = pendingScrollTopRef.current;
    pendingScrollTopRef.current = null;
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = target;
    });
  }, []);

  const applyUploadResult = useCallback((data: UploadResponse) => {
    const uploaded = data.uploaded ?? [];
    const skipped = data.skipped ?? [];
    const errors = data.errors ?? [];
    setUploadSummary({ uploaded, skipped, errors });

    if (uploaded.length > 0) {
      const targetDir = uploadTargetDirRef.current;
      setHighlightedPaths(new Set(uploaded.map((name) => joinFilePath(targetDir, name))));
      setTreeRefreshKey((key) => key + 1);
    }
  }, []);

  const performUpload = useCallback(async (
    files: File[],
    strategy: UploadConflictStrategy,
  ) => {
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("uploading");

    try {
      const targetDir = uploadTargetDirRef.current;
      const { status, data } = await uploadFiles(targetDir, files, strategy, setUploadProgress, t);
      if (status === 409 && data.conflicts?.length) {
        setPendingConflict({
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }
      if (status < 200 || status >= 300) {
        throw new Error(data.error ?? t("files_uploadFailed", { status }));
      }
      setUploadProgress(100);
      applyUploadResult(data);
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [applyUploadResult, t]);

  const prepareUpload = useCallback(async (files: File[]) => {
    if (files.length === 0 || uploadBusy) return;
    setUploadSummary(null);
    setHighlightedPaths(new Set());
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("checking");

    try {
      const targetDir = uploadTargetDirRef.current;
      const res = await fetch(
        `/api/files/${encodeFilePathForApi(targetDir)}?type=upload-check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileNames: files.map((file) => file.name) }),
        },
      );
      const data = await res.json().catch(() => ({})) as UploadResponse;
      if (!res.ok) throw new Error(data.error ?? t("files_uploadCheckFailed", { status: res.status }));

      if (data.conflicts?.length) {
        setPendingConflict({
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }

      await performUpload(files, "error");
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [performUpload, t, uploadBusy]);

  const handleUploadInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void prepareUpload(files);
  }, [prepareUpload]);

  useImperativeHandle(ref, () => ({
    openUploadPicker() {
      // 上传前先选目标目录（不再固定项目根）。
      if (uploadBusy) return;
      setPicker({ mode: "upload", initialPath: cwd });
    },
    /** 在项目根 cwd 下开始新建文件（内联输入）。 */
    startCreateFile() {
      setRootCreateKind("create-file");
    },
    /** 在项目根 cwd 下开始新建文件夹（内联输入）。 */
    startCreateDir() {
      setRootCreateKind("create-dir");
    },
    toggleConfig() {
      toggleConfig();
    },
  }), [uploadBusy, cwd, toggleConfig]);

  /** 目录选择器确认：上传 → 触发文件选择；移动/复制 → 执行操作。 */
  const handlePickerSelect = useCallback(async (directory: string) => {
    const active = picker;
    setPicker(null);
    if (!active) return;
    if (active.mode === "upload") {
      uploadTargetDirRef.current = directory;
      uploadInputRef.current?.click();
      return;
    }
    if (!active.sourcePath) return;
    try {
      await postFileOp(active.sourcePath, active.mode, { targetDirectory: directory });
      handleMutated();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.alert(`${active.mode === "move" ? t("files_moveFailed") : t("files_copyFailed")}: ${message}`);
    }
  }, [picker, handleMutated, t]);

  /** 移动/复制：打开目录选择器（初始为条目所在目录）。 */
  const openEntryPicker = useCallback((mode: "move" | "copy", entryPath: string) => {
    setPicker({ mode, sourcePath: entryPath, initialPath: getFileDirectory(entryPath) });
  }, []);

  useEffect(() => {
    onUploadBusyChange?.(uploadBusy);
  }, [onUploadBusyChange, uploadBusy]);

  useEffect(() => () => onUploadBusyChange?.(false), [onUploadBusyChange]);

  // 确保服务端偏好已加载（首次挂载异步拉取，cwd 恢复逻辑依赖）
  useEffect(() => {
    void ensureServerPrefsLoaded();
  }, []);

  useEffect(() => {
    const cwdChanged = prevCwdRef.current !== cwd;
    const previousCwd = prevCwdRef.current;
    prevCwdRef.current = cwd;

    if (cwdChanged) {
      // 保存旧 cwd 的展开/滚动（防抖写回可能尚未落盘，此处兜底）；null 为首挂载无旧值。
      if (previousCwd !== null) {
        saveFileExplorerState(previousCwd, {
          expanded: [...expandedPathsRef.current],
          scrollTop: scrollRef.current?.scrollTop ?? 0,
        });
      }
      // 恢复新 cwd 的展开/滚动；滚动在 roots 渲染完成后应用。
      // 服务端为跨客户端权威：先取 server，其次 localStorage。
      let saved = getServerPref<{ expanded: string[]; scrollTop: number }>(`fileTree.${cwd}`);
      if (!saved || !Array.isArray(saved.expanded)) {
        saved = loadSidebarPreferences().fileExplorerState[cwd] ?? { expanded: [], scrollTop: 0 };
      }
      setExpandedPaths(new Set(saved.expanded));
      pendingScrollTopRef.current = saved.scrollTop;
      setHighlightedPaths(new Set());
      setUploadSummary(null);
      setPendingConflict(null);
      setUploadError(null);
      // 新建草稿属于瞬时输入态，cwd 切换时一并清空。
      setRootCreateKind(null);
    }

    setLoading(cwdChanged);
    setError(null);
    let cancelled = false;
    // 首屏延迟到空闲：不与会话内容加载抢占网络/服务器线程。
    void deferToIdle().then(() => {
      if (cancelled) return;
      fetchEntries(cwd, t)
        .then((entries) => {
          if (cancelled) return;
          setRoots(entries);
          restoreScrollAfterPaint();
        })
        .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (!cancelled) setLoading(false); });
    });
    return () => { cancelled = true; };
  }, [cwd, refreshKey, t, treeRefreshKey, deferToIdle, restoreScrollAfterPaint]);

  useEffect(() => {
    let cancelled = false;
    // 首屏延迟到空闲；cwd/refresh 变化时同样延迟一个空闲周期（避免与文件树并发）。
    void deferToIdle().then(() => {
      if (cancelled) return;
      fetchGitStatus(cwd, t)
        .then((status) => {
          if (!cancelled) setGitFiles(status.isGitRepository ? status.files : []);
        })
        .catch(() => {
          if (!cancelled) setGitFiles([]);
        });
    });
    return () => { cancelled = true; };
  }, [cwd, refreshKey, t, treeRefreshKey, deferToIdle]);

  const showUploadFeedback = uploadBusy || pendingConflict !== null || uploadError !== null || uploadSummary !== null;

  const addUploadedFilesToChat = useCallback(() => {
    if (!uploadSummary || uploadSummary.uploaded.length === 0) return;
    onAtMentions?.(
      uploadSummary.uploaded.map((name) => getRelativeFilePath(joinFilePath(cwd, name), cwd)),
    );
  }, [cwd, onAtMentions, uploadSummary]);

  return (
    <div ref={scrollRef} onScroll={handleScroll} style={{ height: "100%", overflowY: "auto", overflowX: "hidden" }}>
      <input ref={uploadInputRef} type="file" multiple hidden onChange={handleUploadInput} />
      {configOpen && draftConfig && (
        <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 10px" }}>
            {([
              ["indexMaxFiles", t("files_configIndexMaxFiles"), 1],
              ["indexGitHardCap", t("files_configGitHardCap"), 1],
              ["indexWalkHardCap", t("files_configWalkHardCap"), 1],
              ["indexMaxWalkDepth", t("files_configMaxWalkDepth"), 1],
              ["atResultLimit", t("files_configAtResultLimit"), 1],
              ["textPreviewMaxBytes", t("files_configTextPreview"), 1024 * 1024],
              ["imagePreviewMaxBytes", t("files_configImagePreview"), 1024 * 1024],
              ["docxPreviewMaxBytes", t("files_configDocxPreview"), 1024 * 1024],
              ["browseMaxEntries", t("files_configBrowseMaxEntries"), 1],
            ] as Array<[keyof FileConfig, string, number]>).map(([key, label, divisor]) => (
              <label key={key} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--text-dim)" }}>
                <span>{label}</span>
                <input
                  type="number"
                  min={1}
                  value={Math.round((draftConfig[key] ?? fileConfig[key]) / divisor)}
                  onChange={(event) => {
                    const raw = Number(event.target.value);
                    if (!Number.isFinite(raw) || raw <= 0) return;
                    setDraftConfig((prev) => ({
                      ...(prev ?? fileConfig),
                      [key]: Math.round(raw * divisor),
                    } as FileConfig));
                  }}
                  style={{ width: 70, height: 20, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)", fontSize: 10, padding: "0 4px" }}
                />
              </label>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
            <button
              type="button"
              onClick={() => {
                setServerPref("fileConfig", draftConfig);
                setConfigOpen(false);
                setDraftConfig(null);
              }}
              style={{ height: 22, padding: "0 10px", border: "1px solid var(--accent)", borderRadius: 4, background: "var(--accent)", color: "#fff", cursor: "pointer", fontSize: 10 }}
            >
              {t("files_configSave")}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfigOpen(false);
                setDraftConfig(null);
              }}
              style={{ height: 22, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--text-muted)", cursor: "pointer", fontSize: 10 }}
            >
              {t("files_configCancel")}
            </button>
            <span style={{ marginLeft: 4, fontSize: 10, color: "var(--text-dim)" }}>
              {t("files_configHint")}
            </span>
          </div>
        </div>
      )}
      {picker && (
        <FileTreePicker
          open
          title={picker.mode === "upload" ? t("files_pickerUploadTitle") : picker.mode === "move" ? t("files_pickerMoveTitle") : t("files_pickerCopyTitle")}
          initialPath={picker.initialPath}
          onSelect={handlePickerSelect}
          onClose={() => setPicker(null)}
        />
      )}
      {showUploadFeedback && (
        <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
        {uploadBusy && (
          <div role="status" aria-live="polite" aria-label={uploadPhase === "checking" ? t("files_loadingList") : `${t("files_uploading")} ${uploadProgress}%`}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: 14, color: "var(--text-muted)" }}>
              {uploadPhase === "checking" ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-5.7-8.4" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 16V4" />
                  <path d="m7 9 5-5 5 5" />
                  <path d="M5 20h14" />
                </svg>
              )}
              {uploadPhase === "uploading" && <span style={{ fontSize: 10 }}>{uploadProgress}%</span>}
            </div>
            {uploadPhase === "uploading" && (
              <div style={{ height: 3, marginTop: 4, overflow: "hidden", borderRadius: 2, background: "var(--border)" }}>
                <div style={{ width: `${uploadProgress}%`, height: "100%", background: "var(--text-muted)", transition: "width 120ms ease" }} />
              </div>
            )}
          </div>
        )}

        {pendingConflict && (
          <div role="alert" style={{ padding: 7, border: "1px solid color-mix(in srgb, var(--status-warning) 55%, var(--border))", borderRadius: 4, background: "color-mix(in srgb, var(--status-warning) 9%, var(--bg-panel))" }}>
            <div style={{ fontSize: 11, color: "var(--text)", lineHeight: 1.35, overflowWrap: "anywhere" }}>
              {t(pendingConflict.conflicts.length === 1 ? "files_existingFilesCount_one" : "files_existingFilesCount", { count: pendingConflict.conflicts.length })}: {pendingConflict.conflicts.join(", ")}
            </div>
            {pendingConflict.nonReplaceable.length > 0 && (
              <div style={{ marginTop: 3, fontSize: 10, color: "var(--status-warning)", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                {t("files_cannotReplace", { names: pendingConflict.nonReplaceable.join(", ") })}
              </div>
            )}
            <div style={{ display: "flex", gap: 5, marginTop: 7 }}>
              <button type="button" onClick={() => void performUpload(pendingConflict.files, "overwrite")} style={{ height: 22, padding: "0 7px", border: "1px solid var(--status-danger)", borderRadius: 4, background: "transparent", color: "var(--status-danger)", cursor: "pointer", fontSize: 10 }}>
                {t("files_replace")}
              </button>
              <button type="button" onClick={() => void performUpload(pendingConflict.files, "skip")} style={{ height: 22, padding: "0 7px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 10 }}>
                {t("files_skip")}
              </button>
              <button type="button" onClick={() => setPendingConflict(null)} style={{ height: 22, padding: "0 7px", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 10 }}>
                {t("files_cancel")}
              </button>
            </div>
          </div>
        )}

        {uploadError && (
          <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 11, lineHeight: 1.35, color: "var(--status-danger)" }}>
            <span style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>{uploadError}</span>
            <DismissButton onClick={() => setUploadError(null)} title={t("files_closeError")} />
          </div>
        )}

        {uploadSummary && (
          <div aria-live="polite">
            <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 22, fontSize: 11 }}>
              <div style={{ minWidth: 0, flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
                {uploadSummary.uploaded.length > 0 && (
                  <span title={t("files_uploadedCount", { count: uploadSummary.uploaded.length })} aria-label={t("files_uploadedCount", { count: uploadSummary.uploaded.length })} style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--status-success)" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m5 12 4 4L19 6" />
                    </svg>
                    <span>{uploadSummary.uploaded.length}</span>
                  </span>
                )}
                {uploadSummary.skipped.length > 0 && (
                  <span title={t("files_skippedCount", { count: uploadSummary.skipped.length })} aria-label={t("files_skippedCount", { count: uploadSummary.skipped.length })} style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--text-dim)" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M8 12h8" />
                    </svg>
                    <span>{uploadSummary.skipped.length}</span>
                  </span>
                )}
                {uploadSummary.errors.length > 0 && (
                  <span title={t("files_failedCount", { count: uploadSummary.errors.length })} aria-label={t("files_failedCount", { count: uploadSummary.errors.length })} style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--status-danger)" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 3 2.5 20h19L12 3Z" />
                      <path d="M12 9v4" />
                      <path d="M12 17h.01" />
                    </svg>
                    <span>{uploadSummary.errors.length}</span>
                  </span>
                )}
              </div>
              {uploadSummary.uploaded.length > 0 && onAtMentions && (
                <button
                  type="button"
                  onClick={addUploadedFilesToChat}
                  title={uploadSummary.uploaded.length === 1 ? t("files_addFileToChat") : t("files_addAllFilesToChat")}
                  aria-label={uploadSummary.uploaded.length === 1 ? t("files_addFileToChat") : t("files_addAllFilesToChat")}
                  className="file-row-action-btn"
                  style={{ color: "var(--accent)" }}
                >
                  <MentionIcon />
                </button>
              )}
              <DismissButton onClick={() => setUploadSummary(null)} title={t("files_closeUploadResults")} />
            </div>
            {uploadSummary.errors.map((item) => (
              <div key={item.name} title={item.error} style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3, minWidth: 0, fontSize: 10, color: "var(--status-danger)" }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v5" />
                  <path d="M12 17h.01" />
                </svg>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
              </div>
            ))}
          </div>
        )}
        </div>
      )}

      <div style={{ padding: "2px 4px" }}>
        {loading ? (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>{t("files_loading")}</div>
        ) : error ? (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--status-danger)" }}>{error}</div>
        ) : (
          <>
            {rootCreateKind && (
              <NameDraftRow
                targetPath={cwd}
                type={rootCreateKind}
                placeholder={t("files_namePlaceholder")}
                paddingLeft={12}
                onDone={(ok) => { setRootCreateKind(null); if (ok) handleMutated(); }}
                t={t}
              />
            )}
            <div role="tree">
              {roots.map((node) => (
                <TreeNode
                  key={node.fullPath}
                  node={node}
                  depth={0}
                  cwd={cwd}
                  onOpenFile={onOpenFile}
                  onAtMention={onAtMention}
                  expandedPaths={expandedPaths}
                  onToggleExpanded={handleToggleExpanded}
                  refreshToken={refreshToken}
                  highlightedPaths={highlightedPaths}
                  gitStatusByPath={gitStatusByPath}
                  changedDirectoryPaths={changedDirectoryPaths}
                  onMutated={handleMutated}
                  onMoveEntry={(path) => openEntryPicker("move", path)}
                  onCopyEntry={(path) => openEntryPicker("copy", path)}
                  onDeleteEntry={(path, name) => void handleDeleteEntry(path, name)}
                  t={t}
                />
              ))}
            </div>
          </>
        )}
        {!loading && !error && roots.length === 0 && (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
            {t("files_noFiles")}
          </div>
        )}
      </div>
    </div>
  );
});
