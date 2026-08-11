"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import {
  THINKING_LEVELS,
  type AgentSettingsView,
  type AgentThinkingLevel,
} from "@/lib/agent-settings";
import {
  loadStreamingEnterAction,
  saveStreamingEnterAction,
  type StreamingEnterAction,
} from "@/lib/ui-preferences";
import { readSoundEnabled, writeSoundEnabled } from "@/hooks/useAudio";
import { SettingsJsonEditor } from "./SettingsJsonEditor";

interface AgentDefaultsConfigProps {
  cwd: string | null;
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text)",
  marginBottom: 8,
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 420,
  padding: "7px 10px",
  borderRadius: 7,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 13,
  outline: "none",
  fontFamily: "var(--font-mono)",
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  fontFamily: "inherit",
  cursor: "pointer",
};

type Draft = {
  defaultProvider: string;
  defaultModel: string;
  defaultThinkingLevel: AgentThinkingLevel | "";
  compactionEnabled: boolean;
  retryEnabled: boolean;
};

function viewToDraft(view: AgentSettingsView): Draft {
  return {
    defaultProvider: view.defaultProvider ?? "",
    defaultModel: view.defaultModel ?? "",
    defaultThinkingLevel: view.defaultThinkingLevel ?? "",
    compactionEnabled: view.compaction.enabled,
    retryEnabled: view.retry.enabled,
  };
}

function draftDirty(draft: Draft, view: AgentSettingsView): boolean {
  const base = viewToDraft(view);
  return (
    draft.defaultProvider !== base.defaultProvider ||
    draft.defaultModel !== base.defaultModel ||
    draft.defaultThinkingLevel !== base.defaultThinkingLevel ||
    draft.compactionEnabled !== base.compactionEnabled ||
    draft.retryEnabled !== base.retryEnabled
  );
}

export function AgentDefaultsConfig({ cwd }: AgentDefaultsConfigProps) {
  const { t } = useI18n();
  const [data, setData] = useState<AgentSettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** 可选模型列表（来自 /api/models），供默认 provider/model 下拉。 */
  const [modelList, setModelList] = useState<Array<{ id: string; name: string; provider: string }>>([]);
  /** 桌面流式期 Enter 默认动作（localStorage，与 Pi settings 分离）。 */
  const [streamingEnterDefault, setStreamingEnterDefault] = useState<StreamingEnterAction>("followUp");
  /** 完成提示音（localStorage pi-sound-enabled）。 */
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  /** 二级页：基础表单 / 原始 JSON */
  const [activeTab, setActiveTab] = useState<"basic" | "json">("basic");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStreamingEnterDefault(loadStreamingEnterAction());
      setSoundEnabled(readSoundEnabled());
      const params = new URLSearchParams();
      if (cwd) params.set("cwd", cwd);
      const qs = params.toString();
      const [settingsRes, modelsRes] = await Promise.all([
        fetch(`/api/agent-settings${qs ? `?${qs}` : ""}`),
        fetch(`/api/models${qs ? `?${qs}` : ""}`),
      ]);
      if (!settingsRes.ok) {
        const body = (await settingsRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${settingsRes.status}`);
      }
      const body = (await settingsRes.json()) as AgentSettingsView;
      setData(body);
      setDraft(viewToDraft(body));

      if (modelsRes.ok) {
        const modelsBody = (await modelsRes.json()) as {
          modelList?: Array<{ id: string; name: string; provider: string }>;
        };
        setModelList(Array.isArray(modelsBody.modelList) ? modelsBody.modelList : []);
      } else {
        setModelList([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
      setDraft(null);
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const save = useCallback(async () => {
    if (!draft || !data) return;
    setSaving(true);
    setError(null);
    setSavedFlash(false);
    try {
      const payload: Record<string, unknown> = {};
      if (cwd) payload.cwd = cwd;

      const base = viewToDraft(data);
      if (draft.defaultProvider !== base.defaultProvider) {
        // 不发送清空：SDK 无 delete API，发 null 会被服务端拒绝
        const trimmed = draft.defaultProvider.trim();
        if (trimmed) payload.defaultProvider = trimmed;
      }
      if (draft.defaultModel !== base.defaultModel) {
        const trimmed = draft.defaultModel.trim();
        if (trimmed) payload.defaultModel = trimmed;
      }
      if (draft.defaultThinkingLevel !== base.defaultThinkingLevel) {
        payload.defaultThinkingLevel = draft.defaultThinkingLevel || null;
      }
      if (draft.compactionEnabled !== base.compactionEnabled) {
        payload.compactionEnabled = draft.compactionEnabled;
      }
      if (draft.retryEnabled !== base.retryEnabled) {
        payload.retryEnabled = draft.retryEnabled;
      }

      // 若只有 cwd，无变更
      const keys = Object.keys(payload).filter((k) => k !== "cwd");
      if (keys.length === 0) {
        setSaving(false);
        return;
      }

      const res = await fetch("/api/agent-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          errors?: Array<{ field: string; message: string }>;
        };
        const detail = body.errors?.map((e) => e.message).join("; ");
        throw new Error(detail || body.error || `HTTP ${res.status}`);
      }
      const body = (await res.json()) as AgentSettingsView;
      setData(body);
      setDraft(viewToDraft(body));
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [draft, data, cwd]);

  if (loading && !data) {
    return (
      <div style={{ padding: "18px 20px", fontSize: 12, color: "var(--text-muted)" }}>
        {t("common_loading")}
      </div>
    );
  }

  if (error && !data) {
    return (
      <div style={{ padding: "18px 20px" }}>
        <div style={{ fontSize: 12, color: "var(--status-danger)", marginBottom: 10 }}>
          {t("defaults_loadFailed")}: {error}
        </div>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          style={{
            minHeight: 30,
            padding: "0 12px",
            borderRadius: 7,
            border: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text)",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          {t("defaults_retry")}
        </button>
      </div>
    );
  }

  if (!data || !draft) return null;

  const dirty = draftDirty(draft, data);

  // provider 去重保序；model 按当前选中 provider 过滤。
  const providerOptions: string[] = [];
  for (const m of modelList) {
    if (!providerOptions.includes(m.provider)) providerOptions.push(m.provider);
  }
  const modelsForSelectedProvider = draft.defaultProvider
    ? modelList.filter((m) => m.provider === draft.defaultProvider)
    : [];

  const tabStyle = (active: boolean): React.CSSProperties => ({
    minHeight: 30,
    padding: "0 12px",
    borderRadius: 7,
    border: "1px solid var(--border)",
    background: active ? "var(--bg-selected)" : "var(--bg-panel)",
    color: active ? "var(--text)" : "var(--text-muted)",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: active ? 600 : 400,
  });

  return (
    <div style={{ padding: "18px 20px" }}>
      {/* 二级页导航：基础（分块表单）/ 原始 JSON */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <button type="button" onClick={() => setActiveTab("basic")} style={tabStyle(activeTab === "basic")} aria-current={activeTab === "basic" ? "page" : undefined}>
          {t("defaults_basicTab")}
        </button>
        <button type="button" onClick={() => setActiveTab("json")} style={tabStyle(activeTab === "json")} aria-current={activeTab === "json" ? "page" : undefined}>
          {t("defaults_jsonTab")}
        </button>
      </div>

      {activeTab === "json" ? (
        <SettingsJsonEditor />
      ) : (
      <>
      <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6, marginBottom: 16 }}>
        {t("defaults_hint")}
      </div>

      {error && (
        <div style={{ fontSize: 12, color: "var(--status-danger)", marginBottom: 12 }}>
          {t("defaults_saveFailed")}: {error}
        </div>
      )}

      <div style={{ marginBottom: 22 }}>
        <div style={sectionTitleStyle}>{t("defaults_modelSection")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={labelStyle}>{t("defaults_provider")}</div>
            <select
              value={draft.defaultProvider}
              onChange={(e) => {
                const nextProvider = e.target.value;
                const modelsForProvider = modelList.filter((m) => m.provider === nextProvider);
                const modelStillValid = modelsForProvider.some((m) => m.id === draft.defaultModel);
                setDraft({
                  ...draft,
                  defaultProvider: nextProvider,
                  // 切换 provider 后若当前 model 不在该 provider 下则清空，避免错配。
                  defaultModel: modelStillValid ? draft.defaultModel : "",
                });
              }}
              style={selectStyle}
            >
              <option value="">{t("defaults_providerUnset")}</option>
              {/* 当前值不在列表中时保留可选，避免静默丢值 */}
              {draft.defaultProvider &&
                !providerOptions.includes(draft.defaultProvider) && (
                  <option value={draft.defaultProvider}>{draft.defaultProvider}</option>
                )}
              {providerOptions.map((provider) => (
                <option key={provider} value={provider}>
                  {provider}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div style={labelStyle}>{t("defaults_model")}</div>
            <select
              value={draft.defaultModel}
              onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value })}
              style={selectStyle}
              disabled={!draft.defaultProvider}
            >
              <option value="">
                {draft.defaultProvider
                  ? modelsForSelectedProvider.length === 0 && !draft.defaultModel
                    ? t("defaults_modelEmpty")
                    : t("defaults_modelUnset")
                  : t("defaults_modelUnset")}
              </option>
              {draft.defaultModel &&
                !modelsForSelectedProvider.some((m) => m.id === draft.defaultModel) && (
                  <option value={draft.defaultModel}>{draft.defaultModel}</option>
                )}
              {modelsForSelectedProvider.map((m) => (
                <option key={`${m.provider}:${m.id}`} value={m.id}>
                  {m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div style={labelStyle}>{t("defaults_thinking")}</div>
            <select
              value={draft.defaultThinkingLevel}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  defaultThinkingLevel: e.target.value as AgentThinkingLevel | "",
                })
              }
              style={selectStyle}
            >
              <option value="">{t("defaults_thinkingUnset")}</option>
              {THINKING_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 22 }}>
        <div style={sectionTitleStyle}>{t("defaults_inputSection")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={labelStyle}>{t("defaults_streamingEnter")}</div>
            <select
              value={streamingEnterDefault}
              onChange={(e) => {
                const next = e.target.value === "steer" ? "steer" : "followUp";
                setStreamingEnterDefault(next);
                saveStreamingEnterAction(next);
                window.dispatchEvent(new Event("pidance:streaming-enter-changed"));
              }}
              style={selectStyle}
            >
              <option value="followUp">{t("defaults_streamingEnterQueue")}</option>
              <option value="steer">{t("defaults_streamingEnterSteer")}</option>
            </select>
            <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-dim)", maxWidth: 420, lineHeight: 1.45 }}>
              {t("defaults_streamingEnterHint")}
            </div>
          </div>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
              color: "var(--text)",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={soundEnabled}
              onChange={(e) => {
                const next = e.target.checked;
                setSoundEnabled(next);
                writeSoundEnabled(next);
              }}
            />
            {t("defaults_completionSound")}
          </label>
          <div style={{ marginTop: -4, fontSize: 11, color: "var(--text-dim)", maxWidth: 420, lineHeight: 1.45 }}>
            {t("defaults_completionSoundHint")}
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 22 }}>
        <div style={sectionTitleStyle}>{t("defaults_compactionSection")}</div>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            color: "var(--text)",
            cursor: "pointer",
            marginBottom: 10,
          }}
        >
          <input
            type="checkbox"
            checked={draft.compactionEnabled}
            onChange={(e) => setDraft({ ...draft, compactionEnabled: e.target.checked })}
          />
          {t("defaults_compactionEnabled")}
        </label>
        <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.55, fontFamily: "var(--font-mono)" }}>
          {t("defaults_compactionReadonly", {
            reserve: data.compaction.reserveTokens,
            keep: data.compaction.keepRecentTokens,
          })}
        </div>
      </div>

      <div style={{ marginBottom: 22 }}>
        <div style={sectionTitleStyle}>{t("defaults_retrySection")}</div>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            color: "var(--text)",
            cursor: "pointer",
            marginBottom: 10,
          }}
        >
          <input
            type="checkbox"
            checked={draft.retryEnabled}
            onChange={(e) => setDraft({ ...draft, retryEnabled: e.target.checked })}
          />
          {t("defaults_retryEnabled")}
        </label>
        <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.55, fontFamily: "var(--font-mono)" }}>
          {t("defaults_retryReadonly", {
            max: data.retry.maxRetries,
            base: data.retry.baseDelayMs,
          })}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || saving}
          style={{
            minHeight: 32,
            padding: "0 14px",
            borderRadius: 7,
            border: `1px solid ${dirty ? "var(--accent)" : "var(--border)"}`,
            background: dirty ? "var(--accent)" : "var(--bg-panel)",
            color: dirty ? "var(--accent-foreground)" : "var(--text-muted)",
            cursor: !dirty || saving ? "not-allowed" : "pointer",
            fontSize: 12,
            fontWeight: 600,
            opacity: !dirty || saving ? 0.65 : 1,
          }}
        >
          {saving ? t("common_saving") : t("common_save")}
        </button>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading || saving}
          style={{
            minHeight: 32,
            padding: "0 12px",
            borderRadius: 7,
            border: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
            cursor: loading || saving ? "not-allowed" : "pointer",
            fontSize: 12,
          }}
        >
          {t("defaults_refresh")}
        </button>
        {savedFlash && (
          <span style={{ fontSize: 12, color: "var(--accent)" }}>{t("common_saved")}</span>
        )}
      </div>
      </>
      )}
    </div>
  );
}

