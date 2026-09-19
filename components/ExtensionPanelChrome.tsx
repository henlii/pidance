"use client";

import type { ReactNode } from "react";
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
  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-label={titleText}
      className={overlay ? "extension-panel-shell extension-panel-shell--overlay" : "extension-panel-shell"}
      style={{ width: `min(${CHAT_COLUMN_MAX_WIDTH}px, 100%)` }}
    >
      <header className="extension-panel-header">
        <div className="extension-panel-title">{title}</div>
        <div className="extension-panel-header-actions">
          {extraHeader}
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

