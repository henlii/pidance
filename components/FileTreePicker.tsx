"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { ViewportDialog } from "./ui/ViewportDialog";

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

type BrowseEntry = { name: string; path: string };

/**
 * 目录选择弹窗（上传目标 / 移动 / 复制目标共用）。
 * 基于 /api/cwd/browse 浏览允许根内的目录；「选择此目录」提交当前浏览路径。
 */
export function FileTreePicker({
  open,
  title,
  initialPath,
  onSelect,
  onClose,
}: {
  open: boolean;
  title: string;
  initialPath: string | null;
  onSelect: (directory: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [browsePath, setBrowsePath] = useState<string | null>(initialPath);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const genRef = useRef(0);

  const browse = useCallback((rawPath: string) => {
    const gen = ++genRef.current;
    setLoading(true);
    setError(null);
    void fetch(`/api/cwd/browse?path=${encodeURIComponent(rawPath)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({})) as {
          path?: string; parentPath?: string | null;
          entries?: BrowseEntry[]; error?: string;
        };
        if (gen !== genRef.current) return;
        if (!res.ok) {
          setError(data.error ?? `HTTP ${res.status}`);
          return;
        }
        setBrowsePath(data.path ?? rawPath);
        setParentPath(data.parentPath ?? null);
        setEntries(data.entries ?? []);
      })
      .catch(() => {
        if (gen !== genRef.current) return;
        setError(t("files_pickerBrowseFailed"));
      })
      .finally(() => {
        if (gen === genRef.current) setLoading(false);
      });
  }, [t]);

  useEffect(() => {
    if (!open) return;
    setBrowsePath(initialPath);
    if (initialPath) browse(initialPath);
    else setEntries([]);
  }, [open, initialPath, browse]);

  return (
    <ViewportDialog open={open} onClose={onClose} title={title} width={440} closeLabel={t("dialog_close")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 260 }}>
        <div
          style={{
            padding: "6px 9px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg)",
            color: "var(--text-muted)",
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            overflowWrap: "anywhere",
          }}
        >
          {browsePath ?? "…"}
        </div>
        {error && (
          <div style={{ fontSize: 12, color: "var(--status-danger)" }}>{error}</div>
        )}
        <div
          role="list"
          aria-label={t("files_pickerDirectories")}
          style={{
            flex: 1,
            minHeight: 180,
            maxHeight: 300,
            overflowY: "auto",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-panel)",
            padding: 4,
          }}
        >
          {parentPath && (
            <button
              type="button"
              role="listitem"
              onClick={() => browse(parentPath)}
              style={entryButtonStyle}
            >
              <span aria-hidden="true" style={{ width: 16, color: "var(--text-dim)" }}>↰</span>
              {t("files_pickerUp")}
            </button>
          )}
          {loading && entries.length === 0 && (
            <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-dim)" }}>
              {t("common_loading")}
            </div>
          )}
          {!loading && entries.length === 0 && (
            <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-dim)" }}>
              {t("files_pickerEmpty")}
            </div>
          )}
          {entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              role="listitem"
              onClick={() => browse(entry.path)}
              style={entryButtonStyle}
              title={entry.path}
            >
              <span aria-hidden="true" style={{ width: 16, color: "var(--accent)" }}>📁</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
            </button>
          ))}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          <button
            type="button"
            disabled={!browsePath}
            onClick={() => browsePath && onSelect(browsePath)}
            style={{
              minHeight: 32,
              padding: "0 14px",
              borderRadius: 7,
              border: "1px solid var(--accent)",
              background: "var(--accent)",
              color: "var(--accent-foreground)",
              fontSize: 12,
              fontWeight: 600,
              cursor: browsePath ? "pointer" : "not-allowed",
              opacity: browsePath ? 1 : 0.5,
            }}
          >
            {t("files_pickerSelect")}
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{
              minHeight: 32,
              padding: "0 14px",
              borderRadius: 7,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              fontSize: 12,
            }}
          >
            {t("extension_cancel")}
          </button>
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)" }}>
            {t("files_pickerHint")}
          </span>
        </div>
      </div>
    </ViewportDialog>
  );
}

const entryButtonStyle: React.CSSProperties = {
  display: "flex",
  width: "100%",
  alignItems: "center",
  gap: 6,
  minHeight: 30,
  padding: "4px 8px",
  border: "none",
  borderRadius: 5,
  background: "transparent",
  color: "var(--text)",
  fontSize: 12,
  textAlign: "left",
  cursor: "pointer",
};
