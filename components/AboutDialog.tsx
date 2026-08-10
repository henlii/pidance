"use client";

import { useCallback, useEffect, useState } from "react";
import type { AboutInfo } from "@/lib/about-info";
import type { PidanceUpdateCheck } from "@/lib/pidance-update";
import { useI18n } from "@/lib/i18n";
import { ViewportDialog } from "./ui/ViewportDialog";

interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
}

/** next.config 构建期注入；客户端始终可读，不依赖 API。 */
function envVersion(key: "NEXT_PUBLIC_APP_VERSION" | "NEXT_PUBLIC_PI_VERSION"): string | undefined {
  const value = process.env[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed !== "unknown" ? trimmed : undefined;
}

type AboutViewState = {
  name: string;
  version?: string;
  piSdkVersion?: string;
  homepage?: string;
  repository?: string;
  runtimePiVersion?: string | null;
  agentRuntimeMode?: "inprocess" | "rpc";
  runtimeCompatible?: boolean;
};

function pickVersion(...candidates: Array<string | null | undefined>): string {
  for (const c of candidates) {
    if (typeof c === "string") {
      const t = c.trim();
      if (t) return t;
    }
  }
  return "—";
}

export function AboutDialog({ open, onClose }: AboutDialogProps) {
  const { t } = useI18n();
  // 立即用 env 占位，避免打开弹窗时版本空白；API 成功后再补仓库链接等字段。
  const [info, setInfo] = useState<AboutViewState>(() => ({
    name: "Pidance",
    version: envVersion("NEXT_PUBLIC_APP_VERSION"),
    piSdkVersion: envVersion("NEXT_PUBLIC_PI_VERSION"),
    homepage: "https://github.com/henlii/pidance#readme",
    repository: "https://github.com/henlii/pidance",
  }));
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<PidanceUpdateCheck | null>(null);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/about", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as AboutInfo;
        if (cancelled) return;
        setInfo((prev) => ({
          name: data.name || prev.name || "Pidance",
          // API 优先，env 回退
          version: data.version || prev.version || envVersion("NEXT_PUBLIC_APP_VERSION"),
          piSdkVersion: data.piSdkVersion || prev.piSdkVersion || envVersion("NEXT_PUBLIC_PI_VERSION"),
          homepage: data.homepage || prev.homepage,
          repository: data.repository || prev.repository,
          runtimePiVersion: data.runtimePiVersion ?? prev.runtimePiVersion,
          agentRuntimeMode: data.agentRuntimeMode ?? prev.agentRuntimeMode,
          runtimeCompatible: data.runtimeCompatible ?? prev.runtimeCompatible,
        }));
      } catch {
        // best-effort：保留 env 版本
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);


  const runCheckUpdate = useCallback(async () => {
    setUpdateChecking(true);
    setUpdateMessage(null);
    try {
      const res = await fetch("/api/update/check", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as PidanceUpdateCheck;
      setUpdateInfo(data);
      if (!data.updateAvailable) {
        setUpdateMessage(t("about_upToDate", { version: data.currentVersion }));
      } else {
        setUpdateMessage(
          t("about_updateAvailable", {
            current: data.currentVersion,
            latest: data.latestVersion ?? "?",
          }),
        );
      }
    } catch (e) {
      setUpdateMessage(t("about_upgradeFailed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setUpdateChecking(false);
    }
  }, [t]);

  const runUpgrade = useCallback(async () => {
    if (!updateInfo?.updateAvailable) return;
    setUpdateBusy(true);
    setUpdateMessage(null);
    try {
      const res = await fetch("/api/update/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: updateInfo.latestVersion }),
      });
      const data = (await res.json()) as { ok?: boolean; status?: string; message?: string; targetVersion?: string | null };
      if (data.ok && (data.status === "upgraded" || data.status === "already_latest")) {
        setUpdateMessage(t("about_upgradeDone", { version: data.targetVersion ?? updateInfo.latestVersion ?? "" }));
      } else if (data.status === "not_supported") {
        setUpdateMessage(t("about_upgradeNotSupported"));
      } else {
        setUpdateMessage(t("about_upgradeFailed", { message: data.message || res.statusText }));
      }
    } catch (e) {
      setUpdateMessage(t("about_upgradeFailed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setUpdateBusy(false);
    }
  }, [t, updateInfo]);

  const githubUrl = info.repository ?? info.homepage ?? "https://github.com/henlii/pidance";
  const deckVersion = pickVersion(info.version, envVersion("NEXT_PUBLIC_APP_VERSION"));
  const piVersion = pickVersion(info.piSdkVersion, envVersion("NEXT_PUBLIC_PI_VERSION"));
  const runtimeVersion = pickVersion(info.runtimePiVersion, info.piSdkVersion);
  const runtimeMode = info.agentRuntimeMode ?? "inprocess";

  return (
    <ViewportDialog
      open={open}
      onClose={onClose}
      title={t("about_title")}
      width={360}
      closeLabel={t("close")}
      contentPadding="20px 22px 22px"
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          gap: 14,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/pidance-logo.png"
          alt=""
          width={64}
          height={64}
          style={{
            width: 64,
            height: 64,
            borderRadius: 14,
            objectFit: "contain",
            flexShrink: 0,
          }}
        />

        <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%" }}>
          <div style={{ fontSize: 17, fontWeight: 650, color: "var(--text)", letterSpacing: "-0.01em" }}>
            Pidance
          </div>
          {/* 版本行固定两行：Deck + Pi，不因加载态隐藏 */}
          <div
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              lineHeight: 1.65,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <div>{t("about_version", { version: deckVersion })}</div>
            <div>{t("about_piSdkVersion", { version: piVersion })}</div>
            <div>{t("about_runtimeMode", { mode: runtimeMode })}</div>
            {runtimeMode === "rpc" && (
              <div>{t("about_runtimePiVersion", { version: runtimeVersion })}</div>
            )}
            {runtimeMode === "rpc" && info.runtimeCompatible === false && (
              <div style={{ color: "var(--text-muted)" }}>{t("about_runtimeIncompatible")}</div>
            )}
          </div>
        </div>


        <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%", alignItems: "center" }}>
          <button
            type="button"
            disabled={updateChecking || updateBusy}
            onClick={() => { void runCheckUpdate(); }}
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text)",
              fontSize: 12,
              fontWeight: 600,
              cursor: updateChecking || updateBusy ? "wait" : "pointer",
            }}
          >
            {updateChecking ? t("about_checkingUpdate") : t("about_checkUpdate")}
          </button>
          {updateMessage && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5, maxWidth: 280 }}>
              {updateMessage}
              {updateInfo && !updateInfo.upgradeSupported && updateInfo.updateAvailable && (
                <div style={{ marginTop: 4, color: "var(--text-dim)" }}>{t("update_bannerWorkspace")}</div>
              )}
            </div>
          )}
          {updateInfo?.updateAvailable && updateInfo.upgradeSupported && (
            <button
              type="button"
              disabled={updateBusy}
              onClick={() => { void runUpgrade(); }}
              style={{
                padding: "6px 14px",
                borderRadius: 8,
                border: "none",
                background: "var(--accent)",
                color: "#fff",
                fontSize: 12,
                fontWeight: 600,
                cursor: updateBusy ? "wait" : "pointer",
                opacity: updateBusy ? 0.7 : 1,
              }}
            >
              {updateBusy ? t("about_upgrading") : t("about_upgradeNow")}
            </button>
          )}
        </div>

        <a
          href={githubUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: "var(--text-muted)",
            textDecoration: "none",
            padding: "4px 8px",
            borderRadius: 6,
            transition: "color 0.12s, background 0.12s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--text)";
            e.currentTarget.style.background = "var(--bg-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--text-muted)";
            e.currentTarget.style.background = "transparent";
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.936.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.749 0 .267.18.579.688.481C19.138 20.163 22 16.416 22 12c0-5.523-4.477-10-10-10Z" />
          </svg>
          <span>{t("about_github")}</span>
        </a>

        <p
          style={{
            margin: 0,
            fontSize: 11,
            color: "var(--text-dim)",
            lineHeight: 1.5,
            maxWidth: 260,
          }}
        >
          {t("about_footerNote")}
        </p>
      </div>
    </ViewportDialog>
  );
}
