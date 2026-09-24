"use client";

/**
 * 「可用模型」面板：每模型启用开关 + 刷新模型目录。
 *
 * 数据来自 `GET /api/models/enabled`（**未过滤**的完整目录 + 当前 enabledModels）——
 * `GET /api/models` 返回的是已过滤列表，被关掉的模型不在里面，没法显示成「关」。
 *
 * 只读条件（面板进入只读并给出说明）：项目级 settings.json 覆盖了该键、
 * 或全局 settings.json 解析失败（服务端会拒绝写，界面不能假装能改）。
 *
 * 开关的写入语义在服务端（lib/enabled-models-store.ts）：最小编辑，只动 enabledModels。
 */

import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useIsMobile } from "@/hooks/useIsMobile";

interface EnabledModelEntry {
  ref: string;
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
}

interface EnabledModelsPayload {
  enabledModels: string[] | null;
  projectOverride: boolean;
  unreadable: boolean;
  models: EnabledModelEntry[];
}

export function EnabledModelsPanel({ onModelsChanged, cwd }: { onModelsChanged?: () => void; cwd?: string }) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  // 服务端靠 cwd 解析项目级 settings.json（只读判定）与项目扩展；不带就是服务端 process.cwd()。
  const cwdQuery = cwd && cwd.trim() !== "" ? `?cwd=${encodeURIComponent(cwd)}` : "";
  const [payload, setPayload] = useState<EnabledModelsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingRef, setPendingRef] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/models/enabled${cwdQuery}`, { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as EnabledModelsPayload & { error?: string };
      if (!res.ok) {
        setLoadError(typeof data.error === "string" && data.error ? data.error : `HTTP ${res.status}`);
        setPayload(null);
        return;
      }
      setLoadError(null);
      setPayload({
        enabledModels: data.enabledModels ?? null,
        projectOverride: data.projectOverride === true,
        unreadable: data.unreadable === true,
        models: Array.isArray(data.models) ? data.models : [],
      });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, [cwdQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  const readOnly = payload?.projectOverride === true || payload?.unreadable === true;

  const toggle = useCallback(
    async (entry: EnabledModelEntry, enabled: boolean) => {
      setPendingRef(entry.ref);
      setMessage(null);
      try {
        const res = await fetch(`/api/models/enabled${cwdQuery}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ref: entry.ref, enabled }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        if (!res.ok) {
          // 409 + last-model：不允许把最后一个模型关掉（enabledModels 空数组 = 不过滤）
          setMessage({
            kind: "error",
            text:
              data.code === "last-model"
                ? t("models_lastModelHint")
                : (data.error ?? `HTTP ${res.status}`),
          });
          return;
        }
        // 以服务端为准重新拉一次：开关结果与过滤口径由服务端说了算
        await load();
        onModelsChanged?.();
      } catch (error) {
        setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      } finally {
        setPendingRef(null);
      }
    },
    [cwdQuery, load, onModelsChanged, t],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setMessage(null);
    try {
      const res = await fetch("/api/models/refresh", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setMessage({
          kind: "error",
          text: t("models_refreshFailed", { error: data.error ?? `HTTP ${res.status}` }),
        });
        return;
      }
      await load();
      onModelsChanged?.();
      setMessage({ kind: "ok", text: t("models_refreshDone") });
    } catch (error) {
      setMessage({
        kind: "error",
        text: t("models_refreshFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      });
    } finally {
      setRefreshing(false);
    }
  }, [load, onModelsChanged, t]);

  const enabledCount = payload?.models.filter((m) => m.enabled).length ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "12px 16px 16px", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 200px", minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{t("models_availableTitle")}</div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4, lineHeight: 1.5 }}>
            {t("models_availableHint")}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "7px 12px",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: refreshing ? "var(--text-dim)" : "var(--text)",
            fontSize: 12,
            cursor: refreshing ? "default" : "pointer",
            // 触摸目标：窄屏（手机）上按钮必须够大，桌面保持紧凑
            minHeight: isMobile ? 44 : 36,
          }}
        >
          {refreshing ? <LoaderCircle size={13} className="animate-spin" aria-hidden /> : <RefreshCw size={13} />}
          {refreshing ? t("models_refreshing") : t("models_refreshCatalog")}
        </button>
      </div>

      {readOnly && (
        <div
          role="status"
          style={{
            fontSize: 11,
            lineHeight: 1.5,
            padding: "8px 10px",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--border)",
            background: "var(--bg-subtle)",
            color: "var(--text-muted)",
          }}
        >
          {payload?.unreadable
            ? t("models_availableReadOnlyUnreadable")
            : t("models_availableReadOnlyProject")}
        </div>
      )}

      {message && (
        <div
          role={message.kind === "error" ? "alert" : "status"}
          style={{
            fontSize: 11,
            lineHeight: 1.5,
            padding: "8px 10px",
            borderRadius: "var(--radius-md)",
            border: `1px solid ${message.kind === "error" ? "var(--status-danger-border)" : "var(--border)"}`,
            color: message.kind === "error" ? "var(--status-danger)" : "var(--text-muted)",
          }}
        >
          {message.text}
        </div>
      )}

      {loading ? (
        <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "12px 0" }}>{t("models_loading")}</div>
      ) : loadError ? (
        <div role="alert" style={{ fontSize: 12, color: "var(--status-danger)" }}>
          {loadError}
        </div>
      ) : !payload || payload.models.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "12px 0" }}>
          {t("models_availableEmpty")}
        </div>
      ) : (
        <>
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {t("models_availableCount", { enabled: enabledCount, total: payload.models.length })}
          </div>
          <div style={{ display: "flex", flexDirection: "column", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
            {payload.models.map((m) => {
              const busy = pendingRef === m.ref;
              return (
                <label
                  key={m.ref}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: isMobile ? "10px 12px" : "8px 12px",
                    minHeight: 44,
                    borderTop: "1px solid var(--border)",
                    cursor: readOnly || busy ? "default" : "pointer",
                    opacity: busy ? 0.6 : 1,
                    minWidth: 0,
                  }}
                >
                  <input
                    type="checkbox"
                    role="switch"
                    checked={m.enabled}
                    disabled={readOnly || busy}
                    aria-label={t("models_toggleModelAria", { name: m.name })}
                    onChange={(e) => void toggle(m, e.target.checked)}
                    style={{ width: 15, height: 15, flexShrink: 0, accentColor: "var(--accent)", cursor: readOnly ? "default" : "pointer" }}
                  />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5, color: "var(--text)" }}>
                    {m.name || m.id}
                  </span>
                  <span style={{ flexShrink: 0, fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", maxWidth: isMobile ? 90 : 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {m.provider}
                  </span>
                </label>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
