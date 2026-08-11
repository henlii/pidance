"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

type PromptKey = "system" | "systemAppend" | "agents";

type PromptEntry = {
  key: PromptKey;
  enabled: boolean;
  content: string;
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text)",
  marginBottom: 8,
};

/**
 * 文令配置：系统文令覆盖（SYSTEM.md）/ 系统文令追加（APPEND_SYSTEM.md）/
 * 全局规则（AGENTS.md）。开关控制文件是否存在；禁用时也可编辑并持久化草稿。
 */
export function PromptsConfig() {
  const { t } = useI18n();
  const [entries, setEntries] = useState<Record<PromptKey, PromptEntry> | null>(null);
  const [drafts, setDrafts] = useState<Record<PromptKey, string>>({
    system: "",
    systemAppend: "",
    agents: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<PromptKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<PromptKey | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/prompts", { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { entries?: PromptEntry[] };
      const map: Record<PromptKey, PromptEntry> = {
        system: { key: "system", enabled: false, content: "" },
        systemAppend: { key: "systemAppend", enabled: false, content: "" },
        agents: { key: "agents", enabled: false, content: "" },
      };
      for (const e of body.entries ?? []) {
        if (e && e.key in map) map[e.key] = e;
      }
      setEntries(map);
      setDrafts({
        system: map.system.content,
        systemAppend: map.systemAppend.content,
        agents: map.agents.content,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setEntries(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const put = useCallback(
    async (key: PromptKey, patch: { enabled?: boolean; content?: string }) => {
      setSaving(key);
      setError(null);
      setSavedFlash(null);
      try {
        const res = await fetch("/api/prompts", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, ...patch }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        if (patch.enabled !== undefined && entries) {
          setEntries({ ...entries, [key]: { ...entries[key], enabled: patch.enabled } });
        }
        setSavedFlash(key);
        window.setTimeout(() => setSavedFlash(null), 2000);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(null);
      }
    },
    [entries],
  );

  if (loading && !entries) {
    return (
      <div style={{ padding: "18px 20px", fontSize: 12, color: "var(--text-muted)" }}>
        {t("common_loading")}
      </div>
    );
  }

  if (!entries) {
    return (
      <div style={{ padding: "18px 20px" }}>
        <div style={{ fontSize: 12, color: "var(--status-danger)", marginBottom: 10 }}>
          {t("prompts_loadFailed")}: {error}
        </div>
      </div>
    );
  }

  const fileNames: Record<PromptKey, string> = {
    system: "SYSTEM.md",
    systemAppend: "APPEND_SYSTEM.md",
    agents: "AGENTS.md",
  };

  const titles: Record<PromptKey, string> = {
    system: t("prompts_systemTitle"),
    systemAppend: t("prompts_systemAppendTitle"),
    agents: t("prompts_agentsTitle"),
  };

  const editorStyle: React.CSSProperties = {
    width: "100%",
    minHeight: 160,
    maxHeight: "45vh",
    padding: "10px 12px",
    borderRadius: 7,
    border: "1px solid var(--border)",
    background: "var(--bg)",
    color: "var(--text)",
    fontSize: 12,
    lineHeight: 1.55,
    outline: "none",
    fontFamily: "var(--font-mono)",
    whiteSpace: "pre",
    overflow: "auto",
    boxSizing: "border-box",
    resize: "vertical",
  };

  return (
    <div style={{ padding: "18px 20px" }}>
      <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6, marginBottom: 16, maxWidth: 560 }}>
        {t("prompts_hint")}
      </div>

      {error && (
        <div style={{ fontSize: 12, color: "var(--status-danger)", marginBottom: 12 }}>
          {t("prompts_saveFailed")}: {error}
        </div>
      )}

      {(["system", "systemAppend", "agents"] as PromptKey[]).map((key) => {
        const entry = entries[key];
        const dirty = drafts[key] !== entry.content;
        return (
          <div key={key} style={{ marginBottom: 26 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <div style={sectionTitleStyle as React.CSSProperties}>{titles[key]}</div>
              <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                {fileNames[key]}
              </span>
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  marginLeft: "auto",
                  fontSize: 12,
                  color: "var(--text-muted)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={entry.enabled}
                  disabled={saving === key}
                  onChange={(e) => void put(key, { enabled: e.target.checked })}
                />
                {t("prompts_enabled")}
              </label>
            </div>
            <textarea
              value={drafts[key]}
              onChange={(e) => {
                setDrafts((prev) => ({ ...prev, [key]: e.target.value }));
                setError(null);
                setSavedFlash(null);
              }}
              spellCheck={false}
              disabled={saving === key}
              aria-label={titles[key]}
              style={editorStyle}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
              <button
                type="button"
                onClick={() => void put(key, { content: drafts[key] })}
                disabled={saving === key || !dirty}
                style={{
                  minHeight: 30,
                  padding: "0 14px",
                  borderRadius: 7,
                  border: `1px solid ${dirty ? "var(--accent)" : "var(--border)"}`,
                  background: dirty ? "var(--accent)" : "var(--bg-panel)",
                  color: dirty ? "var(--accent-foreground)" : "var(--text-muted)",
                  cursor: saving === key || !dirty ? "not-allowed" : "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                  opacity: saving === key || !dirty ? 0.65 : 1,
                }}
              >
                {saving === key ? t("common_saving") : t("common_save")}
              </button>
              {!entry.enabled && (
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  {t("prompts_disabledDraftHint")}
                </span>
              )}
              {savedFlash === key && (
                <span style={{ fontSize: 12, color: "var(--accent)" }}>{t("common_saved")}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
