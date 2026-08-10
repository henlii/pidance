"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { PidanceUpdateCheck } from "@/lib/pidance-update";

type ApplyResult = {
  ok: boolean;
  status: string;
  message: string;
  targetVersion?: string | null;
};

const DISMISS_KEY_PREFIX = "pidance.update.dismissed.";

function dismissedKey(latest: string): string {
  return `${DISMISS_KEY_PREFIX}${latest}`;
}

function isDismissed(latest: string): boolean {
  try {
    return sessionStorage.getItem(dismissedKey(latest)) === "1";
  } catch {
    return false;
  }
}

function markDismissed(latest: string): void {
  try {
    sessionStorage.setItem(dismissedKey(latest), "1");
  } catch {
    /* ignore */
  }
}

/**
 * 打开页面自动检测 Pidance 版本；有更新时以消息条提示一键升级。
 * 同一 latest 版本在本会话 dismiss 后不再打扰。
 */
export function UpdateBanner() {
  const { t } = useI18n();
  const [check, setCheck] = useState<PidanceUpdateCheck | null>(null);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/update/check", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as PidanceUpdateCheck;
        if (cancelled) return;
        setCheck(data);
        if (data.updateAvailable && data.latestVersion && !isDismissed(data.latestVersion)) {
          setVisible(true);
        }
      } catch {
        /* best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = useCallback(() => {
    if (check?.latestVersion) markDismissed(check.latestVersion);
    setVisible(false);
  }, [check?.latestVersion]);

  const upgrade = useCallback(async () => {
    if (!check?.updateAvailable) return;
    setBusy(true);
    setResultMsg(null);
    try {
      const res = await fetch("/api/update/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: check.latestVersion }),
      });
      const data = (await res.json()) as ApplyResult;
      if (data.ok && (data.status === "upgraded" || data.status === "already_latest")) {
        setResultMsg(
          t("about_upgradeDone", { version: data.targetVersion ?? check.latestVersion ?? "" }),
        );
        if (check.latestVersion) markDismissed(check.latestVersion);
        // 正式位重启后连接会断；给用户读完提示的时间
        window.setTimeout(() => setVisible(false), 4000);
      } else {
        setResultMsg(
          data.status === "not_supported"
            ? t("about_upgradeNotSupported")
            : t("about_upgradeFailed", { message: data.message || res.statusText }),
        );
      }
    } catch (e) {
      setResultMsg(t("about_upgradeFailed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [check, t]);

  if (!visible || !check?.updateAvailable || !check.latestVersion) return null;

  const color = "var(--accent)";

  return (
    <div
      role="status"
      className="notice-shelf-item"
      style={{
        position: "fixed",
        top: 12,
        right: 12,
        zIndex: 80,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        width: "min(100% - 24px, 380px)",
        padding: "10px 12px",
        borderRadius: 10,
        border: `1px solid color-mix(in srgb, ${color} 42%, var(--border))`,
        borderLeft: `3px solid ${color}`,
        background: `color-mix(in srgb, ${color} 10%, var(--bg-panel))`,
        boxShadow: "0 12px 32px color-mix(in srgb, var(--text) 13%, transparent)",
        fontSize: 12,
        color: "var(--text)",
        pointerEvents: "auto",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontWeight: 650, fontSize: 13 }}>{t("update_bannerTitle")}</span>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t("update_bannerDismiss")}
          style={{
            border: "none",
            background: "transparent",
            color: "var(--text-dim)",
            cursor: "pointer",
            fontSize: 11,
            padding: "2px 4px",
          }}
        >
          {t("update_bannerDismiss")}
        </button>
      </div>
      <div style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
        {t("update_bannerBody", { current: check.currentVersion, latest: check.latestVersion })}
      </div>
      {!check.upgradeSupported && (
        <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("update_bannerWorkspace")}</div>
      )}
      {resultMsg && (
        <div style={{ color: "var(--text-muted)", fontSize: 11, whiteSpace: "pre-wrap" }}>{resultMsg}</div>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        {check.upgradeSupported && (
          <button
            type="button"
            disabled={busy}
            onClick={() => { void upgrade(); }}
            style={{
              padding: "6px 12px",
              borderRadius: 8,
              border: "none",
              background: "var(--accent)",
              color: "#fff",
              fontSize: 12,
              fontWeight: 600,
              cursor: busy ? "wait" : "pointer",
              opacity: busy ? 0.7 : 1,
            }}
          >
            {busy ? t("about_upgrading") : t("update_bannerUpgrade")}
          </button>
        )}
      </div>
    </div>
  );
}
