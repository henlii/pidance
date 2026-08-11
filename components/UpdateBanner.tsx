"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { PidanceUpdateCheck, UpgradePhase } from "@/lib/pidance-update";
import { loadAutoUpdateCheck } from "@/lib/ui-preferences";

type ApplyResult = {
  ok: boolean;
  status: string;
  message: string;
  targetVersion?: string | null;
};

type ProgressState = {
  phase: UpgradePhase;
  percent: number;
  message: string;
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

function phaseLabelKey(phase: UpgradePhase): "update_phasePreparing" | "update_phaseDownloading" | "update_phaseInstalling" | "update_phaseLinking" | "update_phaseRestarting" | "update_phaseDone" | "update_phaseError" {
  switch (phase) {
    case "preparing":
      return "update_phasePreparing";
    case "downloading":
      return "update_phaseDownloading";
    case "installing":
      return "update_phaseInstalling";
    case "linking":
      return "update_phaseLinking";
    case "restarting":
      return "update_phaseRestarting";
    case "done":
      return "update_phaseDone";
    case "error":
    default:
      return "update_phaseError";
  }
}

/**
 * 打开页面自动检测 Pidance 版本；有更新时右下角气泡提示。
 * 点击升级 → 全屏覆盖 + 阶段进度条。
 */
export function UpdateBanner() {
  const { t } = useI18n();
  const [check, setCheck] = useState<PidanceUpdateCheck | null>(null);
  const [visible, setVisible] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
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

  const dismiss = useCallback(() => {
    if (check?.latestVersion) markDismissed(check.latestVersion);
    setVisible(false);
  }, [check?.latestVersion]);

  const upgrade = useCallback(async () => {
    if (!check?.updateAvailable || !check.latestVersion) return;
    setOverlay(true);
    setVisible(false);
    setDoneOk(null);
    setResultMsg(null);
    setProgress({ phase: "preparing", percent: 3, message: t("update_phasePreparing") });

    try {
      const res = await fetch("/api/update/apply?stream=1", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ version: check.latestVersion, stream: true }),
      });

      if (!res.ok || !res.body) {
        // 回退 JSON
        const data = (await res.json().catch(() => null)) as ApplyResult | null;
        setDoneOk(false);
        setProgress({ phase: "error", percent: 100, message: data?.message || `HTTP ${res.status}` });
        setResultMsg(
          data?.status === "not_supported"
            ? t("about_upgradeNotSupported")
            : t("about_upgradeFailed", { message: data?.message || res.statusText }),
        );
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let finalResult: ApplyResult | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const chunks = buf.split("\n\n");
        buf = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            const payload = JSON.parse(line.slice(6)) as {
              type?: string;
              phase?: UpgradePhase;
              percent?: number;
              message?: string;
              result?: ApplyResult;
            };
            if (payload.type === "progress" && payload.phase) {
              setProgress({
                phase: payload.phase,
                percent: typeof payload.percent === "number" ? payload.percent : 0,
                message: payload.message || t(phaseLabelKey(payload.phase)),
              });
            } else if (payload.type === "result" && payload.result) {
              finalResult = payload.result;
            }
          } catch {
            /* ignore bad frame */
          }
        }
      }

      if (finalResult) {
        const ok = Boolean(finalResult.ok && (finalResult.status === "upgraded" || finalResult.status === "already_latest"));
        setDoneOk(ok);
        if (ok) {
          setProgress({
            phase: "done",
            percent: 100,
            message: t("about_upgradeDone", {
              version: finalResult.targetVersion ?? check.latestVersion,
            }),
          });
          setResultMsg(
            t("about_upgradeDone", {
              version: finalResult.targetVersion ?? check.latestVersion,
            }),
          );
          markDismissed(check.latestVersion);
          // 服务重启后页面可能断开；提示用户稍后刷新
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
      }
    } catch (e) {
      setDoneOk(false);
      const msg = e instanceof Error ? e.message : String(e);
      setProgress({ phase: "error", percent: 100, message: msg });
      setResultMsg(t("about_upgradeFailed", { message: msg }));
    }
  }, [check, t]);

  const color = "var(--accent)";
  const pct = Math.max(0, Math.min(100, progress?.percent ?? 0));
  const busy = overlay && doneOk === null;

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
        <div
          role="alertdialog"
          aria-modal="true"
          aria-busy={busy}
          aria-label={t("update_overlayTitle")}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 400,
            background: "color-mix(in srgb, var(--bg) 72%, #000)",
            backdropFilter: "blur(6px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <div
            style={{
              width: "min(100%, 420px)",
              borderRadius: 14,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              boxShadow: "0 20px 48px color-mix(in srgb, var(--text) 18%, transparent)",
              padding: "28px 24px 22px",
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", textAlign: "center" }}>
              {t("update_overlayTitle")}
            </div>
            {check && (
              <div style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
                {check.currentVersion} → {check.latestVersion}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text)" }}>
                <span>{progress ? t(phaseLabelKey(progress.phase)) : t("update_phasePreparing")}</span>
                <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--text-muted)" }}>{Math.round(pct)}%</span>
              </div>
              <div
                style={{
                  height: 10,
                  borderRadius: 999,
                  background: "var(--bg-hover)",
                  overflow: "hidden",
                  border: "1px solid var(--border)",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${pct}%`,
                    borderRadius: 999,
                    background:
                      progress?.phase === "error"
                        ? "var(--status-danger)"
                        : progress?.phase === "done"
                          ? "var(--status-success)"
                          : "var(--accent)",
                    transition: "width 0.35s ease",
                  }}
                />
              </div>
              <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5, minHeight: 32 }}>
                {progress?.message || t("update_phasePreparing")}
              </div>
            </div>

            {resultMsg && doneOk !== null && (
              <div
                style={{
                  fontSize: 12,
                  color: doneOk ? "var(--status-success)" : "var(--status-danger)",
                  textAlign: "center",
                  whiteSpace: "pre-wrap",
                }}
              >
                {resultMsg}
                {doneOk && (
                  <div style={{ marginTop: 6, color: "var(--text-dim)", fontSize: 11 }}>
                    {t("update_reloadHint")}
                  </div>
                )}
              </div>
            )}

            {doneOk !== null && (
              <div style={{ display: "flex", justifyContent: "center", gap: 8 }}>
                {doneOk ? (
                  <button
                    type="button"
                    onClick={() => { window.location.reload(); }}
                    style={{
                      padding: "8px 16px",
                      borderRadius: 8,
                      border: "none",
                      background: "var(--accent)",
                      color: "#fff",
                      fontWeight: 600,
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    {t("update_reload")}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setOverlay(false);
                      setProgress(null);
                      setVisible(true);
                    }}
                    style={{
                      padding: "8px 16px",
                      borderRadius: 8,
                      border: "1px solid var(--border)",
                      background: "var(--bg)",
                      color: "var(--text)",
                      fontWeight: 600,
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    {t("close")}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
