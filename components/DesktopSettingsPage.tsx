"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import {
  DESKTOP_SETTING_KEYS,
  normalizeDesktopSettings,
  type DesktopBridge,
  type DesktopSettingKey,
  type DesktopSettings,
} from "@/lib/desktop-bridge";

/**
 * 桌面版设置页（#51）。托盘菜单里的「桌面版设置…」会切到这一页。
 *
 * 开关本身由桌面壳保存（Electron `userData/desktop-settings.json`），**不写进 Pidance 配置**；
 * 页面只通过 preload 暴露的 `getSettings` / `setSetting` 读写，并自己做了乐观更新 + 失败回滚。
 */
const KEY_LABEL: Record<DesktopSettingKey, "desktop_openAtLogin" | "desktop_minimizeToTray" | "desktop_notifications"> = {
  openAtLogin: "desktop_openAtLogin",
  minimizeToTray: "desktop_minimizeToTray",
  notificationsEnabled: "desktop_notifications",
};

const sectionTitle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  marginBottom: 10,
};

export function DesktopSettingsPage({ bridge, onClose }: { bridge: DesktopBridge; onClose?: () => void }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void bridge
      .getSettings()
      .then((raw) => {
        if (!cancelled) setSettings(normalizeDesktopSettings(raw));
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(t("desktop_settingsLoadFailed", { error: e instanceof Error ? e.message : String(e) }));
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, t]);

  const toggle = useCallback(
    (key: DesktopSettingKey) => {
      setSettings((current) => {
        if (!current) return current;
        const next = !current[key];
        const optimistic: DesktopSettings = { ...current, [key]: next };
        setError(null);
        void bridge
          .setSetting(key, next)
          .then((raw) => {
            // 主进程会回写规范化后的完整快照；用它对齐（失败时下面的 catch 回滚）
            setSettings(normalizeDesktopSettings(raw));
          })
          .catch((e: unknown) => {
            setSettings(current); // 回滚乐观更新
            setError(t("desktop_settingSaveFailed", { error: e instanceof Error ? e.message : String(e) }));
          });
        return optimistic;
      });
    },
    [bridge, t],
  );

  return (
    <div style={{ padding: "4px 2px" }}>
      <div style={sectionTitle}>{t("desktop_pageTitle")}</div>
      <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>
        {t("desktop_pageHint")}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {DESKTOP_SETTING_KEYS.map((key) => (
          <label key={key} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14 }}>
            <input
              type="checkbox"
              checked={settings?.[key] ?? false}
              disabled={settings === null}
              aria-label={t(KEY_LABEL[key])}
              onChange={() => toggle(key)}
            />
            <span>{t(KEY_LABEL[key])}</span>
          </label>
        ))}
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
          {t("desktop_notificationsHint")}
        </div>
      </div>
      {error ? (
        <div role="alert" style={{ marginTop: 12, fontSize: 13, color: "var(--status-danger)" }}>{error}</div>
      ) : null}
      {onClose ? (
        <div style={{ marginTop: 18 }}>
          <button
            type="button"
            className="extension-card-btn"
            onClick={onClose}
            aria-label={t("chat_close")}
          >
            {t("chat_close")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
