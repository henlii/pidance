"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { PidanceUpdateCheck } from "@/lib/pidance-update";
import { usePidanceUpgrade } from "@/hooks/usePidanceUpgrade";
import { loadAutoUpdateCheck } from "@/lib/ui-preferences";
import { UpgradeOverlay } from "./UpgradeOverlay";

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
 * 打开页面自动检测 Pidance 版本；有更新时右下角气泡提示。
 * 一键升级与关于页共用 usePidanceUpgrade（等服务就绪再刷新）。
 */
export function UpdateBanner() {
  const { t } = useI18n();
  const [check, setCheck] = useState<PidanceUpdateCheck | null>(null);
  const [visible, setVisible] = useState(false);
  const { overlay, progress, resultMsg, doneOk, run, close } = usePidanceUpgrade();

  useEffect(() => {
    if (!loadAutoUpdateCheck()) return;
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

  const dismiss = () => {
    if (check?.latestVersion) markDismissed(check.latestVersion);
    setVisible(false);
  };

  const upgrade = async () => {
    if (!check?.updateAvailable || !check.latestVersion) return;
    setVisible(false);
    const outcome = await run(check.latestVersion);
    if (outcome.ok) markDismissed(check.latestVersion);
    else setVisible(true);
  };

  const color = "var(--accent)";

  return (
    <>
      {visible && check?.updateAvailable && check.latestVersion && !overlay && (
        <div
          role="status"
          className="notice-shelf-item"
          style={{
            position: "fixed",
            bottom: 16,
            right: 16,
            zIndex: 260,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            width: "min(100% - 24px, 360px)",
            padding: "10px 12px",
            borderRadius: 10,
            border: `1px solid color-mix(in srgb, ${color} 42%, var(--border))`,
            borderLeft: `3px solid ${color}`,
            background: `color-mix(in srgb, ${color} 10%, var(--bg-panel))`,
            boxShadow: "0 12px 32px color-mix(in srgb, var(--text) 16%, transparent)",
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
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            {check.upgradeSupported && (
              <button
                type="button"
                onClick={() => { void upgrade(); }}
                style={{
                  padding: "6px 12px",
                  borderRadius: 8,
                  border: "none",
                  background: "var(--accent)",
                  color: "#fff",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {t("about_upgradeNow")}
              </button>
            )}
          </div>
        </div>
      )}

      {overlay && (
        <UpgradeOverlay
          currentVersion={check?.currentVersion}
          latestVersion={check?.latestVersion}
          progress={progress}
          resultMsg={resultMsg}
          doneOk={doneOk}
          onReload={() => { window.location.reload(); }}
          onClose={() => {
            close();
            setVisible(true);
          }}
        />
      )}
    </>
  );
}
