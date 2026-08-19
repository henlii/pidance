"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { ViewportDialog } from "../ui/ViewportDialog";
import { DialogButton, HomeIcon } from "./display";

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

export interface AddProjectDialogProps {
  open: boolean;
  onClose: () => void;
  /** 解析 cwd 所属项目根；失败时回退 cwd 本身。 */
  resolveProjectRoot: (cwd: string) => string;
  onAdded: (cwd: string, projectRoot: string) => void;
}

/**
 * 添加项目弹窗：对齐上游 directory-picker。
 * 打开即浏览 home；Go/Enter 只浏览；Select 只提交已浏览路径。
 */
export function AddProjectDialog({ open, onClose, resolveProjectRoot, onAdded }: AddProjectDialogProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [entries, setEntries] = useState<Array<{ name: string; path: string }>>([]);
  const [git, setGit] = useState<{ isRepo: boolean; branch: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState(false);
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [desktopPickerAvailable, setDesktopPickerAvailable] = useState(false);
  const browseGenRef = useRef(0);

  useEffect(() => {
    setDesktopPickerAvailable(typeof window !== "undefined" && Boolean(window.piDesktop?.selectDirectory));
  }, []);

  const reset = useCallback(() => {
    setValue("");
    setError(null);
    setValidating(false);
    setEntries([]);
    setGit(null);
    setLoading(false);
    setMissing(false);
    setBrowsePath(null);
    setParentPath(null);
  }, []);

  const browseDirectory = useCallback(async (rawPath: string) => {
    const gen = ++browseGenRef.current;
    setLoading(true);
    setMissing(false);
    setError(null);
    try {
      const res = await fetch(`/api/cwd/browse?path=${encodeURIComponent(rawPath)}`);
      if (gen !== browseGenRef.current) return;
      if (!res.ok) {
        setEntries([]);
        setGit(null);
        setMissing(true);
        setBrowsePath(null);
        setParentPath(null);
        return;
      }
      const data = (await res.json()) as {
        path?: string;
        parentPath?: string | null;
        entries?: Array<{ name: string; path: string }>;
        git?: { isRepo: boolean; branch: string | null };
      };
      if (gen !== browseGenRef.current) return;
      setValue(data.path ?? rawPath);
      setBrowsePath(data.path ?? rawPath);
      setParentPath(data.parentPath ?? null);
      setEntries(data.entries ?? []);
      setGit(data.git ?? null);
      setMissing(false);
    } catch {
      if (gen !== browseGenRef.current) return;
      setEntries([]);
      setGit(null);
      setMissing(true);
      setBrowsePath(null);
      setParentPath(null);
    } finally {
      if (gen === browseGenRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    void browseDirectory("");
  }, [open, reset, browseDirectory]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const commit = useCallback(async (candidate?: string) => {
    const path = (candidate ?? browsePath ?? value).trim();
    if (!path || validating) return;
    setValidating(true);
    setError(null);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await res.json().catch(() => ({})) as { cwd?: string; error?: string };
      if (!res.ok || data.error) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      const resolvedCwd = data.cwd ?? path;
      onAdded(resolvedCwd, resolveProjectRoot(resolvedCwd));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setValidating(false);
    }
  }, [browsePath, value, validating, onAdded, resolveProjectRoot]);

  const handlePickDirectory = useCallback(async () => {
    const desktop = window.piDesktop;
    if (!desktop) return;
    try {
      setError(null);
      const path = await desktop.selectDirectory();
      if (path !== null) {
        setValue(path);
        void browseDirectory(path);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [browseDirectory]);

  const handleDefaultCwd = useCallback(async () => {
    if (validating) return;
    setValidating(true);
    setError(null);
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = await res.json().catch(() => ({})) as { cwd?: string; error?: string };
      if (!res.ok || data.error || !data.cwd) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      onAdded(data.cwd, resolveProjectRoot(data.cwd));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setValidating(false);
    }
  }, [validating, onAdded, resolveProjectRoot]);

  const canSelect = Boolean(browsePath && value.trim() === browsePath);

  return (
    <ViewportDialog
      open={open}
      onClose={handleClose}
      title={t("sidebar_addProjectDialog")}
      width={440}
      closeLabel={t("dialog_close")}
      initialFocusRef={inputRef}
      description={t("sidebar_addProjectDescription")}
      actions={
        <>
          <DialogButton onClick={handleClose}>{t("sidebar_cancel")}</DialogButton>
          <span title={!canSelect ? t("sidebar_browseOpenBeforeSelect") : undefined}>
            <DialogButton
              primary
              disabled={validating || !canSelect}
              onClick={() => void commit()}
            >
              {validating ? t("sidebar_validating") : t("sidebar_add")}
            </DialogButton>
          </span>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const raw = value.trim();
          if (!raw || raw === browsePath) return;
          void browseDirectory(raw);
        }}
      >
        <label
          htmlFor="add-project-path"
          style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}
        >
          {t("sidebar_projectPath")}
        </label>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            id="add-project-path"
            ref={inputRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !validating) {
                e.preventDefault();
                handleClose();
              }
            }}
            placeholder="/path/to/project"
            aria-label={t("sidebar_projectPath")}
            autoComplete="off"
            spellCheck={false}
            style={{
              flex: 1,
              minWidth: 0,
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
          <DialogButton
            disabled={loading || !value.trim()}
            onClick={() => void browseDirectory(value.trim())}
          >
            {loading ? t("sidebar_browseLoading") : t("sidebar_browseGo")}
          </DialogButton>
          {desktopPickerAvailable && (
            <DialogButton onClick={() => void handlePickDirectory()}>
              {t("sidebar_selectDirectory")}
            </DialogButton>
          )}
        </div>
        {browsePath && (
          <div style={{ marginTop: 10 }}>
            {loading && (
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar_browseLoading")}</div>
            )}
            {!loading && missing && (
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar_browseMissing")}</div>
            )}
            {!loading && !missing && git && (
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
            {!loading && !missing && (
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
                    disabled={loading}
                    onClick={() => { void browseDirectory(parentPath); }}
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
                      disabled={loading}
                      onClick={() => { void browseDirectory(entry.path); }}
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
        )}
        {error && (
          <div role="alert" style={{ marginTop: 8, color: "var(--status-danger)", fontSize: 12, lineHeight: 1.45, overflowWrap: "anywhere" }}>
            {error}
          </div>
        )}
        <div style={{
          marginTop: 14,
          paddingTop: 12,
          borderTop: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}>
          <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>{t("sidebar_noExistingDirectory")}</span>
          <DialogButton disabled={validating} onClick={() => void handleDefaultCwd()}>
            <HomeIcon size={13} />
            {t("sidebar_createDefaultDirectory")}
          </DialogButton>
        </div>
      </form>
    </ViewportDialog>
  );
}
