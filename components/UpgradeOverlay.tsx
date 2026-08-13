"use client";

import { useI18n } from "@/lib/i18n";
import type { UpgradePhase } from "@/lib/pidance-update";
import type { UpgradeProgressState } from "@/lib/pidance-update-client";

interface UpgradeOverlayProps {
  currentVersion?: string | null;
  latestVersion?: string | null;
  progress: UpgradeProgressState | null;
  resultMsg: string | null;
  doneOk: boolean | null;
  onReload: () => void;
  onClose: () => void;
}

function phaseLabelKey(
  phase: UpgradePhase,
):
  | "update_phasePreparing"
  | "update_phaseDownloading"
  | "update_phaseInstalling"
  | "update_phaseLinking"
  | "update_phaseRestarting"
  | "update_phaseWaiting"
  | "update_phaseDone"
  | "update_phaseError" {
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
    case "waiting":
      return "update_phaseWaiting";
    case "done":
      return "update_phaseDone";
    case "error":
    default:
      return "update_phaseError";
  }
}

/** 一键升级全屏阶段遮罩（关于页与打开页横幅共用）。 */
export function UpgradeOverlay({
  currentVersion,
  latestVersion,
  progress,
  resultMsg,
  doneOk,
  onReload,
  onClose,
}: UpgradeOverlayProps) {
  const { t } = useI18n();
  const busy = doneOk === null;

  return (
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
        {(currentVersion || latestVersion) && (
          <div style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
            {currentVersion} → {latestVersion}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center", textAlign: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 650, color: "var(--text)" }}>
            {progress ? t(phaseLabelKey(progress.phase)) : t("update_phasePreparing")}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55, minHeight: 36, maxWidth: 320 }}>
            {progress?.message || t("update_phasePreparing")}
          </div>
          {busy && (
            <div
              aria-hidden="true"
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                border: "2px solid var(--border)",
                borderTopColor: "var(--accent)",
                animation: "sidebar-running-spin 0.9s linear infinite",
              }}
            />
          )}
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
                onClick={onReload}
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
                onClick={onClose}
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
  );
}
