"use client";

import { useState, type ReactNode } from "react";
import { CHAT_COLUMN_MAX_WIDTH_CSS } from "@/lib/chat-column";
import { useI18n } from "@/lib/i18n";

/**
 * 扩展面板外壳：标题行**整行可点**切折叠/展开（与工具块同一套交互），
 * 不再单独给「收起/展开」「关闭」按钮 —— 收起态只留一行标题，正文与底栏都不渲染。
 *
 * 折叠的是**整个扩展区**（面板本体），不是面板内的某一段。
 */
export function ExtensionPanelChrome({
  title,
  accessibilityLabel,
  overlay = false,
  extraHeader,
  footer,
  children,
}: {
  title: ReactNode;
  accessibilityLabel?: string;
  overlay?: boolean;
  extraHeader?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const titleText = accessibilityLabel ?? (typeof title === "string" ? title : undefined);
  // 默认展开——上限高不代表一定变高（高度仍由内容决定，短提问不会因此占满屏），
  // 长提问默认就能看全，用户嫌大点一下标题行收起。状态是每个面板自己的，不跨请求记忆。
  const [expanded, setExpanded] = useState(true);
  const toggle = () => setExpanded((value) => !value);
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
      style={{ width: CHAT_COLUMN_MAX_WIDTH_CSS }}
    >
      <header
        className="extension-panel-header"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={expanded ? t("extension_panelCollapse") : t("extension_panelExpand")}
        title={expanded ? t("extension_panelCollapse") : t("extension_panelExpand")}
        onClick={toggle}
        onKeyDown={(event) => {
          // 行内控件（复制等）自己处理按键；只有落在标题行本身上才切换
          if (event.key !== "Enter" && event.key !== " ") return;
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          toggle();
        }}
      >
        <span className={`extension-panel-chevron${expanded ? " is-expanded" : ""}`} aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 2.5 7.5 6 4 9.5" />
          </svg>
        </span>
        <div className="extension-panel-title">{title}</div>
        {extraHeader ? (
          <div className="extension-panel-header-actions" onClick={(event) => event.stopPropagation()}>
            {extraHeader}
          </div>
        ) : null}
      </header>
      {expanded ? <div className="extension-panel-body">{children}</div> : null}
      {expanded && footer ? <footer className="extension-panel-footer">{footer}</footer> : null}
    </section>
  );
}
