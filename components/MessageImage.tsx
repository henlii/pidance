"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type WheelEvent } from "react";
import { createPortal } from "react-dom";
import { Download, Minus, Plus, RotateCcw } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { closeImagePreview, isImageDownloaded, markImageDownloaded, openImagePreview, useImagePreview } from "@/lib/image-preview-store";
import { filePathFromApiUrl } from "@/lib/file-paths";
import { SaveAsDialog } from "./SaveAsDialog";
import { readDialogViewportRect } from "@/components/ui/ViewportDialog";
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

/** 全屏遮罩上的控件：始终压在深色背景上，故用固定浅色而非主题变量。 */
const overlayControlStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 30,
  minHeight: 30,
  padding: 4,
  border: "1px solid rgba(255,255,255,0.22)",
  borderRadius: 6,
  background: "rgba(255,255,255,0.10)",
  color: "#fff",
  cursor: "pointer",
  flexShrink: 0,
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

/**
 * 全屏遮罩层的图片查看器。
 *
 * 用固定全屏遮罩直接显示原图，而不是在输入区上方展开一块受限面板
 * （原先高度被 `min(34vh, 360px)` 限制，看大图要反复缩放平移）。
 * 遮罩本身即背景：点击图片以外区域关闭。
 *
 * 用 visual viewport（而非 inset）定位，理由与 components/ui/ViewportDialog 相同：
 * iOS 的 fixed 元素相对 layout viewport 定位，软键盘/缩放时 inset 会跑偏。
 */
export function ImagePreviewOverlay() {
  const { t } = useI18n();
  const preview = useImagePreview();
  const [zoom, setZoom] = useState(MIN_ZOOM);
  /** 「下载原图」点过之后按钮变「另存为」（同一张图在同一页面生命周期内只算一次）。 */
  const [downloaded, setDownloaded] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const saveAsPath = preview ? filePathFromApiUrl(preview.downloadHref) : null;
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [viewport, setViewport] = useState(() => readDialogViewportRect());
  // 记录是否发生拖动：拖完不应被当成「点击背景」而误关闭。
  const movedRef = useRef(false);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  const clampZoom = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));

  /**
   * 把平移量限制在「图片超出可视区的那部分」之内。
   *
   * `transform` 是 `translate(x,y) scale(z)`：平移在外层，不受缩放影响，
   * 所以单纯改 zoom 不会自动把图拉回中间——必须显式收敛平移量。
   * 允许的最大位移 = (渲染尺寸 × 缩放 − 可视区) / 2，下限 0：
   * 图没超出可视区时（含缩回 100%）位移必然归零，即回到居中。
   */
  const clampOffset = useCallback((next: { x: number; y: number }, zoomLevel: number) => {
    const img = imgRef.current;
    const surface = surfaceRef.current;
    if (!img || !surface || zoomLevel <= MIN_ZOOM) return { x: 0, y: 0 };
    const style = window.getComputedStyle(surface);
    const availWidth = surface.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
    const availHeight = surface.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
    // offsetWidth/Height 是布局尺寸（fit 后、未受 transform 影响）。
    const maxX = Math.max(0, (img.offsetWidth * zoomLevel - availWidth) / 2);
    const maxY = Math.max(0, (img.offsetHeight * zoomLevel - availHeight) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    };
  }, []);

  const resetView = useCallback(() => {
    setZoom(MIN_ZOOM);
    setOffset({ x: 0, y: 0 });
  }, []);
  const changeZoom = useCallback((delta: number) => {
    setZoom((previous) => {
      const next = clampZoom(previous + delta);
      // 同步收敛平移量：缩小时把图拉回可视区，缩回 100% 即完全居中。
      setOffset((current) => clampOffset(current, next));
      return next;
    });
  }, [clampOffset]);

  useEffect(() => {
    resetView();
    dragRef.current = null;
    setDownloaded(preview ? isImageDownloaded(preview.downloadHref) : false);
    setSaveAsOpen(false);
  }, [preview?.id, preview, resetView]);

  useEffect(() => () => closeImagePreview(), []);

  // visual viewport 变化（软键盘、双指缩放、旋转）时重新贴合。
  useEffect(() => {
    if (!preview) return;
    const update = () => {
      setViewport(readDialogViewportRect());
      // 可视区变了，允许的平移范围也变了：重新收敛，避免图停在区外。
      setOffset((current) => clampOffset(current, zoom));
    };
    update();
    const vv = typeof window === "undefined" ? null : window.visualViewport;
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, [preview, clampOffset, zoom]);

  useEffect(() => {
    if (!preview) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeImagePreview();
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        changeZoom(ZOOM_STEP);
      } else if (event.key === "-") {
        event.preventDefault();
        changeZoom(-ZOOM_STEP);
      } else if (event.key === "0") {
        event.preventDefault();
        resetView();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [preview, changeZoom, resetView]);

  const onWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    changeZoom(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  }, [changeZoom]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    movedRef.current = false;
    // 未放大时拖动没有意义，交给遮罩的点击关闭处理。
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
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) movedRef.current = true;
    setOffset(clampOffset({ x: drag.offsetX + dx, y: drag.offsetY + dy }, zoom));
  }, [clampOffset, zoom]);

  const stopDragging = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  /**
   * 点击图片以外区域关闭。
   *
   * 挂在**图片区**而不是遮罩根节点：图片区 `flex: 1` 铺满整个遮罩，
   * 真实点击永远落在它（或图）上，遮罩根节点自身没有可点区域——
   * 挂在根节点上等于这条交互不存在。
   * 刚拖动过则吞掉这一次 click（浏览器在 pointerup 后仍会派发 click）。
   */
  const onSurfaceClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (movedRef.current) {
      movedRef.current = false;
      return;
    }
    if (event.target !== event.currentTarget) return;
    closeImagePreview();
  }, []);

  if (!preview) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("message_imageViewer")}
      style={{
        position: "fixed",
        top: viewport.top,
        left: viewport.left,
        width: viewport.width,
        height: viewport.height,
        zIndex: 1100,
        background: "color-mix(in srgb, #000 82%, transparent)",
        display: "flex",
        flexDirection: "column",
        // 阻断滚动链：触屏/触控板在遮罩上的手势不传给背景页面。
        overscrollBehavior: "contain",
      }}
    >
      {/* 顶部工具条：悬浮在图片之上，不挤压图片可用高度 */}
      <div
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          right: 8,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 8px 6px 12px",
          borderRadius: 9,
          background: "color-mix(in srgb, #000 55%, transparent)",
          backdropFilter: "blur(6px)",
          color: "#fff",
          zIndex: 1,
        }}
      >
        <span
          style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: 650 }}
          title={preview.title || preview.alt}
        >
          {preview.title || preview.alt}
        </span>
        <button type="button" onClick={() => changeZoom(-ZOOM_STEP)} disabled={zoom <= MIN_ZOOM} aria-label={t("message_zoomOut")} title={t("message_zoomOut")} style={{ ...overlayControlStyle, opacity: zoom <= MIN_ZOOM ? 0.45 : 1 }}>
          <Minus size={14} strokeWidth={1.9} aria-hidden="true" />
        </button>
        <button type="button" onClick={resetView} aria-label={t("message_resetZoom")} title={t("message_resetZoom")} style={{ ...overlayControlStyle, minWidth: 48, fontSize: 11 }}>
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" onClick={() => changeZoom(ZOOM_STEP)} disabled={zoom >= MAX_ZOOM} aria-label={t("message_zoomIn")} title={t("message_zoomIn")} style={{ ...overlayControlStyle, opacity: zoom >= MAX_ZOOM ? 0.45 : 1 }}>
          <Plus size={14} strokeWidth={1.9} aria-hidden="true" />
        </button>
        <button type="button" onClick={resetView} aria-label={t("message_resetZoom")} title={t("message_resetZoom")} style={overlayControlStyle}>
          <RotateCcw size={14} strokeWidth={1.9} aria-hidden="true" />
        </button>
        {downloaded && saveAsPath ? (
          <button
            type="button"
            onClick={() => setSaveAsOpen(true)}
            aria-label={t("message_saveImageAs")}
            title={t("message_saveImageAs")}
            style={{ ...overlayControlStyle, gap: 5, fontSize: 12 }}
          >
            <Download size={14} strokeWidth={1.9} aria-hidden="true" />
            <span className="hidden sm:inline">{t("message_saveImageAs")}</span>
          </button>
        ) : null}
        <a
          href={preview.downloadHref}
          download={preview.downloadName}
          onClick={() => { markImageDownloaded(preview.downloadHref); setDownloaded(true); }}
          aria-label={t("message_downloadImage")}
          title={t("message_downloadImage")}
          style={{ ...overlayControlStyle, gap: 5, textDecoration: "none", fontSize: 12, display: downloaded ? "none" : "inline-flex" }}
        >
          <Download size={14} strokeWidth={1.9} aria-hidden="true" />
          <span className="hidden sm:inline">{t("message_downloadImage")}</span>
        </a>
        <button type="button" onClick={closeImagePreview} aria-label={t("message_closeImage")} title={t("message_closeImage")} style={{ ...overlayControlStyle, fontSize: 20, lineHeight: 1 }}>
          ×
        </button>
      </div>

      {/* 图片区：占满遮罩剩余空间，只在这里处理缩放/拖动 */}
      <div
        ref={surfaceRef}
        role="group"
        aria-label={t("message_imageViewer")}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
        onClick={onSurfaceClick}
        onDoubleClick={() => (zoom > MIN_ZOOM ? resetView() : changeZoom(1))}
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "56px 12px 12px",
          overflow: "hidden",
          cursor: zoom > MIN_ZOOM ? "grab" : "zoom-in",
          touchAction: "none",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
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
      {saveAsPath ? (
        <SaveAsDialog
          open={saveAsOpen}
          sourcePath={saveAsPath}
          onClose={() => setSaveAsOpen(false)}
        />
      ) : null}
    </div>,
    document.body,
  );
}
