"use client";

import { useState, type ReactNode } from "react";
import { CHAT_COLUMN_MAX_WIDTH } from "@/lib/chat-column";
import { useI18n } from "@/lib/i18n";

export function ExtensionPanelChrome({
  title,
  accessibilityLabel,
  overlay = false,
  onClose,
  extraHeader,
  footer,
  children,
}: {
  title: ReactNode;
  accessibilityLabel?: string;
  overlay?: boolean;
  onClose?: () => void;
  extraHeader?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const titleText = accessibilityLabel ?? (typeof title === "string" ? title : undefined);
  // 展开/收回：面板正文（提问与选项/预览）常常比默认高度长，窄屏下面板又会盖住大半个页面，
  // 所以给一个显式的开关。**默认展开**——上限高不代表一定变高（高度仍由内容决定，短提问
  // 不会因此占满屏），但长提问默认就能看全，用户嫌大再收回。状态是每个面板自己的，不跨请求记忆。
  const [expanded, setExpanded] = useState(true);
  const className = [
    "extension-panel-shell",
    overlay ? "extension-panel-shell--overlay" : "",
    expanded ? "extension-panel-shell--expanded" : "",
  ].filter(Boolean).join(" ");
  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-label={titleText}
      className={className}
      style={{ width: `min(${CHAT_COLUMN_MAX_WIDTH}px, 100%)` }}
    >
      <header className="extension-panel-header">
        <div className="extension-panel-title">{title}</div>
        <div className="extension-panel-header-actions">
          {extraHeader}
          <button
            type="button"
            className="extension-card-btn"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={expanded ? t("extension_panelCollapse") : t("extension_panelExpand")}
          >
            {expanded ? t("extension_panelCollapse") : t("extension_panelExpand")}
          </button>
          {onClose ? (
            <button
              type="button"
              className="extension-card-btn"
              onClick={onClose}
              aria-label={t("chat_close")}
            >
              {t("chat_close")}
            </button>
          ) : null}
        </div>
      </header>
      <div className="extension-panel-body">{children}</div>
      {footer ? <footer className="extension-panel-footer">{footer}</footer> : null}
    </section>
  );
}

