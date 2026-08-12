"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

type ProjectSkill = {
  name: string;
  enabled: boolean;
  content: string;
};

/**
 * 项目资产编辑：项目级规则（AGENTS.md）+ 项目技能（.agents/skills/）。
 * tab 由外层受控（编辑项目弹窗外层已有 名称/规则/技能 切换，这里不再重复渲染内部 tab）。
 */
export function ProjectAssetsEditor({ cwd, tab }: { cwd: string; tab: "rules" | "skills" }) {
  const { t } = useI18n();
  const [rules, setRules] = useState<string | null>(null);
  const [skills, setSkills] = useState<ProjectSkill[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  /** 编辑中的技能（name → 内容） */
  const [editingSkill, setEditingSkill] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  /** 新建技能名称 */
  const [newSkillName, setNewSkillName] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/project-assets?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        rulesContent?: string;
        skills?: ProjectSkill[];
      };
      setRules(body.rulesContent ?? "");
      setSkills(Array.isArray(body.skills) ? body.skills : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  const post = useCallback(
    async (payload: Record<string, unknown>): Promise<boolean> => {
      const res = await fetch("/api/project-assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, ...payload }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return true;
    },
    [cwd],
  );

  const saveRules = useCallback(async () => {
    if (rules === null) return;
    setSaving(true);
    setError(null);
    setSavedFlash(false);
    try {
      await post({ kind: "rules", content: rules });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [rules, post]);

  const createSkill = useCallback(async () => {
    const name = newSkillName.trim();
    if (!name) return;
    setSaving(true);
    setError(null);
    try {
      await post({ kind: "skill", action: "create", name });
      setNewSkillName("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [newSkillName, post, load]);

  const saveSkill = useCallback(
    async (name: string) => {
      setSaving(true);
      setError(null);
      try {
        await post({ kind: "skill", action: "update", name, content: editingContent });
        setEditingSkill(null);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [editingContent, post, load],
  );

  const toggleSkill = useCallback(
    async (skill: ProjectSkill) => {
      setSaving(true);
      setError(null);
      try {
        await post({ kind: "skill", action: "toggle", name: skill.name, enabled: !skill.enabled });
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [post, load],
  );

  const deleteSkill = useCallback(
    async (name: string) => {
      setSaving(true);
      setError(null);
      try {
        await post({ kind: "skill", action: "delete", name });
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [post, load],
  );

  const editorStyle: React.CSSProperties = {
    width: "100%",
    minHeight: 200,
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

  if (loading) {
    return <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("common_loading")}</div>;
  }

  return (
    <div>
      {error && (
        <div style={{ fontSize: 12, color: "var(--status-danger)", marginBottom: 10, whiteSpace: "pre-wrap" }}>{error}</div>
      )}

      {tab === "rules" ? (
        <div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
            {cwd}/AGENTS.md
          </div>
          <textarea
            value={rules ?? ""}
            onChange={(e) => setRules(e.target.value)}
            spellCheck={false}
            aria-label={t("projectAssets_rules")}
            style={editorStyle}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
            <button
              type="button"
              onClick={() => void saveRules()}
              disabled={saving || rules === null}
              style={{
                minHeight: 30, padding: "0 14px", borderRadius: 7,
                border: "1px solid var(--accent)", background: "var(--accent)",
                color: "var(--accent-foreground)",
                cursor: saving || rules === null ? "not-allowed" : "pointer",
                fontSize: 12, fontWeight: 600, opacity: saving || rules === null ? 0.6 : 1,
              }}
            >
              {saving ? t("common_saving") : t("common_save")}
            </button>
            {savedFlash && <span style={{ fontSize: 12, color: "var(--accent)" }}>{t("common_saved")}</span>}
          </div>
        </div>
      ) : (
        <div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input
              type="text"
              value={newSkillName}
              onChange={(e) => setNewSkillName(e.target.value)}
              placeholder={t("projectAssets_newSkillName")}
              aria-label={t("projectAssets_newSkillName")}
              style={{
                flex: 1, height: 30, padding: "0 10px", borderRadius: 6,
                border: "1px solid var(--border)", background: "var(--bg)",
                color: "var(--text)", fontSize: 12, outline: "none",
              }}
            />
            <button
              type="button"
              onClick={() => void createSkill()}
              disabled={saving || !newSkillName.trim()}
              style={{
                minHeight: 30, padding: "0 12px", borderRadius: 6,
                border: "1px solid var(--accent)", background: "var(--accent)",
                color: "var(--accent-foreground)",
                cursor: saving || !newSkillName.trim() ? "not-allowed" : "pointer",
                fontSize: 12, fontWeight: 600, opacity: saving || !newSkillName.trim() ? 0.6 : 1,
              }}
            >
              {t("projectAssets_addSkill")}
            </button>
          </div>

          {skills?.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("projectAssets_noSkills")}</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {(skills ?? []).map((skill) => (
                <div key={skill.name} style={{ border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)" }}>
                    <span style={{ fontSize: 12, color: "var(--text)", fontFamily: "var(--font-mono)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {skill.name}
                    </span>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-muted)", cursor: "pointer" }}>
                      <input type="checkbox" checked={skill.enabled} onChange={() => void toggleSkill(skill)} disabled={saving} />
                      {t("projectAssets_enabled")}
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingSkill(skill.name);
                        setEditingContent(skill.content);
                      }}
                      style={{ fontSize: 11, color: "var(--accent)", cursor: "pointer", background: "none", border: "none" }}
                    >
                      {t("projectAssets_edit")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteSkill(skill.name)}
                      disabled={saving}
                      style={{ fontSize: 11, color: "var(--status-danger)", cursor: saving ? "not-allowed" : "pointer", background: "none", border: "none" }}
                    >
                      {t("common_remove")}
                    </button>
                  </div>
                  {editingSkill === skill.name && (
                    <div style={{ padding: 8 }}>
                      <textarea
                        value={editingContent}
                        onChange={(e) => setEditingContent(e.target.value)}
                        spellCheck={false}
                        aria-label={`${skill.name} SKILL.md`}
                        style={editorStyle}
                      />
                      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <button
                          type="button"
                          onClick={() => void saveSkill(skill.name)}
                          disabled={saving}
                          style={{
                            minHeight: 28, padding: "0 12px", borderRadius: 6,
                            border: "1px solid var(--accent)", background: "var(--accent)",
                            color: "var(--accent-foreground)", cursor: saving ? "not-allowed" : "pointer",
                            fontSize: 12, fontWeight: 600, opacity: saving ? 0.6 : 1,
                          }}
                        >
                          {saving ? t("common_saving") : t("common_save")}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingSkill(null)}
                          style={{
                            minHeight: 28, padding: "0 12px", borderRadius: 6,
                            border: "1px solid var(--border)", background: "var(--bg-panel)",
                            color: "var(--text-muted)", cursor: "pointer", fontSize: 12,
                          }}
                        >
                          {t("common_cancel")}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
