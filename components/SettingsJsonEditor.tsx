"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { SettingsPageFooter, settingsPrimaryButtonStyle, settingsSecondaryButtonStyle } from "./SettingsPageFooter";

/**
 * settings.json 原始 JSON 编辑模式：
 * 加载 → 编辑 → 校验（客户端 + 服务端）→ 原子保存。
 */
export function SettingsJsonEditor({
  stickyFooter = false,
  onClose,
}: {
  stickyFooter?: boolean;
  onClose?: () => void;
} = {}) {
  const { t } = useI18n();
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [lineScrollTop, setLineScrollTop] = useState(0);
  /** 校验结果：null 未校验 / true 通过 / string 错误信息 */
  const [validation, setValidation] = useState<true | string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/raw", { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { json?: string };
      setText(typeof body.json === "string" ? body.json : "{}\n");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setText(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  /** 客户端 JSON 校验：返回错误描述或 null。 */
  const validateText = useCallback((): string | null => {
    if (text === null) return null;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return t("settingsJson_mustBeObject");
      }
      return null;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // 提取 "position N" → 行/列
      const m = /position (\d+)/.exec(message);
      if (m) {
        const pos = Number(m[1]);
        const before = text.slice(0, pos);
        const line = before.split("\n").length;
        const col = pos - before.lastIndexOf("\n");
        return t("settingsJson_invalidAt", { line: String(line), col: String(col) });
      }
      return t("settingsJson_invalid", { message });
    }
  }, [text, t]);

  /** 格式化：JSON.parse → 缩进 2 回填。 */
  const formatJson = useCallback(() => {
    if (text === null) return;
    const err = validateText();
    if (err !== null) {
      setValidation(err);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      setText(JSON.stringify(parsed, null, 2));
      setValidation(true);
      setError(null);
      setSavedFlash(false);
    } catch {
      /* validateText 已拦截 */
    }
  }, [text, validateText]);

  /** 校验并落结果：true=通过，string=错误，用于按钮门控与提示。 */
  const runValidation = useCallback((): boolean => {
    if (text === null) {
      setValidation(null);
      return false;
    }
    const err = validateText();
    setValidation(err === null ? true : err);
    return err === null;
  }, [text, validateText]);

  const save = useCallback(async () => {
    if (!runValidation()) return;
    setSaving(true);
    setError(null);
    setSavedFlash(false);
    try {
      const res = await fetch("/api/settings/raw", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: text }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [text, validateText, t]);

  if (loading && text === null) {
    return (
      <div style={{ padding: "12px 0", fontSize: 12, color: "var(--text-muted)" }}>
        {t("common_loading")}
      </div>
    );
  }

  const textareaStyle: React.CSSProperties = {
    width: "100%",
    minHeight: stickyFooter ? 0 : 320,
    maxHeight: stickyFooter ? "none" : "60vh",
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
    resize: stickyFooter ? "none" : "vertical",
  };

  if (stickyFooter) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
        {/* 中部：与文令页一致的 padding + 标题行 + 自动扩展编辑器 */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 20px 12px", display: "flex", flexDirection: "column" }}>
          <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
              {t("defaults_jsonTab")}
            </div>
            <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
              settings.json
            </span>
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 200,
              display: "flex",
              alignItems: "stretch",
              border: "1px solid var(--border)",
              borderRadius: 7,
              overflow: "hidden",
              background: "var(--bg)",
            }}
          >
            <div
              aria-hidden="true"
              style={{
                flexShrink: 0,
                padding: "10px 6px 10px 10px",
                background: "var(--bg-panel)",
                borderRight: "1px solid var(--border)",
                color: "var(--text-dim)",
                fontSize: 12,
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
                textAlign: "right",
                userSelect: "none",
                overflow: "hidden",
                minHeight: 0,
              }}
            >
              {(text ?? "").split("\n").map((_, i) => (
                <div key={i} style={{ transform: `translateY(-${lineScrollTop}px)` }}>{i + 1}</div>
              ))}
            </div>
            <textarea
              ref={textareaRef}
              value={text ?? ""}
              onChange={(e) => {
                setText(e.target.value);
                setError(null);
                setSavedFlash(false);
                setValidation(null);
              }}
              onScroll={(e) => setLineScrollTop(e.currentTarget.scrollTop)}
              spellCheck={false}
              aria-label={t("settingsJson_editorLabel")}
              style={{
                flex: 1,
                minHeight: 0,
                width: "100%",
                padding: "10px 12px",
                border: "none",
                borderRadius: 0,
                background: "var(--bg)",
                color: "var(--text)",
                fontSize: 12,
                lineHeight: 1.55,
                outline: "none",
                fontFamily: "var(--font-mono)",
                whiteSpace: "pre",
                overflow: "auto",
                boxSizing: "border-box",
                resize: "none",
              }}
            />
          </div>
        </div>

        <SettingsPageFooter
          fixedHint="~/.pi/agent/settings.json"
          dynamicHint={
            typeof validation === "string" || error ? (
              <span style={{ color: "var(--status-danger)", fontFamily: "var(--font-mono)" }}>
                {typeof validation === "string" ? validation : error}
              </span>
            ) : validation === true ? (
              <span style={{ color: "var(--status-ok, var(--accent))", fontFamily: "var(--font-mono)" }}>
                {t("settingsJson_valid")}
              </span>
            ) : savedFlash ? (
              <span style={{ color: "var(--accent)" }}>{t("common_saved")}</span>
            ) : null
          }
          onClose={onClose}
        >
          <button
            type="button"
            onClick={() => void formatJson()}
            disabled={text === null}
            style={settingsSecondaryButtonStyle(text !== null)}
          >
            {t("settingsJson_format")}
          </button>
          <button
            type="button"
            onClick={() => void runValidation()}
            disabled={text === null}
            style={settingsSecondaryButtonStyle(text !== null)}
          >
            {t("settingsJson_validate")}
          </button>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={saving}
            style={settingsSecondaryButtonStyle(!saving)}
          >
            {t("common_reload")}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={text === null || saving || validation !== true}
            style={settingsPrimaryButtonStyle(text !== null && !saving && validation === true)}
          >
            {saving ? t("common_saving") : t("common_save")}
          </button>
        </SettingsPageFooter>
      </div>
    );
  }


  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6, marginBottom: 12, maxWidth: 560 }}>
        {t("settingsJson_hint")}
      </div>

      {(error || (typeof validation === "string")) && (
        <div style={{ fontSize: 12, color: "var(--status-danger)", marginBottom: 10, fontFamily: "var(--font-mono)" }}>
          {typeof validation === "string" ? validation : error}
        </div>
      )}
      {validation === true && (
        <div style={{ fontSize: 12, color: "var(--status-ok, var(--accent))", marginBottom: 10, fontFamily: "var(--font-mono)" }}>
          {t("settingsJson_valid")}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "stretch", border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden" }}>
        {/* 行号 gutter（与 textarea 同步滚动） */}
        <div
          aria-hidden="true"
          style={{
            flexShrink: 0,
            padding: "10px 6px 10px 10px",
            background: "var(--bg-panel)",
            borderRight: "1px solid var(--border)",
            color: "var(--text-dim)",
            fontSize: 12,
            lineHeight: 1.55,
            fontFamily: "var(--font-mono)",
            textAlign: "right",
            userSelect: "none",
            overflow: "hidden",
            maxHeight: "60vh",
          }}
        >
          {(text ?? "").split("\n").map((_, i) => (
            <div key={i} style={{ transform: `translateY(-${lineScrollTop}px)` }}>{i + 1}</div>
          ))}
        </div>
        <textarea
          ref={textareaRef}
          value={text ?? ""}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
            setSavedFlash(false);
            // 内容变更后需重新校验才可保存
            setValidation(null);
          }}
          onScroll={(e) => setLineScrollTop(e.currentTarget.scrollTop)}
          spellCheck={false}
          aria-label={t("settingsJson_editorLabel")}
          style={{ ...textareaStyle, border: "none", borderRadius: 0, minHeight: 320, maxHeight: "60vh" }}
        />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => void formatJson()}
          disabled={text === null}
          style={{
            minHeight: 30,
            padding: "0 12px",
            borderRadius: 7,
            border: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text)",
            cursor: text === null ? "not-allowed" : "pointer",
            fontSize: 12,
          }}
        >
          {t("settingsJson_format")}
        </button>
        <button
          type="button"
          onClick={() => void runValidation()}
          disabled={text === null}
          style={{
            minHeight: 30,
            padding: "0 12px",
            borderRadius: 7,
            border: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text)",
            cursor: text === null ? "not-allowed" : "pointer",
            fontSize: 12,
          }}
        >
          {t("settingsJson_validate")}
        </button>
        <button
          type="button"
          onClick={() => void save()}
          // 保存按钮默认禁用；校验通过后才可用
          disabled={text === null || saving || validation !== true}
          style={{
            minHeight: 30,
            padding: "0 14px",
            borderRadius: 7,
            border: "1px solid var(--accent)",
            background: "var(--accent)",
            color: "var(--accent-foreground)",
            cursor: text === null || saving || validation !== true ? "not-allowed" : "pointer",
            fontSize: 12,
            fontWeight: 600,
            opacity: text === null || saving || validation !== true ? 0.65 : 1,
          }}
        >
          {saving ? t("common_saving") : t("common_save")}
        </button>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={saving}
          style={{
            minHeight: 30,
            padding: "0 12px",
            borderRadius: 7,
            border: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
            cursor: saving ? "not-allowed" : "pointer",
            fontSize: 12,
          }}
        >
          {t("common_reload")}
        </button>
        {savedFlash && (
          <span style={{ fontSize: 12, color: "var(--accent)" }}>{t("common_saved")}</span>
        )}
      </div>
    </div>
  );
}
