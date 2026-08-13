"use client";

import { useCallback, useState } from "react";
import { useI18n } from "@/lib/i18n";
import {
  runPidanceUpgrade,
  type UpgradeProgressState,
} from "@/lib/pidance-update-client";

/**
 * 关于页与右下角横幅共用的一键升级：遮罩进度 → 等服务就绪 → 刷新页面。
 */
export function usePidanceUpgrade() {
  const { t } = useI18n();
  const [overlay, setOverlay] = useState(false);
  const [progress, setProgress] = useState<UpgradeProgressState | null>(null);
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const [doneOk, setDoneOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const close = useCallback(() => {
    setOverlay(false);
    setProgress(null);
    setResultMsg(null);
    setDoneOk(null);
  }, []);

  const run = useCallback(async (version: string) => {
    setBusy(true);
    setOverlay(true);
    setDoneOk(null);
    setResultMsg(null);
    setProgress({ phase: "preparing", percent: 3, message: t("update_phasePreparing") });
    try {
      const finalResult = await runPidanceUpgrade(version, setProgress);
      const ok = Boolean(
        finalResult.ok && (finalResult.status === "upgraded" || finalResult.status === "already_latest"),
      );
      setDoneOk(ok);
      if (ok) {
        const doneText = t("about_upgradeDone", {
          version: finalResult.targetVersion ?? version,
        });
        setProgress({ phase: "done", percent: 100, message: doneText });
        setResultMsg(doneText);
        window.location.reload();
        return { ok: true as const, message: doneText };
      }
      const msg =
        finalResult.status === "not_supported"
          ? t("about_upgradeNotSupported")
          : t("about_upgradeFailed", { message: finalResult.message });
      setProgress({ phase: "error", percent: 100, message: finalResult.message });
      setResultMsg(msg);
      return { ok: false as const, message: msg, status: finalResult.status };
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const msg = t("about_upgradeFailed", { message: raw });
      setDoneOk(false);
      setProgress({ phase: "error", percent: 100, message: raw });
      setResultMsg(msg);
      return { ok: false as const, message: msg };
    } finally {
      setBusy(false);
    }
  }, [t]);

  return { overlay, progress, resultMsg, doneOk, busy, run, close };
}
