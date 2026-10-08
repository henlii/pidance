"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, Download, File } from "lucide-react";
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

const labelStyle = {
  minWidth: 0,
  flex: 1,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

/**
 * 媒体卡片标题行：折叠时它就是整块（只剩这一行），展开时右侧照旧有下载入口。
 *
 * 只有 `collapsible`（智能体自记的 pidance.binary）才给折叠入口；用户自己发的附件
 * 是「用户消息」的一部分，按产品口径不折叠也不限高。
 */
function BinaryCardHeader({
  name,
  label,
  downloadUrl,
  icon,
  collapsible,
  expanded,
  onToggle,
}: {
  name: string;
  label: string;
  downloadUrl: string;
  icon?: ReactNode;
  collapsible: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const toggleLabel = expanded ? t("message_collapse") : t("message_expand");
  const labelNode = (
    <span style={labelStyle} title={name}>
      {label}
    </span>
  );

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      {collapsible ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          title={`${name} · ${toggleLabel}`}
          aria-label={`${name} · ${toggleLabel}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            flex: 1,
            minWidth: 0,
            padding: 0,
            border: "none",
            background: "none",
            color: "inherit",
            font: "inherit",
            textAlign: "left",
            cursor: "pointer",
          }}
        >
          <ChevronDown
            size={12}
            strokeWidth={1.8}
            aria-hidden="true"
            style={{
              flexShrink: 0,
              transform: expanded ? "none" : "rotate(-90deg)",
              transition: "transform 0.15s ease",
            }}
          />
          {labelNode}
        </button>
      ) : (
        <>
          {icon}
          {labelNode}
        </>
      )}
      <a href={downloadUrl} download={name} style={downloadStyle} aria-label={t("message_downloadOriginal")}>
        <Download size={13} strokeWidth={1.9} aria-hidden="true" />
        {t("message_downloadOriginal")}
      </a>
    </div>
  );
}

export function BinaryMessageView({
  binary,
  collapsible = false,
}: {
  binary: BinaryMessageData;
  /** 智能体自记的二进制消息：默认收起，展开才加载/播放媒体。 */
  collapsible?: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(!collapsible);
  const readUrl = fileApiUrl(binary.path, "read", binary.mimeType, true);
  const downloadUrl = fileApiUrl(binary.path, "download");
  const canPlay = binary.size <= DIRECT_MEDIA_PLAY_MAX_BYTES;
  const label = `${binary.name} · ${formatBinarySize(binary.size)}`;
  const toggle = () => setExpanded((value) => !value);
  const header = (
    <BinaryCardHeader
      name={binary.name}
      label={label}
      downloadUrl={downloadUrl}
      collapsible={collapsible}
      expanded={expanded}
      onToggle={toggle}
    />
  );

  if (binary.kind === "image") {
    const thumbnailPath = binary.previewPath || binary.path;
    const image = (
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
    );
    if (!collapsible) {
      return <div style={{ marginBottom: 8, maxWidth: "100%" }}>{image}</div>;
    }
    return (
      <div style={{ ...cardStyle, flexDirection: "column", alignItems: "stretch", marginBottom: 8 }}>
        {header}
        {expanded && <div style={{ marginTop: 6 }}>{image}</div>}
      </div>
    );
  }

  if (binary.kind === "audio") {
    return (
      <div style={{ ...cardStyle, flexDirection: collapsible ? "column" : "row", alignItems: collapsible ? "stretch" : "center", maxWidth: 480, marginBottom: 8 }}>
        {header}
        {expanded && (
          canPlay ? (
            <audio controls preload="metadata" src={readUrl} style={{ width: "100%" }} />
          ) : (
            <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("message_mediaTooLargeToPlay")}</div>
          )
        )}
      </div>
    );
  }

  if (binary.kind === "video") {
    return (
      <div style={{ ...cardStyle, flexDirection: collapsible ? "column" : "row", alignItems: collapsible ? "stretch" : "center", maxWidth: 640, marginBottom: 8 }}>
        {header}
        {expanded && (
          canPlay ? (
            <video controls preload="metadata" src={readUrl} style={{ display: "block", width: "100%", maxHeight: 360, borderRadius: 5, background: "var(--bg)", border: "1px solid var(--border)" }} />
          ) : (
            <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("message_mediaTooLargeToPlay")}</div>
          )
        )}
      </div>
    );
  }

  return (
    <div style={{ ...cardStyle, marginBottom: 8 }}>
      <BinaryCardHeader
        name={binary.name}
        label={label}
        downloadUrl={downloadUrl}
        icon={<File size={15} strokeWidth={1.8} color="var(--text-dim)" aria-hidden="true" />}
        collapsible={collapsible}
        expanded={expanded}
        onToggle={toggle}
      />
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
