"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from "react";
import { Download, Minus, Plus, RotateCcw } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { closeImagePreview, openImagePreview, useImagePreview } from "@/lib/image-preview-store";
import type { ImageContent } from "@/lib/types";

export interface ResolvedImageContent {
  src: string;
  mimeType?: string;
}

export interface MessageImageProps {
  /** 消息内显示的缩略图地址。 */
  src: string;
  /** 展开到输入框上方时使用的原图地址；默认使用 src。 */
  fullSrc?: string;
  /** 下载地址；消息媒体应传 type=download 地址。 */
  downloadHref?: string;
  downloadName?: string;
  mimeType?: string;
  alt?: string;
  title?: string;
  maxWidth?: number | string;
  maxHeight?: number | string;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;
export const MESSAGE_IMAGE_MAX_WIDTH = 360;
export const MESSAGE_IMAGE_MAX_HEIGHT = 280;

const MIME_EXTENSIONS: Record<string, string> = {
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "image/x-icon": "ico",
};

/** ImageContent 兼容 Pi 原生扁平结构和历史 source 结构。 */
export function resolveImageContent(image: ImageContent): ResolvedImageContent | null {
  const candidate = image as ImageContent & {
    source?: { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
    data?: unknown;
    mimeType?: unknown;
  };
  const source = candidate.source;
  if (source && typeof source === "object") {
    if (source.type === "base64" && typeof source.data === "string" && source.data.length > 0) {
      const mimeType = normalizeImageMime(source.media_type);
      return { src: `data:${mimeType};base64,${source.data}`, mimeType };
    }
    if (source.type === "url" && typeof source.url === "string" && source.url.trim()) {
      const src = source.url.trim();
      if (!isSafeImageSrc(src)) return null;
      return {
        src,
        mimeType: normalizeOptionalImageMime(source.media_type),
      };
    }
  }
  if (typeof candidate.data === "string" && candidate.data.length > 0) {
    const mimeType = normalizeImageMime(candidate.mimeType);
    return { src: `data:${mimeType};base64,${candidate.data}`, mimeType };
  }
  return null;
}

function normalizeOptionalImageMime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return /^image\/[a-z0-9.+-]+$/.test(normalized) ? normalized : undefined;
}

function normalizeImageMime(value: unknown): string {
  return normalizeOptionalImageMime(value) ?? "image/png";
}

function isSafeImageSrc(src: string): boolean {
  const value = src.trim();
  if (!value) return false;
  if (value.startsWith("data:")) return /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
  try {
    const protocol = new URL(value, "http://pidance.invalid").protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "blob:";
  } catch {
    return false;
  }
}

function inferDownloadName(src: string, mimeType?: string): string {
  if (!src.startsWith("data:")) {
    try {
      const url = new URL(src, "http://pidance.invalid");
      const segment = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      if (/^[^\\/:*?\"<>|]+\.[a-z0-9]{1,8}$/i.test(segment)) return segment;
    } catch {
      // Use the MIME fallback for opaque or malformed URLs.
    }
  }
  return `image.${mimeType ? MIME_EXTENSIONS[mimeType.toLowerCase()] ?? "png" : "png"}`;
}

const controlStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 30,
  minHeight: 30,
  padding: 4,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg-subtle)",
  color: "var(--text-muted)",
  cursor: "pointer",
};

export function MessageImage({
  src,
  fullSrc,
  downloadHref,
  downloadName,
  mimeType,
  alt,
  title,
  maxWidth = MESSAGE_IMAGE_MAX_WIDTH,
  maxHeight = MESSAGE_IMAGE_MAX_HEIGHT,
}: MessageImageProps) {
  const { t } = useI18n();
  const resolvedFullSrc = fullSrc && isSafeImageSrc(fullSrc) ? fullSrc : src;
  const resolvedDownloadHref = downloadHref || resolvedFullSrc;
  const resolvedDownloadName = downloadName?.trim() || inferDownloadName(resolvedDownloadHref, mimeType);
  const resolvedAlt = alt || t("message_imageAlt");

  if (!src || !isSafeImageSrc(src)) return null;

  return (
    <button
      type="button"
      onClick={() => openImagePreview({
        src: resolvedFullSrc,
        downloadHref: resolvedDownloadHref,
        downloadName: resolvedDownloadName,
        mimeType,
        alt: resolvedAlt,
        title,
      })}
      aria-label={t("message_openImage")}
      title={title || t("message_openImage")}
      style={{
        display: "block",
        maxWidth,
        maxHeight,
        margin: 0,
        padding: 0,
        border: "1px solid var(--border)",
        borderRadius: 6,
        background: "var(--bg-subtle)",
        cursor: "zoom-in",
        overflow: "hidden",
        lineHeight: 0,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={resolvedAlt}
        title={title}
        draggable={false}
        decoding="async"
        style={{ display: "block", maxWidth, maxHeight, objectFit: "contain" }}
      />
    </button>
  );
}

export function ImagePreviewPanel() {
  const { t } = useI18n();
  const preview = useImagePreview();
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; x: number; y: number; offsetX: number; offsetY: number } | null>(null);

  const resetView = useCallback(() => {
    setZoom(MIN_ZOOM);
    setOffset({ x: 0, y: 0 });
  }, []);
  const changeZoom = useCallback((delta: number) => {
    setZoom((previous) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number((previous + delta).toFixed(2)))));
  }, []);

  useEffect(() => {
    resetView();
    dragRef.current = null;
  }, [preview?.id, resetView]);

  useEffect(() => () => closeImagePreview(), []);

  useEffect(() => {
    if (!preview) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeImagePreview();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [preview]);

  const onWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    changeZoom(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  }, [changeZoom]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (zoom <= MIN_ZOOM) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      offsetX: offset.x,
      offsetY: offset.y,
    };
  }, [offset.x, offset.y, zoom]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setOffset({
      x: drag.offsetX + event.clientX - drag.x,
      y: drag.offsetY + event.clientY - drag.y,
    });
  }, []);

  const stopDragging = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  if (!preview) return null;

  return (
    <div
      role="region"
      aria-label={t("message_imageViewer")}
      style={{
        flexShrink: 0,
        padding: "0 16px 8px",
        background: "var(--bg)",
      }}
    >
      <div
        style={{
          width: "min(100%, 820px)",
          // 预览是输入区上方的显示块，不应占满移动端或桌面会话视口。
          maxHeight: "min(34vh, 360px)",
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          border: "1px solid var(--border)",
          borderRadius: 9,
          background: "var(--bg-panel)",
          boxShadow: "0 8px 24px color-mix(in srgb, var(--text) 10%, transparent)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 42, padding: "6px 8px 6px 12px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: 12, fontWeight: 650 }} title={preview.title || preview.alt}>
            {preview.title || preview.alt}
          </span>
          <button type="button" onClick={() => changeZoom(-ZOOM_STEP)} disabled={zoom <= MIN_ZOOM} aria-label={t("message_zoomOut")} title={t("message_zoomOut")} style={{ ...controlStyle, opacity: zoom <= MIN_ZOOM ? 0.45 : 1 }}>
            <Minus size={14} strokeWidth={1.9} aria-hidden="true" />
          </button>
          <button type="button" onClick={resetView} aria-label={t("message_resetZoom")} title={t("message_resetZoom")} style={{ ...controlStyle, minWidth: 48, fontSize: 11 }}>
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" onClick={() => changeZoom(ZOOM_STEP)} disabled={zoom >= MAX_ZOOM} aria-label={t("message_zoomIn")} title={t("message_zoomIn")} style={{ ...controlStyle, opacity: zoom >= MAX_ZOOM ? 0.45 : 1 }}>
            <Plus size={14} strokeWidth={1.9} aria-hidden="true" />
          </button>
          <button type="button" onClick={resetView} aria-label={t("message_resetZoom")} title={t("message_resetZoom")} style={controlStyle}>
            <RotateCcw size={14} strokeWidth={1.9} aria-hidden="true" />
          </button>
          <a href={preview.downloadHref} download={preview.downloadName} aria-label={t("message_downloadImage")} title={t("message_downloadImage")} style={{ ...controlStyle, gap: 5, color: "var(--accent)", textDecoration: "none", fontSize: 12 }}>
            <Download size={14} strokeWidth={1.9} aria-hidden="true" />
            {t("message_downloadImage")}
          </a>
          <button type="button" onClick={closeImagePreview} aria-label={t("message_closeImage")} title={t("message_closeImage")} style={{ ...controlStyle, fontSize: 18, lineHeight: 1 }}>
            ×
          </button>
        </div>
        <div
          tabIndex={0}
          role="group"
          aria-label={t("message_imageViewer")}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={stopDragging}
          onPointerCancel={stopDragging}
          onDoubleClick={() => (zoom > MIN_ZOOM ? resetView() : changeZoom(1))}
          onKeyDown={(event) => {
            if (event.key === "+" || event.key === "=") {
              event.preventDefault();
              changeZoom(ZOOM_STEP);
            } else if (event.key === "-") {
              event.preventDefault();
              changeZoom(-ZOOM_STEP);
            } else if (event.key === "0") {
              event.preventDefault();
              resetView();
            }
          }}
          style={{
            width: "100%",
            height: "min(30vh, 320px)",
            minHeight: 140,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            cursor: zoom > MIN_ZOOM ? "grab" : "zoom-in",
            touchAction: "none",
            background: "var(--bg)",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={preview.src}
            alt={preview.alt}
            draggable={false}
            decoding="async"
            style={{
              display: "block",
              maxWidth: "100%",
              maxHeight: "100%",
              width: "auto",
              height: "auto",
              objectFit: "contain",
              userSelect: "none",
              WebkitUserSelect: "none",
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
              transformOrigin: "center center",
              transition: dragRef.current ? "none" : "transform 0.12s ease-out",
            }}
          />
        </div>
      </div>
    </div>
  );
}
