"use client";

import { Download, File } from "lucide-react";
import { MESSAGE_IMAGE_MAX_HEIGHT, MESSAGE_IMAGE_MAX_WIDTH, MessageImage } from "./MessageImage";
import { useI18n } from "@/lib/i18n";
import { encodeFilePathForApi } from "@/lib/file-paths";
import type { BinaryMessageData } from "@/lib/types";

/** 超过此大小的音视频不在会话内建立播放器，避免浏览器直接加载大文件。 */
export const DIRECT_MEDIA_PLAY_MAX_BYTES = 25 * 1024 * 1024;

function fileApiUrl(
  filePath: string,
  type: "read" | "download",
  mimeType?: string,
  messageMedia = false,
): string {
  const params = new URLSearchParams({ type });
  if (mimeType && type === "read") params.set("mime", mimeType);
  if (messageMedia) params.set("messageMedia", "1");
  return `/api/files/${encodeFilePathForApi(filePath)}?${params.toString()}`;
}

export function formatBinarySize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const cardStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
  maxWidth: "100%",
  padding: "7px 9px",
  border: "1px solid var(--border)",
  borderRadius: 7,
  background: "var(--bg-subtle)",
  color: "var(--text-muted)",
  fontSize: 12,
};

const downloadStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  flexShrink: 0,
  color: "var(--accent)",
  textDecoration: "underline",
  textUnderlineOffset: 2,
  fontSize: 11,
};

export function BinaryMessageView({ binary }: { binary: BinaryMessageData }) {
  const { t } = useI18n();
  const readUrl = fileApiUrl(binary.path, "read", binary.mimeType, true);
  const downloadUrl = fileApiUrl(binary.path, "download");
  const canPlay = binary.size <= DIRECT_MEDIA_PLAY_MAX_BYTES;
  const label = `${binary.name} · ${formatBinarySize(binary.size)}`;

  if (binary.kind === "image") {
    const thumbnailPath = binary.previewPath || binary.path;
    return (
      <div style={{ marginBottom: 8, maxWidth: "100%" }}>
        <MessageImage
          src={fileApiUrl(thumbnailPath, "read", binary.mimeType, true)}
          fullSrc={readUrl}
          downloadHref={downloadUrl}
          downloadName={binary.name}
          mimeType={binary.mimeType}
          alt={binary.name}
          title={binary.name}
          maxWidth={MESSAGE_IMAGE_MAX_WIDTH}
          maxHeight={MESSAGE_IMAGE_MAX_HEIGHT}
        />
      </div>
    );
  }

  if (binary.kind === "audio") {
    return (
      <div style={{ ...cardStyle, flexDirection: "column", alignItems: "stretch", maxWidth: 480, marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={binary.name}>{label}</span>
          <a href={downloadUrl} download={binary.name} style={downloadStyle} aria-label={t("message_downloadOriginal")}>
            <Download size={13} strokeWidth={1.9} aria-hidden="true" />
            {t("message_downloadOriginal")}
          </a>
        </div>
        {canPlay ? (
          <audio controls preload="metadata" src={readUrl} style={{ width: "100%" }} />
        ) : (
          <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("message_mediaTooLargeToPlay")}</div>
        )}
      </div>
    );
  }

  if (binary.kind === "video") {
    return (
      <div style={{ ...cardStyle, flexDirection: "column", alignItems: "stretch", maxWidth: 640, marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={binary.name}>{label}</span>
          <a href={downloadUrl} download={binary.name} style={downloadStyle} aria-label={t("message_downloadOriginal")}>
            <Download size={13} strokeWidth={1.9} aria-hidden="true" />
            {t("message_downloadOriginal")}
          </a>
        </div>
        {canPlay ? (
          <video controls preload="metadata" src={readUrl} style={{ display: "block", width: "100%", maxHeight: 360, borderRadius: 5, background: "var(--bg)", border: "1px solid var(--border)" }} />
        ) : (
          <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("message_mediaTooLargeToPlay")}</div>
        )}
      </div>
    );
  }

  return (
    <div style={{ ...cardStyle, marginBottom: 8 }}>
      <File size={15} strokeWidth={1.8} color="var(--text-dim)" aria-hidden="true" />
      <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={binary.name}>{label}</span>
      <a href={downloadUrl} download={binary.name} style={downloadStyle} aria-label={t("message_downloadOriginal")}>
        <Download size={13} strokeWidth={1.9} aria-hidden="true" />
        {t("message_downloadOriginal")}
      </a>
    </div>
  );
}

export function BinaryMessageGallery({ binaries }: { binaries: BinaryMessageData[] }) {
  if (binaries.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {binaries.map((binary, index) => (
        <BinaryMessageView key={`${binary.path}-${index}`} binary={binary} />
      ))}
    </div>
  );
}
