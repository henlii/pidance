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
  const [savingAll, setSavingAll] = useState(false);
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

  /** 底部常驻「保存全部」：串行保存所有脏块 */
  const saveAll = useCallback(async () => {
    if (!entries) return;
    const dirtyKeys = (Object.keys(entries) as PromptKey[]).filter(
      (key) => drafts[key] !== entries[key].content,
    );
    if (dirtyKeys.length === 0) return;
    setSavingAll(true);
    setError(null);
    try {
      for (const key of dirtyKeys) {
        const res = await fetch("/api/prompts", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, content: drafts[key] }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
      }
      setSavedFlash("all" as unknown as PromptKey);
      window.setTimeout(() => setSavedFlash(null), 2000);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingAll(false);
    }
  }, [drafts, entries, load]);

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

  const dirtyCount = entries ? Object.keys(entries).filter((k) => drafts[k as PromptKey] !== entries[k as PromptKey].content).length : 0;
  /** 当前二级页（系统文令 / 系统追加 / 全局规则） */
  const [activeKey, setActiveKey] = useState<PromptKey>("system");
  const tabStyle = (active: boolean): React.CSSProperties => ({
    minHeight: 28,
    padding: "0 12px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: active ? "var(--bg-selected)" : "var(--bg-panel)",
    color: active ? "var(--text)" : "var(--text-muted)",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: active ? 600 : 400,
  });

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* 顶部二级页切换常驻 */}
      <div style={{ flexShrink: 0, padding: "16px 20px 0", display: "flex", gap: 8, flexWrap: "wrap" }}>
        {(["system", "systemAppend", "agents"] as PromptKey[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setActiveKey(key)}
            style={tabStyle(activeKey === key)}
            aria-current={activeKey === key ? "page" : undefined}
          >
            {titles[key]}
          </button>
        ))}
      </div>
      <div style={{ flexShrink: 0, padding: "10px 20px 0" }}>
        <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6, maxWidth: 560 }}>
          {t("prompts_hint")}
        </div>
      </div>

      {/* 中部内容区：超高内部滚动（仅当前二级页） */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 20px 20px" }}>
      {error && (
        <div style={{ fontSize: 12, color: "var(--status-danger)", marginBottom: 12 }}>
          {t("prompts_saveFailed")}: {error}
        </div>
      )}

      {(() => {
        const key = activeKey;
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
      })()}
      </div>

      {/* 底部操作区常驻 */}
      <div style={{ flexShrink: 0, padding: "12px 20px 16px", borderTop: "1px solid var(--border)", background: "var(--bg)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => void saveAll()}
          disabled={savingAll || dirtyCount === 0}
          style={{
            minHeight: 32,
            padding: "0 14px",
            borderRadius: 7,
            border: `1px solid ${dirtyCount > 0 ? "var(--accent)" : "var(--border)"}`,
            background: dirtyCount > 0 ? "var(--accent)" : "var(--bg-panel)",
            color: dirtyCount > 0 ? "var(--accent-foreground)" : "var(--text-muted)",
            cursor: savingAll || dirtyCount === 0 ? "not-allowed" : "pointer",
            fontSize: 12,
            fontWeight: 600,
            opacity: savingAll || dirtyCount === 0 ? 0.65 : 1,
          }}
        >
          {savingAll ? t("common_saving") : t("prompts_saveAll")}
        </button>
        {dirtyCount > 0 && !savingAll && (
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {t("prompts_dirtyCount", { count: String(dirtyCount) })}
          </span>
        )}
        {savedFlash && (
          <span style={{ fontSize: 12, color: "var(--accent)" }}>{t("common_saved")}</span>
        )}
      </div>
    </div>
  );
}
