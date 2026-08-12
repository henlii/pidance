"use client";

import type { CSSProperties, ReactNode } from "react";
import { useI18n } from "@/lib/i18n";

/** 设置页主操作按钮（保存等） */
export function settingsPrimaryButtonStyle(enabled: boolean): CSSProperties {
  return {
    minHeight: 32,
    padding: "0 14px",
    borderRadius: 7,
    border: `1px solid ${enabled ? "var(--accent)" : "var(--border)"}`,
    background: enabled ? "var(--accent)" : "var(--bg-panel)",
    color: enabled ? "var(--accent-foreground)" : "var(--text-muted)",
    cursor: enabled ? "pointer" : "not-allowed",
    fontSize: 12,
    fontWeight: 600,
    opacity: enabled ? 1 : 0.65,
  };
}

/** 设置页次要按钮（校验/刷新/关闭等） */
export function settingsSecondaryButtonStyle(enabled = true): CSSProperties {
  return {
    minHeight: 32,
    padding: "0 12px",
    borderRadius: 7,
    border: "1px solid var(--border)",
    background: "var(--bg-panel)",
    color: "var(--text-muted)",
    cursor: enabled ? "pointer" : "not-allowed",
    fontSize: 12,
    opacity: enabled ? 1 : 0.65,
  };
}

/** 危险图标按钮（移除等） */
export function settingsDangerIconButtonStyle(enabled = true): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 32,
    height: 32,
    padding: 0,
    borderRadius: 7,
    border: "1px solid var(--border)",
    background: "var(--bg-panel)",
    color: "var(--status-danger)",
    cursor: enabled ? "pointer" : "not-allowed",
    opacity: enabled ? 1 : 0.55,
  };
}

/**
 * 设置页统一底部栏：
 * - 左侧两行提示（固定路径/常驻提示 + 动态校验/保存结果）
 * - 右侧操作按钮，关闭在最右
 */
export function SettingsPageFooter({
  fixedHint,
  dynamicHint,
  children,
  onClose,
  closeLabel,
}: {
  fixedHint?: ReactNode;
  dynamicHint?: ReactNode;
  children?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        flexShrink: 0,
        padding: "10px 20px 14px",
        borderTop: "1px solid var(--border)",
        background: "var(--bg)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div
        style={{
          flex: "1 1 160px",
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 2,
          justifyContent: "center",
          // 固定两行高度，避免各页底部栏因提示有无而跳动
          minHeight: 36,
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: "var(--text-dim)",
            fontFamily: "var(--font-mono)",
            lineHeight: 1.4,
            minHeight: 16,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={typeof fixedHint === "string" ? fixedHint : undefined}
        >
          {fixedHint != null && fixedHint !== "" ? fixedHint : "\u00a0"}
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.4, minHeight: 16 }}>
          {dynamicHint != null && dynamicHint !== "" ? dynamicHint : "\u00a0"}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          marginLeft: "auto",
          flexShrink: 0,
        }}
      >
        {children}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            style={settingsSecondaryButtonStyle(true)}
          >
            {closeLabel ?? t("dialog_close")}
          </button>
        )}
      </div>
    </div>
  );
}

