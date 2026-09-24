"use client";

import { useEffect, useState, useRef, useCallback, type CSSProperties, type Dispatch, type KeyboardEvent, type MouseEvent } from "react";
import {
  Prism as SyntaxHighlighter,
  createElement as renderSyntaxNode,
  type SyntaxHighlighterProps,
} from "react-syntax-highlighter";
import { vs } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";
import ReactMarkdown from "react-markdown";
import { useTheme } from "@/hooks/useTheme";
import {
  DOCX_PREVIEW_MAX_BYTES,
  getFileExt,
  isAudioPath,
  isDocumentPreviewPath,
  isImagePath,
  isVideoPath,
} from "@/lib/file-types";
import { createLatestRequestGuard, type LatestRequestGuard } from "@/lib/latest-request";
import { encodeFilePathForApi, getFileDirectory, getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { resolveLocalFileHref } from "@/lib/file-links";
import { markdownPreviewRehypePlugins, markdownPreviewRemarkPlugins } from "@/lib/markdown";
import { parseUnifiedPatch } from "@/lib/patch";
import type { GitFileDiffResponse } from "@/lib/git-types";
import { affectedPathsMatchFile } from "@/lib/git-refresh";
import { canRedo, canUndo, type FileBuffer, type FileEditorAction } from "@/lib/file-editor-state";
import { closeTrackedEventSource, trackLiveEventSource } from "@/lib/live-event-sources";
import { useLiveStreamRestoreNonce } from "@/hooks/useLiveStreamRestoreNonce";
import { useI18n } from "@/lib/i18n";

interface Props {
  filePath: string;
  cwd?: string;
  sourceSessionId?: string | null;
  writable?: boolean;
  buffer?: FileBuffer;
  dispatchBuffer?: Dispatch<FileEditorAction>;
  onSave?: () => Promise<boolean>;
  onOpenFile?: (filePath: string) => void;
  /** 受影响文件路径集合：命中当前文件时定向重抓该文件 diff（SSE watch 的兜底）。 */
  gitAffectedPaths?: string[] | null;
}

interface FileData {
  content: string;
  language: string;
  size: number;
  mtimeMs: number;
}

type DisplayMode = "source" | "preview" | "diff";

const DISPLAY_MODE_KEYS = { source: "viewer_source", preview: "viewer_preview", diff: "viewer_diff" } as const;

const FILE_CODE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  lineHeight: 1.6,
};

const FILE_LINE_NUMBER_STYLE: CSSProperties = {
  width: 48,
  minWidth: 48,
  padding: "0 10px",
  textAlign: "right",
  color: "var(--text-dim)",
  background: "var(--bg-panel)",
  borderRight: "1px solid var(--border)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontStyle: "normal",
  fontVariantNumeric: "tabular-nums",
  lineHeight: "20.8px",
  userSelect: "none",
  flexShrink: 0,
  verticalAlign: "top",
};

type SourceCodeRendererProps = Parameters<NonNullable<SyntaxHighlighterProps["renderer"]>>[0] & {
  wrapLines: boolean;
};

function SourceCodeRenderer({ rows, stylesheet, useInlineStyles, wrapLines }: SourceCodeRendererProps) {
  return rows.map((row, lineIndex) => {
    const children = row.children ?? [];
    const firstChildClasses = children[0]?.properties?.className;
    const hasLineNumber = Array.isArray(firstChildClasses)
      && firstChildClasses.includes("react-syntax-highlighter-line-number");
    const lineNumberNode = hasLineNumber ? children[0] : null;
    const contentNodes = hasLineNumber ? children.slice(1) : children;

    return (
      <span
        className="file-source-line"
        key={`source-line-${lineIndex}`}
        style={{ display: "flex", minWidth: "100%" }}
      >
        {lineNumberNode && renderSyntaxNode({
          node: lineNumberNode,
          stylesheet,
          useInlineStyles,
          key: `source-line-number-${lineIndex}`,
        })}
        <span
          className="file-source-line-content"
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            overflowWrap: wrapLines ? "anywhere" : "normal",
            whiteSpace: wrapLines ? "pre-wrap" : "pre",
          }}
        >
          {contentNodes.map((node, tokenIndex) => renderSyntaxNode({
            node,
            stylesheet,
            useInlineStyles,
            key: `source-token-${lineIndex}-${tokenIndex}`,
          }))}
        </span>
      </span>
    );
  });
}

function getFileApiUrl(
  filePath: string,
  type: "read" | "download" | "meta" | "preview" | "watch",
  sourceSessionId?: string | null,
  params: Record<string, string | number | undefined> = {},
): string {
  const encoded = encodeFilePathForApi(filePath);
  const searchParams = new URLSearchParams({ type });
  if (sourceSessionId) searchParams.set("sessionId", sourceSessionId);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, String(value));
  }
  return `/api/files/${encoded}?${searchParams.toString()}`;
}

function DownloadLink({ filePath, sourceSessionId }: { filePath: string; sourceSessionId?: string | null }) {
  const { t } = useI18n();
  return (
    <a
      href={getFileApiUrl(filePath, "download", sourceSessionId)}
      download={getFileName(filePath)}
      title={t("viewer_download")}
      aria-label={t("viewer_download")}
      className="file-viewer-icon-button"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </a>
  );
}

type DiffLine = {
  type: "unchanged" | "removed" | "added";
  text: string;
  oldLineNo: number | null;
  newLineNo: number | null;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function diffLines(patch: string): DiffLine[] {
  const files = parseUnifiedPatch(patch);
  if (!files) return [];

  return files.flatMap((file) => file.rows.flatMap((row): DiffLine[] => {
    if (row.type === "hunk") return [];
    if (row.left.type === "context" && row.right.type === "context") {
      return [{
        type: "unchanged",
        text: row.right.text,
        oldLineNo: row.left.lineNo,
        newLineNo: row.right.lineNo,
      }];
    }

    const lines: DiffLine[] = [];
    if (row.left.type === "removed") {
      lines.push({
        type: "removed",
        text: row.left.text,
        oldLineNo: row.left.lineNo,
        newLineNo: null,
      });
    }
    if (row.right.type === "added") {
      lines.push({
        type: "added",
        text: row.right.text,
        oldLineNo: null,
        newLineNo: row.right.lineNo,
      });
    }
    return lines;
  }));
}

export function GitDiffView({ patch }: { patch: string }) {
  const { t } = useI18n();
  const diff = diffLines(patch);

  const hasChanges = diff.some((l) => l.type !== "unchanged");
  if (!hasChanges) {
    return (
      <div style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
        {t("viewer_noChanges")}
      </div>
    );
  }

  // Render with context: show 3 lines around each change, collapse the rest
  const CONTEXT = 3;
  const changed = new Set(diff.flatMap((l, i) => (l.type !== "unchanged" ? [i] : [])));
  const visible = new Set<number>();
  for (const ci of changed) {
    for (let j = Math.max(0, ci - CONTEXT); j <= Math.min(diff.length - 1, ci + CONTEXT); j++) {
      visible.add(j);
    }
  }

  const segments: Array<{ hidden: true; count: number } | { hidden: false; lines: DiffLine[] }> = [];
  let i = 0;
  while (i < diff.length) {
    if (visible.has(i)) {
      const block: DiffLine[] = [];
      while (i < diff.length && visible.has(i)) {
        block.push(diff[i]);
        i++;
      }
      segments.push({ hidden: false, lines: block });
    } else {
      let count = 0;
      while (i < diff.length && !visible.has(i)) {
        count++;
        i++;
      }
      segments.push({ hidden: true, count });
    }
  }

  return (
    <div
      className="file-diff-view"
      style={{
        width: "max-content",
        minWidth: "100%",
        ...FILE_CODE_STYLE,
      }}
    >
      {segments.map((seg, si) => {
        if (seg.hidden) {
          const result = (
            <div
              key={si}
              style={{
                padding: "2px 16px",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                fontSize: 11,
                borderTop: "1px solid var(--border)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              ... {seg.count} unchanged lines ...
            </div>
          );
          return result;
        }
        const lines = seg.lines.map((line, li) => {
          const bg =
            line.type === "added"
              ? "var(--diff-added-bg)"
              : line.type === "removed"
              ? "var(--diff-removed-bg)"
              : "transparent";
          const prefix =
            line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
          const prefixColor =
            line.type === "added" ? "var(--diff-added-text)" : line.type === "removed" ? "var(--diff-removed-text)" : "var(--text-dim)";

          return (
            <div
              key={li}
              className="file-diff-line"
              style={{
                display: "flex",
                minWidth: "100%",
                background: bg,
                borderLeft: line.type === "added"
                  ? "3px solid var(--diff-added-border)"
                  : line.type === "removed"
                  ? "3px solid var(--diff-removed-border)"
                  : "3px solid transparent",
              }}
            >
              <span
                style={FILE_LINE_NUMBER_STYLE}
              >
                {line.type === "removed" ? line.oldLineNo : line.newLineNo}
              </span>
              <span
                style={{
                  minWidth: 16,
                  padding: "0 6px",
                  color: prefixColor,
                  userSelect: "none",
                  flexShrink: 0,
                  fontWeight: 600,
                }}
              >
                {prefix}
              </span>
              <span
                className="file-diff-line-content"
                style={{
                  flexShrink: 0,
                  padding: "0 8px 0 0",
                  whiteSpace: "pre",
                  color: "var(--text)",
                }}
              >
                {line.text || "\u00a0"}
              </span>
            </div>
          );
        });
        return <div key={si}>{lines}</div>;
      })}
    </div>
  );
}

function ImageViewer({ filePath, cwd, sourceSessionId }: Props) {
  const { t } = useI18n();
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  // bfcache 恢复：文档回来时 +1，让下面的 watch effect 重建连接（#91）。
  const restoreNonce = useLiveStreamRestoreNonce();

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    setSize(null);
    setNaturalSize(null);
    setError(null);
    setWatching(false);

    if (esRef.current) {
      closeTrackedEventSource(esRef.current);
      esRef.current = null;
    }

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;
    // 登记到 live-event-sources：pagehide 时集中让出同源连接（#91）。
    trackLiveEventSource(es);

    es.addEventListener("connected", () => setWatching(true));
    es.addEventListener("change", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      setBust((b) => b + 1);
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);

    return () => {
      closeTrackedEventSource(es);
      esRef.current = null;
    };
  }, [filePath, sourceSessionId, restoreNonce]);

  const src = getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined);

  const formatSizeStr = size != null ? formatSize(size) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span style={{ marginLeft: "auto" }}>{ext || "image"}</span>
        {naturalSize && <span>{naturalSize.w} × {naturalSize.h}</span>}
        {formatSizeStr && <span>{formatSizeStr}</span>}
        <span
          title={watching ? t("viewer_liveSyncOn") : t("viewer_liveSyncOff")}
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "var(--status-success)" : "var(--text-dim)" }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "var(--status-success)" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "var(--live-indicator-glow)" : "none",
            }}
          />
          {watching ? t("viewer_live") : t("viewer_static")}
        </span>
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>
      <div
        style={{
          flex: 1,
          overflow: "auto",
          background: "var(--bg-panel)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          backgroundImage:
            "linear-gradient(45deg, var(--bg) 25%, transparent 25%), linear-gradient(-45deg, var(--bg) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--bg) 75%), linear-gradient(-45deg, transparent 75%, var(--bg) 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
        }}
      >
        {error ? (
          <div style={{ color: "var(--error-text)", fontSize: 13 }}>{error}</div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={filePath}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            onError={() => setError(t("viewer_loadFailed"))}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
              boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            }}
          />
        )}
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  const totalSeconds = Math.round(seconds);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function VideoViewer({ filePath, cwd, sourceSessionId }: Props) {
  const { t } = useI18n();
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  // bfcache 恢复：文档回来时 +1，让下面的 watch effect 重建连接（#91）。
  const restoreNonce = useLiveStreamRestoreNonce();

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    setSize(null);
    setDuration(null);
    setError(null);
    setWatching(false);

    if (esRef.current) {
      closeTrackedEventSource(esRef.current);
      esRef.current = null;
    }

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;
    // 登记到 live-event-sources：pagehide 时集中让出同源连接（#91）。
    trackLiveEventSource(es);

    es.addEventListener("connected", () => setWatching(true));
    es.addEventListener("change", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      setDuration(null);
      setError(null);
      setBust((b) => b + 1);
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);

    return () => {
      closeTrackedEventSource(es);
      esRef.current = null;
    };
  }, [filePath, sourceSessionId, restoreNonce]);

  const src = getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span style={{ marginLeft: "auto" }}>{ext || "video"}</span>
        {duration != null && <span>{formatDuration(duration)}</span>}
        {size != null && <span>{formatSize(size)}</span>}
        <span
          title={watching ? t("viewer_liveSyncOn") : t("viewer_liveSyncOff")}
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "var(--status-success)" : "var(--text-dim)" }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "var(--status-success)" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "var(--live-indicator-glow)" : "none",
            }}
          />
          {watching ? t("viewer_live") : t("viewer_static")}
        </span>
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "var(--bg-panel)",
        }}
      >
        <div style={{ width: "min(680px, 100%)" }}>
          {error && (
            <div style={{ color: "var(--error-text)", fontSize: 13, marginBottom: 12, textAlign: "center" }}>
              {error}
            </div>
          )}
          <video
            key={src}
            controls
            playsInline
            preload="metadata"
            src={src}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onError={() => setError(t("viewer_loadFailed"))}
            style={{ width: "100%", maxHeight: "min(480px, 60vh)", background: "var(--media-canvas)" }}
          />
        </div>
      </div>
    </div>
  );
}

function AudioViewer({ filePath, cwd, sourceSessionId }: Props) {
  const { t } = useI18n();
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  // bfcache 恢复：文档回来时 +1，让下面的 watch effect 重建连接（#91）。
  const restoreNonce = useLiveStreamRestoreNonce();

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    setSize(null);
    setDuration(null);
    setError(null);
    setWatching(false);

    if (esRef.current) {
      closeTrackedEventSource(esRef.current);
      esRef.current = null;
    }

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;
    // 登记到 live-event-sources：pagehide 时集中让出同源连接（#91）。
    trackLiveEventSource(es);

    es.addEventListener("connected", () => setWatching(true));
    es.addEventListener("change", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      setDuration(null);
      setError(null);
      setBust((b) => b + 1);
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);

    return () => {
      closeTrackedEventSource(es);
      esRef.current = null;
    };
  }, [filePath, sourceSessionId, restoreNonce]);

  const src = getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span style={{ marginLeft: "auto" }}>{ext || "audio"}</span>
        {duration != null && <span>{formatDuration(duration)}</span>}
        {size != null && <span>{formatSize(size)}</span>}
        <span
          title={watching ? t("viewer_liveSyncOn") : t("viewer_liveSyncOff")}
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "var(--status-success)" : "var(--text-dim)" }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "var(--status-success)" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "var(--live-indicator-glow)" : "none",
            }}
          />
          {watching ? t("viewer_live") : t("viewer_static")}
        </span>
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "var(--bg-panel)",
        }}
      >
        <div style={{ width: "min(680px, 100%)" }}>
          {error && (
            <div style={{ color: "var(--error-text)", fontSize: 13, marginBottom: 12, textAlign: "center" }}>
              {error}
            </div>
          )}
          <audio
            key={src}
            controls
            preload="metadata"
            src={src}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onError={() => setError(t("viewer_loadFailed"))}
            style={{ width: "100%" }}
          />
        </div>
      </div>
    </div>
  );
}

function DocumentViewer({ filePath, cwd, sourceSessionId }: Props) {
  const { t } = useI18n();
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  // bfcache 恢复：文档回来时 +1，让下面的 watch effect 重建连接（#91）。
  const restoreNonce = useLiveStreamRestoreNonce();

  const ext = getFileExt(filePath);
  const isPdf = ext === "pdf";
  const previewUrl = isPdf
    ? getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined)
    : getFileApiUrl(filePath, "preview", sourceSessionId, bust ? { v: bust } : undefined);

  useEffect(() => {
    setBust(0);
    setSize(null);
    setError(null);
    setWatching(false);

    if (esRef.current) {
      closeTrackedEventSource(esRef.current);
      esRef.current = null;
    }

    fetch(getFileApiUrl(filePath, "meta", sourceSessionId))
      .then((r) => r.json())
      .then((d: { size?: number; error?: string }) => {
        if (d.error) setError(d.error);
        if (typeof d.size === "number") {
          setSize(d.size);
          if (!isPdf && d.size > DOCX_PREVIEW_MAX_BYTES) {
            setError(t("viewer_docxTooLarge"));
          }
        }
      })
      .catch((e) => setError(String(e)));

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;
    // 登记到 live-event-sources：pagehide 时集中让出同源连接（#91）。
    trackLiveEventSource(es);

    es.addEventListener("connected", () => setWatching(true));
    es.addEventListener("change", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") {
          setSize(d.size);
          if (!isPdf && d.size > DOCX_PREVIEW_MAX_BYTES) {
            setError(t("viewer_docxTooLarge"));
            return;
          }
        }
      } catch { /* ignore */ }
      setError(null);
      setBust((b) => b + 1);
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);

    return () => {
      closeTrackedEventSource(es);
      esRef.current = null;
    };
  }, [filePath, isPdf, sourceSessionId, t, restoreNonce]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span style={{ marginLeft: "auto" }}>{ext === "docx" ? "docx preview" : "pdf"}</span>
        {size != null && <span>{formatSize(size)}</span>}
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
        <span
          title={watching ? t("viewer_liveSyncOn") : t("viewer_liveSyncOff")}
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "var(--status-success)" : "var(--text-dim)", flexShrink: 0 }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "var(--status-success)" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "var(--live-indicator-glow)" : "none",
            }}
          />
          {watching ? t("viewer_live") : t("viewer_static")}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, background: "var(--bg-panel)" }}>
        {error ? (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, color: "var(--error-text)", fontSize: 13, textAlign: "center" }}>
            {error}
          </div>
        ) : (
          <iframe
            key={previewUrl}
            src={previewUrl}
            sandbox={isPdf ? undefined : ""}
            title={`${t("viewer_preview")} ${getFileName(filePath)}`}
            style={{ width: "100%", height: "100%", border: "none", background: isPdf ? "var(--bg)" : "#eef1f5" }}
          />
        )}
      </div>
    </div>
  );
}

export function FileViewer({ filePath, cwd, sourceSessionId, writable, buffer, dispatchBuffer, onSave, onOpenFile, gitAffectedPaths }: Props) {
  if (isImagePath(filePath)) {
    return <ImageViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} />;
  }
  // webm 同时在音频与视频表里，文件类型探测约定视频优先。
  if (isVideoPath(filePath)) {
    return <VideoViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} />;
  }
  if (isAudioPath(filePath)) {
    return <AudioViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} />;
  }
  if (isDocumentPreviewPath(filePath)) {
    return <DocumentViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} />;
  }
  return <TextFileViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} writable={writable} buffer={buffer} dispatchBuffer={dispatchBuffer} onSave={onSave} onOpenFile={onOpenFile} gitAffectedPaths={gitAffectedPaths} />;
}

function TextFileViewer({ filePath, cwd, sourceSessionId, writable = false, buffer, dispatchBuffer, onSave, onOpenFile, gitAffectedPaths }: Props) {
  const { isDark } = useTheme();
  const { t } = useI18n();
  const [data, setData] = useState<FileData | null>(null);
  const [gitDiff, setGitDiff] = useState<GitFileDiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("source");
  const [wrapLines, setWrapLines] = useState(false);
  const [watching, setWatching] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  // bfcache 恢复：文档回来时 +1，让下面的 watch effect 重建连接（#91）。
  const restoreNonce = useLiveStreamRestoreNonce();
  // 切文件/切 diff 目标时旧响应可能后到：只有最新一次请求可以写 gitDiff。
  const gitDiffGuardRef = useRef<LatestRequestGuard | null>(null);
  if (!gitDiffGuardRef.current) gitDiffGuardRef.current = createLatestRequestGuard();
  const gitDiffGuard = gitDiffGuardRef.current;
  const shellRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const bufferRef = useRef(buffer);
  bufferRef.current = buffer;
  const forceBoundaryRef = useRef(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [acknowledgedExternalChange, setAcknowledgedExternalChange] = useState<string | null>(null);
  const savedFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchContent = useCallback((filePath: string) => {
    return fetch(getFileApiUrl(filePath, "read", sourceSessionId))
      .then((r) => r.json())
      .then((d: FileData & { error?: string }) => {
        if (d.error) {
          setError(d.error);
          return null;
        }
        setError(null);
        setData(d);
        const current = bufferRef.current;
        const isKnownDirtyBaseline = current?.dirty
          && current.savedContent === d.content
          && current.baseline.size === d.size
          && current.baseline.mtimeMs === d.mtimeMs;
        if (!isKnownDirtyBaseline) {
          dispatchBuffer?.({
            type: "initialize",
            filePath,
            sourceSessionId,
            content: d.content,
            baseline: { size: d.size, mtimeMs: d.mtimeMs },
            language: d.language,
          });
        }
        return d;
      })
      .catch((e) => {
        setError(String(e));
        return null;
      });
  }, [dispatchBuffer, sourceSessionId]);

  const fetchGitDiff = useCallback(async (targetPath: string) => {
    const requestId = gitDiffGuard.next();
    if (!cwd) {
      setGitDiff(null);
      return;
    }

    try {
      const params = new URLSearchParams({ cwd, path: targetPath });
      const response = await fetch(`/api/git/diff?${params.toString()}`);
      const next = await response.json() as GitFileDiffResponse & { error?: string };
      if (!gitDiffGuard.isCurrent(requestId)) return;
      setGitDiff(response.ok && next.supported && typeof next.patch === "string" ? next : null);
    } catch {
      if (gitDiffGuard.isCurrent(requestId)) setGitDiff(null);
    }
  }, [cwd, gitDiffGuard]);

  // Initial load + SSE watch setup
  useEffect(() => {
    setLoading(true);
    setError(null);
    setData(null);
    setGitDiff(null);
    setDisplayMode("source");
    setWrapLines(false);
    setWatching(false);

    if (esRef.current) {
      closeTrackedEventSource(esRef.current);
      esRef.current = null;
    }

    // 打开/切换文件时先拉一次该文件 diff（服务端按 mtime 缓存，代价小）：
    // 否则「Git 差异」开关要等文件在打开期间被改动（watch change / gitAffectedPaths 命中）
    // 才出现，未跟踪/已修改的文件也一样看不到 diff。
    void fetchGitDiff(filePath);

    fetchContent(filePath).then((d) => {
      if (d?.language === "markdown") setDisplayMode("preview");
    }).finally(() => setLoading(false));

    // Set up SSE watch
    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;
    // 登记到 live-event-sources：pagehide 时集中让出同源连接（#91）。
    trackLiveEventSource(es);

    es.addEventListener("connected", () => {
      setWatching(true);
    });

    es.addEventListener("change", () => {
      void fetchContent(filePath);
      void fetchGitDiff(filePath);
    });

    es.addEventListener("error", () => {
      setWatching(false);
    });

    es.onerror = () => {
      setWatching(false);
    };

    return () => {
      closeTrackedEventSource(es);
      esRef.current = null;
    };
  }, [filePath, fetchContent, fetchGitDiff, sourceSessionId, restoreNonce]);

  // 受影响路径集合命中当前文件时定向重抓该文件 diff（SSE watch 的兜底：
  // 覆盖 watcher 未建立/事件丢失场景）。null 或未命中不重抓——agent 结束
  // 不再触发全仓 diff 重抓，单文件修改只失效对应 diff。
  useEffect(() => {
    if (gitAffectedPaths && affectedPathsMatchFile(gitAffectedPaths, filePath)) {
      void fetchGitDiff(filePath);
    }
  }, [fetchGitDiff, filePath, gitAffectedPaths]);

  useEffect(() => () => {
    if (savedFlashTimerRef.current) clearTimeout(savedFlashTimerRef.current);
  }, []);

  const runSave = useCallback(async () => {
    if (!onSave || !buffer?.dirty || buffer.saveState === "saving") return false;
    const saved = await onSave();
    if (saved) {
      if (savedFlashTimerRef.current) clearTimeout(savedFlashTimerRef.current);
      setSavedFlash(true);
      savedFlashTimerRef.current = setTimeout(() => setSavedFlash(false), 1600);
    }
    return saved;
  }, [buffer?.dirty, buffer?.saveState, onSave]);

  const runUndo = useCallback(() => {
    if (buffer && dispatchBuffer && canUndo(buffer)) dispatchBuffer({ type: "undo", key: buffer.key });
  }, [buffer, dispatchBuffer]);

  const runRedo = useCallback(() => {
    if (buffer && dispatchBuffer && canRedo(buffer)) dispatchBuffer({ type: "redo", key: buffer.key });
  }, [buffer, dispatchBuffer]);

  // 文件 tab 激活时接管明确的编辑快捷键；表单焦点若在本文件工作区之外则完全放行。
  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (!writable || !buffer || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      const active = document.activeElement;
      const isFormControl = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement || active instanceof HTMLElement && active.isContentEditable;
      if (isFormControl && !shellRef.current?.contains(active)) return;
      const key = event.key.toLowerCase();
      if (key === "s" && !event.shiftKey) {
        event.preventDefault();
        void runSave();
      } else if (key === "z" && event.shiftKey) {
        event.preventDefault();
        runRedo();
      } else if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        runUndo();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [buffer, runRedo, runSave, runUndo, writable]);

  const hasGitDiff = gitDiff?.supported === true && typeof gitDiff.patch === "string";
  const externalChangeFingerprint = buffer?.externalChange
    ? `${buffer.externalChange.baseline.mtimeMs}:${buffer.externalChange.baseline.size}`
    : buffer?.saveState === "conflict"
      ? `conflict:${buffer.baseline.mtimeMs}:${buffer.baseline.size}`
      : null;
  const showExternalChange = externalChangeFingerprint !== null
    && acknowledgedExternalChange !== externalChangeFingerprint;

  useEffect(() => {
    setAcknowledgedExternalChange(null);
  }, [externalChangeFingerprint]);

  useEffect(() => {
    if (!hasGitDiff && displayMode === "diff") setDisplayMode("source");
  }, [displayMode, hasGitDiff]);

  if (loading) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
        {t("common_loading")}
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--error-text)", fontSize: 13 }}>
        {error}
      </div>
    );
  }

  if (!data) return null;

  const visibleContent = buffer?.content ?? data.content;
  const visibleLanguage = buffer?.language ?? data.language;
  const isHtml = visibleLanguage === "html";
  const isMarkdown = visibleLanguage === "markdown";
  const hasPreview = isHtml || isMarkdown;
  const markdownDirectory = getFileDirectory(filePath);
  const lines = visibleContent.split("\n");
  const displayModes: DisplayMode[] = [
    "source",
    ...(hasPreview ? ["preview" as const] : []),
    ...(hasGitDiff ? ["diff" as const] : []),
  ];
  const metadata = `${visibleLanguage} · ${t("viewer_linesCount", { count: lines.length })} · ${formatSize(data.size)}`;
  const readOnlyReason = !sourceSessionId
    ? t("viewer_readOnlyNoSession")
    : !writable
      ? t("viewer_readOnlySession")
      : null;

  const handleEditorChange = (content: string) => {
    if (!buffer || !dispatchBuffer) return;
    dispatchBuffer({ type: "edit", key: buffer.key, content, forceBoundary: forceBoundaryRef.current });
    forceBoundaryRef.current = false;
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    const target = event.currentTarget;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const next = `${visibleContent.slice(0, start)}  ${visibleContent.slice(end)}`;
    forceBoundaryRef.current = true;
    handleEditorChange(next);
    requestAnimationFrame(() => {
      target.focus();
      target.setSelectionRange(start + 2, start + 2);
    });
  };

  const discardAndReload = () => {
    if (!buffer || !dispatchBuffer) return;
    dispatchBuffer({ type: "discard", key: buffer.key });
    setLoading(true);
    void fetchContent(filePath).finally(() => setLoading(false));
  };

  return (
    <div ref={shellRef} className="file-viewer-shell" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden" }}>
      <div
        className="file-viewer-toolbar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 12px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <span className="file-viewer-path" style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>

        <span className="file-viewer-meta" title={metadata}>{metadata}</span>
        <span
          title={watching ? t("viewer_liveSyncOn") : t("viewer_liveSyncOff")}
          aria-label={watching ? t("viewer_liveSyncOn") : t("viewer_liveSyncOff")}
          className="file-viewer-live-indicator"
          style={{
            background: watching ? "var(--status-success)" : "var(--border)",
            boxShadow: watching ? "var(--live-indicator-glow)" : "none",
          }}
        />

        <div className="file-viewer-controls" role="toolbar" aria-label={t("viewer_fileEditAria")}>
          {displayModes.map((mode) => (
            <button key={mode} type="button" onClick={() => setDisplayMode(mode)} title={mode === "diff" ? t("viewer_gitDiff") : t(DISPLAY_MODE_KEYS[mode])} aria-label={mode === "diff" ? t("viewer_gitDiff") : t(DISPLAY_MODE_KEYS[mode])} aria-pressed={displayMode === mode} className="file-viewer-icon-button" data-active={displayMode === mode}>
              {mode === "source" ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                : mode === "preview" ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
                : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3"/><path d="M12 2v20"/></svg>}
            </button>
          ))}
          {displayMode === "source" && (
              <button
                type="button"
                onClick={() => setWrapLines((value) => !value)}
                title={wrapLines ? t("viewer_disableWrap") : t("viewer_enableWrap")}
                aria-label={wrapLines ? t("viewer_disableWrap") : t("viewer_enableWrap")}
                aria-pressed={wrapLines}
                className="file-viewer-icon-button"
                data-active={wrapLines}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 6h18" />
                  <path d="M3 12h15a3 3 0 1 1 0 6h-4" />
                  <path d="m16 16-2 2 2 2" />
                  <path d="M3 18h7" />
                </svg>
              </button>
          )}
          <span className="file-viewer-toolbar-separator" aria-hidden="true" />
          <button type="button" className="file-viewer-icon-button" onClick={runUndo} disabled={!writable || !canUndo(buffer)} title={`${t("viewer_undo")} (Ctrl/Cmd+Z)`} aria-label={t("viewer_undo")}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v1"/></svg></button>
          <button type="button" className="file-viewer-icon-button" onClick={runRedo} disabled={!writable || !canRedo(buffer)} title={`${t("viewer_redo")} (Ctrl/Cmd+Shift+Z)`} aria-label={t("viewer_redo")}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0-6 6v1"/></svg></button>
          <button type="button" className="file-viewer-icon-button is-save" onClick={() => void runSave()} disabled={!writable || !buffer?.dirty || buffer.saveState === "saving"} title={`${t("viewer_save")} (Ctrl/Cmd+S)`} aria-label={t("viewer_save")}>
            {buffer?.saveState === "saving" ? <span className="file-save-spinner" aria-hidden="true" /> : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>}
          </button>
          <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
        </div>
      </div>

      {(showExternalChange || buffer?.saveState === "error" || readOnlyReason || savedFlash) && (
        <div className={`file-editor-notice${showExternalChange ? " is-warning" : buffer?.saveState === "error" ? " is-error" : savedFlash ? " is-success" : ""}`} role={buffer?.saveState === "error" ? "alert" : "status"}>
          <span>{buffer?.externalChange ? t("viewer_externalChangeDraftKept") : buffer?.saveState === "conflict" ? (buffer.error ?? t("viewer_externalSaveConflict")) : buffer?.saveState === "error" ? buffer.error : savedFlash ? t("common_saved") : readOnlyReason}</span>
          {showExternalChange && (
            <span className="file-editor-notice__actions">
              <button type="button" onClick={() => {
                setAcknowledgedExternalChange(externalChangeFingerprint);
                setDisplayMode("source");
                requestAnimationFrame(() => editorRef.current?.focus());
              }} title={t("viewer_keepLocalDraft")} aria-label={t("viewer_keepLocalDraft")}>{t("viewer_keepLocalDraft")}</button>
              <button type="button" className="is-danger" onClick={discardAndReload} title={t("viewer_discardLocalDraftReload")} aria-label={t("viewer_discardLocalDraftReload")}>{t("viewer_discardLocalDraftReload")}</button>
            </span>
          )}
        </div>
      )}

      {/* Content area */}
      <div className="file-viewer-content" style={{ flex: "1 1 auto", minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column", overflow: "auto", background: "var(--bg)" }}>
        {displayMode === "diff" && hasGitDiff ? (
          <><div className="file-viewer-context-label">{t("viewer_gitDiffSavedWorktree")}</div><GitDiffView patch={gitDiff.patch!} /></>
        ) : isHtml && displayMode === "preview" ? (
          <iframe
            srcDoc={visibleContent}
            sandbox="allow-scripts"
            style={{ width: "100%", height: "100%", border: "none", background: "var(--bg)" }}
            title={t("viewer_htmlPreview")}
          />
        ) : isMarkdown && displayMode === "preview" ? (
          <div
            className="markdown-body markdown-file-preview"
            style={{ padding: "24px 32px" }}
          >
            <ReactMarkdown
              remarkPlugins={markdownPreviewRemarkPlugins}
              rehypePlugins={markdownPreviewRehypePlugins}
              components={{
                a({ href, children, ...props }) {
                  delete props.node;
                  const linkedFile = onOpenFile
                    ? resolveLocalFileHref(href, markdownDirectory, cwd ?? markdownDirectory)
                    : null;
                  if (!linkedFile || !onOpenFile) {
                    return <a href={href} {...props}>{children}</a>;
                  }

                  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
                    if (event.defaultPrevented || event.button !== 0) return;
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    onOpenFile(linkedFile);
                  };

                  return <a href={href} {...props} onClick={handleClick}>{children}</a>;
                },
              }}
            >
              {visibleContent}
            </ReactMarkdown>
          </div>
        ) : (
          writable && buffer && dispatchBuffer ? (
            <textarea
              ref={editorRef}
              className={wrapLines ? "file-source-editor is-wrapped" : "file-source-editor"}
              value={visibleContent}
              onChange={(event) => handleEditorChange(event.target.value)}
              onKeyDown={handleEditorKeyDown}
              onPaste={() => { forceBoundaryRef.current = true; }}
              onCut={() => { forceBoundaryRef.current = true; }}
              wrap={wrapLines ? "soft" : "off"}
              spellCheck={false}
              aria-label={`${t("viewer_fileEditAria")}: ${getFileName(filePath)}`}
            />
          ) : <SyntaxHighlighter
            className={wrapLines ? "file-source-view is-wrapped" : "file-source-view"}
            language={visibleLanguage === "text" ? "plaintext" : visibleLanguage}
            style={isDark ? vscDarkPlus : vs}
            showLineNumbers
            lineNumberStyle={{
              ...FILE_LINE_NUMBER_STYLE,
            }}
            customStyle={{
              margin: 0,
              padding: 0,
              border: 0,
              background: "var(--bg)",
              ...FILE_CODE_STYLE,
              width: wrapLines ? "100%" : "max-content",
              minWidth: "100%",
              minHeight: "100%",
              overflow: "visible",
            }}
            codeTagProps={{
              style: {
                fontFamily: "var(--font-mono)",
                overflowWrap: wrapLines ? "anywhere" : "normal",
              },
            }}
            renderer={(rendererProps) => (
              <SourceCodeRenderer {...rendererProps} wrapLines={wrapLines} />
            )}
            wrapLongLines={wrapLines}
          >
            {visibleContent}
          </SyntaxHighlighter>
        )}
      </div>
    </div>
  );
}
