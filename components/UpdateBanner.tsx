"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { PidanceUpdateCheck } from "@/lib/pidance-update";
import {
  streamApplyPidanceUpdate,
  type UpgradeProgressState,
} from "@/lib/pidance-update-client";
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
 * 点击升级 → 全屏覆盖 + 阶段进度。
 */
export function UpdateBanner() {
  const { t } = useI18n();
  const [check, setCheck] = useState<PidanceUpdateCheck | null>(null);
  const [visible, setVisible] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const [progress, setProgress] = useState<UpgradeProgressState | null>(null);
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const [doneOk, setDoneOk] = useState<boolean | null>(null);

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

  // 不用 useCallback：依赖 check 切片时 React Compiler 会跳过 preserve-manual-memoization
  const dismiss = () => {
    if (check?.latestVersion) markDismissed(check.latestVersion);
    setVisible(false);
  };

  const upgrade = useCallback(async () => {
    if (!check?.updateAvailable || !check.latestVersion) return;
    setOverlay(true);
    setVisible(false);
    setDoneOk(null);
    setResultMsg(null);
    setProgress({ phase: "preparing", percent: 3, message: t("update_phasePreparing") });

    try {
      const finalResult = await streamApplyPidanceUpdate(check.latestVersion, setProgress);
      const ok = Boolean(finalResult.ok && (finalResult.status === "upgraded" || finalResult.status === "already_latest"));
      setDoneOk(ok);
      if (ok) {
        const doneText = t("about_upgradeDone", {
          version: finalResult.targetVersion ?? check.latestVersion,
        });
        setProgress({ phase: "done", percent: 100, message: doneText });
        setResultMsg(doneText);
        markDismissed(check.latestVersion);
        window.setTimeout(() => {
          window.location.reload();
        }, 1200);
      } else {
        setProgress({
          phase: "error",
          percent: 100,
          message: finalResult.message,
        });
        setResultMsg(
          finalResult.status === "not_supported"
            ? t("about_upgradeNotSupported")
            : t("about_upgradeFailed", { message: finalResult.message }),
        );
      }
    } catch (e) {
      setDoneOk(false);
      const msg = e instanceof Error ? e.message : String(e);
      setProgress({ phase: "error", percent: 100, message: msg });
      setResultMsg(t("about_upgradeFailed", { message: msg }));
    }
  }, [check, t]);

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
                {t("update_bannerUpgrade")}
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
            setOverlay(false);
            setProgress(null);
            setVisible(true);
          }}
        />
      )}
    </>
  );
}
