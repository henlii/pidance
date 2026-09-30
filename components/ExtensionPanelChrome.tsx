"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
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
  footerActions,
  footer,
  children,
  panelStyle,
  expanded: expandedProp,
  onExpandedChange,
}: {
  title: ReactNode;
  accessibilityLabel?: string;
  overlay?: boolean;
  extraHeader?: ReactNode;
  /**
   * 底栏**左侧**的动作区（「切回原样」「复制」这类控制按钮）。
   * 与右侧的主按钮（取消/提交）同一排：控制按钮左对齐、主按钮右对齐。
   */
  footerActions?: ReactNode;
  /** 底栏**右侧**的主按钮（取消 / 确认 / 提交）。 */
  footer?: ReactNode;
  children: ReactNode;
  /** 覆盖面板本体尺寸；半屏面板用它落实插件给的 width 差异。 */
  panelStyle?: CSSProperties;
  /**
   * 展开态受控：面板展开时会替代/挤占会话区（见 ChatWindow 的插槽布局），
   * 所以展开与否必须由持有布局的那一层知道。不传则退回组件内部 state。
   */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const { t } = useI18n();
  const titleText = accessibilityLabel ?? (typeof title === "string" ? title : undefined);
  // 默认展开——上限高不代表一定变高（高度仍由内容决定，短提问不会因此占满屏），
  // 长提问默认就能看全，用户嫌大点一下标题行收起。状态是每个面板自己的，不跨请求记忆。
  const [expandedLocal, setExpandedLocal] = useState(true);
  const expanded = expandedProp ?? expandedLocal;
  const toggle = () => {
    const next = !expanded;
    if (onExpandedChange) onExpandedChange(next);
    else setExpandedLocal(next);
  };
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
      style={{ width: CHAT_COLUMN_MAX_WIDTH_CSS, ...panelStyle }}
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
      {expanded && (footer || footerActions) ? (
        <footer className="extension-panel-footer">
          <div className="extension-panel-footer-actions">{footerActions}</div>
          <div className="extension-panel-footer-primary">{footer}</div>
        </footer>
      ) : null}
    </section>
  );
}
