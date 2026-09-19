"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import {
  browseProjectDirectory,
  createProjectPath,
  validateProjectPath,
  type BrowseEntry,
  type BrowseGitInfo,
} from "@/lib/add-project-client";
import { ViewportDialog } from "../ui/ViewportDialog";
import { DialogButton } from "./display";

export interface AddProjectDialogProps {
  open: boolean;
  onClose: () => void;
  /** 解析 cwd 所属项目根；失败时回退 cwd 本身。 */
  resolveProjectRoot: (cwd: string) => string;
  onAdded: (cwd: string, projectRoot: string) => void;
}

/** 输入去抖：打字过程中不逐字请求目录列表。 */
const AUTO_BROWSE_DEBOUNCE_MS = 250;

/**
 * 添加项目弹窗：
 * - 打开即浏览家目录并写入输入框；输入变化去抖后自动把下面的目录列表切到该路径
 *   （没有「前往」按钮，打字即浏览）
 * - 自动浏览不回写输入框（只有打开时与点击目录项才写），避免与用户正在输入的内容互相覆盖
 * - 路径不存在时界面照常显示，只在列表处给出「目录不存在」提示，不弹窗
 * - 「添加」按输入值校验：路径不存在才弹确认框问是否创建，确认后先建目录再加入项目
 */
export function AddProjectDialog({ open, onClose, resolveProjectRoot, onAdded }: AddProjectDialogProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  /** 当前列出的目录；null = 未列出（不存在/不可读/尚未返回）。 */
  const [listing, setListing] = useState<string | null>(null);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [git, setGit] = useState<BrowseGitInfo | null>(null);
  const [missing, setMissing] = useState(false);
  /** 待确认创建的路径（服务端规范化后的绝对路径）；非 null 时显示创建确认框。 */
  const [createTarget, setCreateTarget] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<null | "validate" | "create">(null);
  const browseGenRef = useRef(0);
  const debounceRef = useRef<number | null>(null);
  /** 由程序写入输入框的值（打开时的家目录、点击目录项）：跳过对应的自动浏览。 */
  const skipAutoBrowseRef = useRef<string | null>(null);

  /** 作废在途浏览响应 + 取消待发的去抖浏览（输入变化/关闭/卸载时调用）。 */
  const cancelPendingBrowse = useCallback(() => {
    browseGenRef.current += 1;
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    cancelPendingBrowse();
    setValue("");
    setError(null);
    setBrowsing(false);
    setListing(null);
    setParentPath(null);
    setEntries([]);
    setGit(null);
    setMissing(false);
    setCreateTarget(null);
    setCreateError(null);
    setSubmitting(null);
    skipAutoBrowseRef.current = null;
  }, [cancelPendingBrowse]);

  useEffect(() => () => cancelPendingBrowse(), [cancelPendingBrowse]);

  /**
   * 浏览目录并用结果更新下面的列表。过期响应（generation 不匹配）直接丢弃，
   * 保证迟到的响应不会覆盖新输入对应的列表。
   */
  const browse = useCallback(async (rawPath: string, applyValue = false) => {
    const gen = ++browseGenRef.current;
    setBrowsing(true);
    // 不存在/不可读：安静清空列表，只留「目录不存在」提示；创建与否等点「添加」再问。
    const listing = await browseProjectDirectory(rawPath);
    if (gen !== browseGenRef.current) return;
    if (!listing.ok) {
      setListing(null);
      setParentPath(null);
      setEntries([]);
      setGit(null);
      setMissing(true);
    } else {
      const resolved = listing.path ?? rawPath;
      if (applyValue) {
        skipAutoBrowseRef.current = resolved;
        setValue(resolved);
      }
      setListing(resolved);
      setParentPath(listing.parentPath);
      setEntries(listing.entries);
      setGit(listing.git);
      setMissing(false);
    }
    setBrowsing(false);
  }, []);

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    void browse("", true);
  }, [open, reset, browse]);

  // 输入变化：立即作废在途请求，去抖后把目录列表切到新路径。
  useEffect(() => {
    if (!open) return;
    const raw = value.trim();
    if (!raw) return;
    if (skipAutoBrowseRef.current !== null && skipAutoBrowseRef.current === raw) {
      skipAutoBrowseRef.current = null;
      return;
    }
    cancelPendingBrowse();
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      void browse(raw);
    }, AUTO_BROWSE_DEBOUNCE_MS);
  }, [open, value, browse, cancelPendingBrowse]);

  /** 点击目录项/上级目录：把输入框切到该路径并立即列出。 */
  const openDirectory = useCallback((path: string) => {
    cancelPendingBrowse();
    void browse(path, true);
  }, [browse, cancelPendingBrowse]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  /** 校验输入值并加入项目；路径不存在时转入创建确认，不直接报错。 */
  const submit = useCallback(async () => {
    const path = value.trim();
    if (!path || submitting !== null) return;
    setSubmitting("validate");
    setError(null);
    try {
      const result = await validateProjectPath(path);
      if (result.kind === "notFound") {
        setCreateError(null);
        setCreateTarget(result.cwd);
        return;
      }
      if (result.kind === "error") {
        setError(result.message);
        return;
      }
      onAdded(result.cwd, resolveProjectRoot(result.cwd));
    } finally {
      setSubmitting(null);
    }
  }, [value, submitting, onAdded, resolveProjectRoot]);

  /** 确认创建：先建目录再加入项目；失败保留确认框，错误可读可重试。 */
  const confirmCreate = useCallback(async () => {
    const path = createTarget;
    if (!path || submitting !== null) return;
    setSubmitting("create");
    setCreateError(null);
    try {
      const result = await createProjectPath(path);
      if (!result.ok) {
        setCreateError(result.message);
        return;
      }
      setCreateTarget(null);
      onAdded(result.cwd, resolveProjectRoot(result.cwd));
    } finally {
      setSubmitting(null);
    }
  }, [createTarget, submitting, onAdded, resolveProjectRoot]);

  return (
    <>
    <ViewportDialog
      open={open}
      onClose={handleClose}
      title={t("sidebar_addProjectDialog")}
      width={440}
      closeLabel={t("dialog_close")}
      initialFocusRef={inputRef}
      actions={
        <>
          <DialogButton onClick={handleClose}>{t("sidebar_cancel")}</DialogButton>
          <DialogButton
            primary
            disabled={submitting !== null || !value.trim()}
            onClick={() => void submit()}
          >
            {submitting === "validate" ? t("sidebar_validating") : t("sidebar_add")}
          </DialogButton>
        </>
      }
    >
      <div>
        <label
          htmlFor="add-project-path"
          style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}
        >
          {t("sidebar_projectPath")}
        </label>
        <input
          id="add-project-path"
          ref={inputRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
            skipAutoBrowseRef.current = null;
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && submitting === null) {
              e.preventDefault();
              handleClose();
            }
          }}
          placeholder="/path/to/project"
          aria-label={t("sidebar_projectPath")}
          autoComplete="off"
          spellCheck={false}
          style={{
            width: "100%",
            height: 32,
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            padding: "0 10px",
            border: "1px solid var(--border)",
            borderRadius: 7,
            outline: "none",
            background: "var(--bg-panel)",
            color: "var(--text)",
            boxSizing: "border-box",
          }}
        />
        <div style={{ marginTop: 10 }}>
          {browsing && !listing && (
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar_browseLoading")}</div>
          )}
          {!browsing && missing && (
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar_browseMissing")}</div>
          )}
          {!missing && git && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11,
                marginBottom: 6,
                color: git.isRepo ? "var(--text-muted)" : "var(--text-dim)",
              }}
            >
              {git.isRepo ? (
                <>
                  <span style={{ color: "var(--accent)", fontWeight: 600 }}>{t("sidebar_browseGitRepo")}</span>
                  {git.branch && (
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}>{git.branch}</span>
                  )}
                </>
              ) : (
                <span>{t("sidebar_browseNotGit")}</span>
              )}
            </div>
          )}
          {listing && (
            <div
              style={{
                maxHeight: 150,
                overflowY: "auto",
                overflowX: "hidden",
                border: "1px solid var(--border)",
                borderRadius: 7,
                background: "var(--bg-panel)",
                padding: 4,
              }}
            >
              {parentPath && (
                <button
                  type="button"
                  disabled={browsing}
                  onClick={() => openDirectory(parentPath)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    width: "100%",
                    padding: "4px 8px",
                    border: "none",
                    background: "transparent",
                    color: "var(--text-muted)",
                    fontSize: 12,
                    cursor: "pointer",
                    borderRadius: 5,
                    fontFamily: "var(--font-mono)",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  ..
                </button>
              )}
              {entries.length === 0 ? (
                <div style={{ padding: "6px 8px", fontSize: 11, color: "var(--text-dim)" }}>
                  {t("sidebar_browseEmpty")}
                </div>
              ) : (
                entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    disabled={browsing}
                    onClick={() => openDirectory(entry.path)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      width: "100%",
                      padding: "4px 8px",
                      border: "none",
                      background: "transparent",
                      color: "var(--text)",
                      fontSize: 12,
                      cursor: "pointer",
                      borderRadius: 5,
                      textAlign: "left",
                      fontFamily: "var(--font-mono)",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <span style={{ color: "var(--text-dim)", fontSize: 10.5 }}>▸</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {entry.name}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        {error && (
          <div role="alert" style={{ marginTop: 8, color: "var(--status-danger)", fontSize: 12, lineHeight: 1.45, overflowWrap: "anywhere" }}>
            {error}
          </div>
        )}
      </div>
    </ViewportDialog>

    {/* 路径不存在 → 添加时才弹的创建确认（否 = 回到添加项目页） */}
    <ViewportDialog
      open={createTarget !== null}
      onClose={() => {
        setCreateTarget(null);
        setCreateError(null);
      }}
      title={t("sidebar_createPathTitle")}
      width={400}
      zIndex={1100}
      closeLabel={t("dialog_close")}
      actions={
        <>
          <DialogButton
            onClick={() => {
              setCreateTarget(null);
              setCreateError(null);
            }}
          >
            {t("sidebar_cancel")}
          </DialogButton>
          <DialogButton primary disabled={submitting !== null} onClick={() => void confirmCreate()}>
            {submitting === "create" ? t("sidebar_creatingPath") : t("sidebar_createPathAction")}
          </DialogButton>
        </>
      }
    >
      <div style={{ fontSize: 12.5, color: "var(--text)", lineHeight: 1.5, overflowWrap: "anywhere" }}>
        {t("sidebar_createPathPrompt", { path: createTarget ?? "" })}
      </div>
      {createTarget && (
        <div style={{ marginTop: 6, fontSize: 11.5, fontFamily: "var(--font-mono)", color: "var(--text-muted)", overflowWrap: "anywhere" }}>
          {createTarget}
        </div>
      )}
      {createError && (
        <div role="alert" style={{ marginTop: 8, color: "var(--status-danger)", fontSize: 12, lineHeight: 1.45, overflowWrap: "anywhere" }}>
          {createError}
        </div>
      )}
    </ViewportDialog>
    </>
  );
}
