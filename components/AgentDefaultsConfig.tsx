"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { THINKING_LEVELS, type AgentThinkingLevel } from "@/lib/agent-settings";
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

/** 通用文本框 label + value + onChange。 */
function TextField({
  label,
  value,
  placeholder,
  onChange,
  mono = true,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  mono?: boolean;
}) {
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={mono ? inputStyle : { ...inputStyle, fontFamily: "inherit" }}
      />
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: string;
  min?: number;
  max?: number;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputStyle, maxWidth: 220 }}
      />
    </div>
  );
}

function BooleanField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
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
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

type SettingsObject = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asBool(v: unknown): boolean {
  return v === true;
}
function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function asNumStr(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}
function asRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

type Draft = {
  defaultProvider: string;
  defaultModel: string;
  defaultThinkingLevel: AgentThinkingLevel | "";
  compactionEnabled: boolean;
  compactionReserve: string;
  compactionKeep: string;
  retryEnabled: boolean;
  retryMaxRetries: string;
  retryBaseDelayMs: string;
  hideThinkingBlock: boolean;
  showCacheMissNotices: boolean;
  httpProxy: string;
  httpIdleTimeoutMs: string;
  sessionDir: string;
  shellPath: string;
  quietStartup: boolean;
  externalEditor: string;
  defaultProjectTrust: string;
  doubleEscapeAction: string;
};

function rawToDraft(raw: SettingsObject): Draft {
  const compaction = asRecord(raw.compaction);
  const retry = asRecord(raw.retry);
  return {
    defaultProvider: asStr(raw.defaultProvider),
    defaultModel: asStr(raw.defaultModel),
    defaultThinkingLevel: (raw.defaultThinkingLevel as AgentThinkingLevel | undefined) ?? "",
    compactionEnabled: asBool(compaction.enabled),
    compactionReserve: asNumStr(compaction.reserveTokens),
    compactionKeep: asNumStr(compaction.keepRecentTokens),
    retryEnabled: asBool(retry.enabled),
    retryMaxRetries: asNumStr(retry.maxRetries),
    retryBaseDelayMs: asNumStr(retry.baseDelayMs),
    hideThinkingBlock: asBool(raw.hideThinkingBlock),
    showCacheMissNotices: asBool(raw.showCacheMissNotices),
    httpProxy: asStr(raw.httpProxy),
    httpIdleTimeoutMs: asNumStr(raw.httpIdleTimeoutMs),
    sessionDir: asStr(raw.sessionDir),
    shellPath: asStr(raw.shellPath),
    quietStartup: asBool(raw.quietStartup),
    externalEditor: asStr(raw.externalEditor),
    defaultProjectTrust: asStr(raw.defaultProjectTrust),
    doubleEscapeAction: asStr(raw.doubleEscapeAction),
  };
}

function draftDirty(draft: Draft, base: Draft): boolean {
  return (
    draft.defaultProvider !== base.defaultProvider ||
    draft.defaultModel !== base.defaultModel ||
    draft.defaultThinkingLevel !== base.defaultThinkingLevel ||
    draft.compactionEnabled !== base.compactionEnabled ||
    draft.compactionReserve !== base.compactionReserve ||
    draft.compactionKeep !== base.compactionKeep ||
    draft.retryEnabled !== base.retryEnabled ||
    draft.retryMaxRetries !== base.retryMaxRetries ||
    draft.retryBaseDelayMs !== base.retryBaseDelayMs ||
    draft.hideThinkingBlock !== base.hideThinkingBlock ||
    draft.showCacheMissNotices !== base.showCacheMissNotices ||
    draft.httpProxy !== base.httpProxy ||
    draft.httpIdleTimeoutMs !== base.httpIdleTimeoutMs ||
    draft.sessionDir !== base.sessionDir ||
    draft.shellPath !== base.shellPath ||
    draft.quietStartup !== base.quietStartup ||
    draft.externalEditor !== base.externalEditor ||
    draft.defaultProjectTrust !== base.defaultProjectTrust ||
    draft.doubleEscapeAction !== base.doubleEscapeAction
  );
}

export function AgentDefaultsConfig({ cwd }: AgentDefaultsConfigProps) {
  const { t } = useI18n();
  const [raw, setRaw] = useState<SettingsObject | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [modelList, setModelList] = useState<Array<{ id: string; name: string; provider: string }>>([]);
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
      const params = new URLSearchParams();
      if (cwd) params.set("cwd", cwd);
      const qs = params.toString();
      const [rawRes, modelsRes] = await Promise.all([
        fetch("/api/settings/raw", { cache: "no-store" }),
        fetch(`/api/models${qs ? `?${qs}` : ""}`),
      ]);
      if (!rawRes.ok) {
        const body = (await rawRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${rawRes.status}`);
      }
      const body = (await rawRes.json()) as { json?: string };
      let parsed: SettingsObject;
      try {
        parsed = JSON.parse(typeof body.json === "string" ? body.json : "{}") as SettingsObject;
      } catch {
        parsed = {};
      }
      setRaw(parsed);
      setDraft(rawToDraft(parsed));

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
      setRaw(null);
      setDraft(null);
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  /**
   * 保存：读取最新全量 settings.json → 用表单键覆盖（浅层覆盖 + compaction/retry 深合并）
   * → 原子写回。天然不覆盖其它配置（扩展键、并发修改）。
   */
  const save = useCallback(async () => {
    if (!draft || !raw) return;
    setSaving(true);
    setError(null);
    setSavedFlash(false);
    try {
      // 重新 GET 最新原文，避免覆盖他处（JSON 模式/其它客户端）的修改
      const latestRes = await fetch("/api/settings/raw", { cache: "no-store" });
      if (!latestRes.ok) {
        const body = (await latestRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${latestRes.status}`);
      }
      const latestBody = (await latestRes.json()) as { json?: string };
      const latest: SettingsObject =
        (() => {
          try {
            return JSON.parse(typeof latestBody.json === "string" ? latestBody.json : "{}") as SettingsObject;
          } catch {
            return {};
          }
        })();

      const next: SettingsObject = { ...latest };
      next.defaultProvider = draft.defaultProvider || undefined;
      next.defaultModel = draft.defaultModel || undefined;
      next.defaultThinkingLevel =
        draft.defaultThinkingLevel === "" ? undefined : draft.defaultThinkingLevel;
      next.hideThinkingBlock = draft.hideThinkingBlock || undefined;
      next.showCacheMissNotices = draft.showCacheMissNotices || undefined;
      next.quietStartup = draft.quietStartup || undefined;

      const compaction = { ...asRecord(next.compaction) };
      compaction.enabled = draft.compactionEnabled;
      const reserve = Number(draft.compactionReserve);
      const keep = Number(draft.compactionKeep);
      if (Number.isFinite(reserve) && reserve > 0) compaction.reserveTokens = reserve;
      if (Number.isFinite(keep) && keep > 0) compaction.keepRecentTokens = keep;
      next.compaction = compaction;

      const retry = { ...asRecord(next.retry) };
      retry.enabled = draft.retryEnabled;
      const maxRetries = Number(draft.retryMaxRetries);
      const baseDelay = Number(draft.retryBaseDelayMs);
      if (Number.isFinite(maxRetries) && maxRetries >= 0) retry.maxRetries = maxRetries;
      if (Number.isFinite(baseDelay) && baseDelay >= 0) retry.baseDelayMs = baseDelay;
      next.retry = retry;

      // 字符串键：非空才写；清空时删除键（避免残留空串）
      for (const key of [
        "httpProxy",
        "sessionDir",
        "shellPath",
        "externalEditor",
        "defaultProjectTrust",
        "doubleEscapeAction",
      ] as const) {
        const v = (draft as unknown as Record<string, string>)[key].trim();
        if (v) next[key] = v;
        else delete next[key];
      }
      const idleMs = Number(draft.httpIdleTimeoutMs);
      if (Number.isFinite(idleMs) && idleMs > 0) next.httpIdleTimeoutMs = idleMs;
      else delete next.httpIdleTimeoutMs;

      const res = await fetch("/api/settings/raw", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: JSON.stringify(next, null, 2) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setRaw(next);
      setDraft(rawToDraft(next));
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [draft, raw]);

  if (loading && !raw) {
    return (
      <div style={{ padding: "18px 20px", fontSize: 12, color: "var(--text-muted)" }}>
        {t("common_loading")}
      </div>
    );
  }

  if (error && !raw) {
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

  if (!raw || !draft) return null;

  const base = rawToDraft(raw);
  const dirty = draftDirty(draft, base);

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

  const blockStyle: React.CSSProperties = { marginBottom: 22 };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* 顶部二级页切换常驻 */}
      <div style={{ flexShrink: 0, padding: "16px 20px 0", display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={() => setActiveTab("basic")} style={tabStyle(activeTab === "basic")} aria-current={activeTab === "basic" ? "page" : undefined}>
          {t("defaults_basicTab")}
        </button>
        <button type="button" onClick={() => setActiveTab("json")} style={tabStyle(activeTab === "json")} aria-current={activeTab === "json" ? "page" : undefined}>
          {t("defaults_jsonTab")}
        </button>
      </div>

      {/* 中部内容区：超高内部滚动 */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 20px 20px" }}>
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

          {/* 默认模型 */}
          <div style={blockStyle}>
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
                      defaultModel: modelStillValid ? draft.defaultModel : "",
                    });
                  }}
                  style={selectStyle}
                >
                  <option value="">{t("defaults_providerUnset")}</option>
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

          {/* 压缩 */}
          <div style={blockStyle}>
            <div style={sectionTitleStyle}>{t("defaults_compactionSection")}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <BooleanField
                label={t("defaults_compactionEnabled")}
                checked={draft.compactionEnabled}
                onChange={(v) => setDraft({ ...draft, compactionEnabled: v })}
              />
              <NumberField
                label="reserveTokens"
                value={draft.compactionReserve}
                min={1}
                onChange={(v) => setDraft({ ...draft, compactionReserve: v })}
              />
              <NumberField
                label="keepRecentTokens"
                value={draft.compactionKeep}
                min={1}
                onChange={(v) => setDraft({ ...draft, compactionKeep: v })}
              />
            </div>
          </div>

          {/* 重试 */}
          <div style={blockStyle}>
            <div style={sectionTitleStyle}>{t("defaults_retrySection")}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <BooleanField
                label={t("defaults_retryEnabled")}
                checked={draft.retryEnabled}
                onChange={(v) => setDraft({ ...draft, retryEnabled: v })}
              />
              <NumberField
                label="maxRetries"
                value={draft.retryMaxRetries}
                min={0}
                onChange={(v) => setDraft({ ...draft, retryMaxRetries: v })}
              />
              <NumberField
                label="baseDelayMs"
                value={draft.retryBaseDelayMs}
                min={0}
                onChange={(v) => setDraft({ ...draft, retryBaseDelayMs: v })}
              />
            </div>
          </div>

          {/* 界面 */}
          <div style={blockStyle}>
            <div style={sectionTitleStyle}>{t("defaults_appearanceSection")}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <BooleanField
                label={t("defaults_hideThinkingBlock")}
                checked={draft.hideThinkingBlock}
                onChange={(v) => setDraft({ ...draft, hideThinkingBlock: v })}
              />
              <BooleanField
                label={t("defaults_showCacheMissNotices")}
                checked={draft.showCacheMissNotices}
                onChange={(v) => setDraft({ ...draft, showCacheMissNotices: v })}
              />
            </div>
          </div>

          {/* 网络与高级 */}
          <div style={blockStyle}>
            <div style={sectionTitleStyle}>{t("defaults_advancedSection")}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <TextField
                label="httpProxy"
                value={draft.httpProxy}
                onChange={(v) => setDraft({ ...draft, httpProxy: v })}
              />
              <NumberField
                label="httpIdleTimeoutMs"
                value={draft.httpIdleTimeoutMs}
                min={1}
                onChange={(v) => setDraft({ ...draft, httpIdleTimeoutMs: v })}
              />
              <TextField
                label="sessionDir"
                value={draft.sessionDir}
                onChange={(v) => setDraft({ ...draft, sessionDir: v })}
              />
              <TextField
                label="shellPath"
                value={draft.shellPath}
                onChange={(v) => setDraft({ ...draft, shellPath: v })}
              />
              <TextField
                label="externalEditor"
                value={draft.externalEditor}
                onChange={(v) => setDraft({ ...draft, externalEditor: v })}
              />
              <div>
                <div style={labelStyle}>defaultProjectTrust</div>
                <input
                  type="text"
                  value={draft.defaultProjectTrust}
                  placeholder="always / ask / never"
                  onChange={(e) => setDraft({ ...draft, defaultProjectTrust: e.target.value })}
                  style={{ ...inputStyle, fontFamily: "inherit" }}
                />
              </div>
              <div>
                <div style={labelStyle}>doubleEscapeAction</div>
                <select
                  value={draft.doubleEscapeAction}
                  onChange={(e) => setDraft({ ...draft, doubleEscapeAction: e.target.value })}
                  style={selectStyle}
                >
                  <option value="">（未设置）</option>
                  <option value="fork">fork</option>
                  <option value="tree">tree</option>
                  <option value="none">none</option>
                </select>
              </div>
              <BooleanField
                label={t("defaults_quietStartup")}
                checked={draft.quietStartup}
                onChange={(v) => setDraft({ ...draft, quietStartup: v })}
              />
            </div>
          </div>

        </>
      )}
      </div>

      {/* 底部操作区常驻（仅基础页） */}
      {activeTab === "basic" && (
        <div style={{ flexShrink: 0, padding: "12px 20px 16px", borderTop: "1px solid var(--border)", background: "var(--bg)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
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
      )}
    </div>
  );
}
