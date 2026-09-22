"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { browseProjectDirectory, type BrowseEntry } from "@/lib/add-project-client";
import { saveFileAs } from "@/lib/file-save-as";
import { ViewportDialog } from "./ui/ViewportDialog";
import { DialogButton } from "./session-sidebar/display";

export interface SaveAsDialogProps {
  open: boolean;
  /** 要复制一份的源文件（服务端绝对路径）；原文件保留在原位。 */
  sourcePath: string;
  onClose: () => void;
}

/** 输入去抖：打字过程中不逐字请求目录列表（与添加项目弹窗同一口径）。 */
const AUTO_BROWSE_DEBOUNCE_MS = 250;

/**
 * 「另存为」弹窗：选一个目录，把源文件复制一份进去。
 *
 * - 打开即浏览家目录（服务端缺省口径），把解析出的绝对路径写进输入框
 * - 输入变化去抖后自动切列表；点目录项进下一级，`..` 回上一级
 * - 保存 = 服务端复制（同名自动加 ` (n)`，不覆盖），成功后原地显示落盘路径，
 *   可以继续换目录再存一份；原文件始终留在原位置
 */
export function SaveAsDialog({ open, sourcePath, onClose }: SaveAsDialogProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [listingMissing, setListingMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 正在浏览的目录 ≠ 输入框内容时（打字中）不回写输入框，避免互相覆盖。 */
  const skipInputSyncRef = useRef(false);

  const browse = useCallback(async (target: string) => {
    const listing = await browseProjectDirectory(target);
    if (!listing.ok) {
      setListingMissing(true);
      setEntries([]);
      setParentPath(null);
      return;
    }
    setListingMissing(false);
    if (listing.path) {
      setDirectory(listing.path);
      if (!skipInputSyncRef.current) skipInputSyncRef.current = false;
    }
    setEntries(listing.entries);
    setParentPath(listing.parentPath);
  }, []);

  useEffect(() => {
    if (!open) return;
    setSavedPath(null);
    setError(null);
    skipInputSyncRef.current = false;
    // "~" = 服务端缺省口径（家目录），与添加项目弹窗一致
    void browse("~");
  }, [open, browse]);

  // 输入变化 → 去抖后跟着切列表（不打「前往」按钮）。
  useEffect(() => {
    if (!open || skipInputSyncRef.current) return;
    const value = directory.trim();
    if (!value) return;
    const timer = setTimeout(() => void browse(value), AUTO_BROWSE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, directory, browse]);

  const openDirectory = useCallback((path: string) => {
    skipInputSyncRef.current = true;
    setDirectory(path);
    setSavedPath(null);
    setError(null);
    void browse(path);
  }, [browse]);

  const submit = useCallback(async () => {
    const target = directory.trim();
    if (!target || saving) return;
    setSaving(true);
    setError(null);
    const result = await saveFileAs({ path: sourcePath, targetDirectory: target });
    setSaving(false);
    if (!result.ok) {
      setSavedPath(null);
      setError(result.message);
      return;
    }
    setSavedPath(result.path);
    // 再存一份时序号往后走（同名不覆盖），所以重新列一次目录。
    void browse(target);
  }, [directory, saving, sourcePath, browse]);

  return (
    <ViewportDialog
      open={open}
      onClose={onClose}
      title={t("saveAs_title")}
      width={480}
      closeLabel={t("dialog_close")}
      initialFocusRef={inputRef}
      actions={
        <>
          <DialogButton onClick={onClose}>{t("sidebar_cancel")}</DialogButton>
          <DialogButton primary disabled={saving || !directory.trim()} onClick={() => void submit()}>
            {saving ? t("saveAs_saving") : t("saveAs_save")}
          </DialogButton>
        </>
      }
    >
      <div>
        <label
          htmlFor="save-as-directory"
          style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}
        >
          {t("saveAs_directory")}
        </label>
        <input
          id="save-as-directory"
          ref={inputRef}
          value={directory}
          onChange={(e) => { setDirectory(e.target.value); setError(null); setSavedPath(null); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !saving) { e.preventDefault(); void submit(); } }}
          placeholder="~"
          spellCheck={false}
          style={{
            width: "100%",
            boxSizing: "border-box",
            height: 32,
            padding: "0 10px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
          }}
        />
        <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-dim)" }}>{t("saveAs_hint")}</div>

        <div
          className="save-as-browse"
          style={{
            marginTop: 10,
            maxHeight: 220,
            overflowY: "auto",
            border: "1px solid var(--border)",
            borderRadius: 6,
          }}
        >
          {parentPath ? (
            <button
              type="button"
              onClick={() => openDirectory(parentPath)}
              style={{
                display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "4px 8px",
                border: "none", background: "transparent", color: "var(--text-muted)", fontSize: 12,
                cursor: "pointer", borderRadius: 5, fontFamily: "var(--font-mono)",
              }}
            >
              ..
            </button>
          ) : null}
          {listingMissing ? (
            <div style={{ padding: "6px 8px", fontSize: 11, color: "var(--text-dim)" }}>
              {t("sidebar_browseMissing")}
            </div>
          ) : entries.length === 0 ? (
            <div style={{ padding: "6px 8px", fontSize: 11, color: "var(--text-dim)" }}>
              {t("sidebar_browseEmpty")}
            </div>
          ) : (
            entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                onClick={() => openDirectory(entry.path)}
                style={{
                  display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "4px 8px",
                  border: "none", background: "transparent", color: "var(--text)", fontSize: 12,
                  cursor: "pointer", borderRadius: 5, textAlign: "left",
                }}
              >
                <span aria-hidden="true" style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>›</span>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
              </button>
            ))
          )}
        </div>

        {savedPath ? (
          <div role="status" style={{ marginTop: 10, fontSize: 12, color: "var(--status-running)", overflowWrap: "anywhere" }}>
            {t("saveAs_savedTo", { path: savedPath })}
          </div>
        ) : null}
        {error ? (
          <div role="alert" style={{ marginTop: 10, fontSize: 12, color: "var(--status-danger)", overflowWrap: "anywhere" }}>
            {error}
          </div>
        ) : null}
      </div>
    </ViewportDialog>
  );
}
