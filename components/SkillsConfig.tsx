"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import type {
  SkillInfo as Skill,
  SkillInstallScope,
  SkillSearchResult,
  SkillUpdateResult,
} from "@/lib/api-types";
import { shortenPath } from "@/lib/file-paths";
import { CircleArrowUp, LoaderCircle, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { getServerPref, setServerPref } from "@/lib/server-preferences";
import { SettingsPageFooter, settingsDangerIconButtonStyle, settingsPrimaryButtonStyle, settingsSecondaryButtonStyle } from "./SettingsPageFooter";

// 设置类界面的图标按钮：24×24 盒、细描边，对齐 sidebar-icon-btn 惯例；
// label 同时落在 title 与 aria-label 上，loading 时换旋转 LoaderCircle。
function IconButton({
  label,
  onClick,
  disabled = false,
  loading = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      style={{
        width: 24,
        height: 24,
        padding: 0,
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "none",
        border: "1px solid var(--border)",
        borderRadius: 5,
        color: disabled ? "var(--text-dim)" : "var(--text-muted)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        boxSizing: "border-box",
      }}
    >
      {loading ? (
        <LoaderCircle size={12} className="animate-spin" aria-hidden />
      ) : (
        children
      )}
    </button>
  );
}

function sourceLabel(skill: Skill): string {
  const src = skill.sourceInfo?.source;
  const scope = skill.sourceInfo?.scope;
  if (scope === "user" || src === "user") return "global";
  if (scope === "project" || src === "project") return "project";
  return "path";
}

function updateKey(skill: Skill): string | null {
  return skill.install
    ? `${skill.install.scope}\0${skill.install.package}`
    : null;
}

function shortVersion(version?: string): string | null {
  return version ? version.slice(0, 8) : null;
}

function Toggle({
  enabled,
  loading,
  onToggle,
}: {
  enabled: boolean;
  loading: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      onClick={onToggle}
      disabled={loading}
      title={
        enabled
          ? t("skills_visible")
          : t("skills_hidden")
      }
      style={{
        flexShrink: 0,
        width: 40,
        height: 22,
        borderRadius: 11,
        border: "none",
        padding: 0,
        cursor: loading ? "wait" : "pointer",
        background: enabled ? "var(--accent)" : "var(--border)",
        position: "relative",
        transition: "background 0.18s",
        outline: "none",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: enabled ? 21 : 3,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "var(--bg)",
          boxShadow: "0 1px 4px rgba(0,0,0,0.22)",
          transition: "left 0.18s cubic-bezier(.4,0,.2,1)",
        }}
      />
    </button>
  );
}


function SkillDetail({
  skill,
  cwd,
  onToggle,
  toggling,
  saveError,
  updateStatus,
  updating,
  updateError,
  onUpdate,
  onRemove,
  locked,
  onToggleLock,
}: {
  skill: Skill;
  cwd: string;
  onToggle: (skill: Skill) => void;
  toggling: boolean;
  saveError: string | null;
  updateStatus?: SkillUpdateResult;
  updating: boolean;
  updateError: string | null;
  onUpdate: () => void;
  onRemove: () => void;
  locked: boolean;
  onToggleLock: () => void;
}) {
  const { t } = useI18n();
  const label = sourceLabel(skill);
  const enabled = !skill.disableModelInvocation;
  const canUpdate = Boolean(skill.install?.canCheckForUpdates);
  const hasUpdate = updateStatus?.state === "update-available";
  const versionText = (() => {
    const cur = shortVersion(updateStatus?.currentVersion ?? skill.install?.versionHash) ?? t("skills_unknownVersion");
    if (hasUpdate) {
      const latest = shortVersion(updateStatus?.latestVersion) ?? "?";
      return `${cur} → ${latest}`;
    }
    return cur;
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 680 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
          <Toggle enabled={enabled} loading={toggling} onToggle={() => onToggle(skill)} />
          <span
            style={{
              fontSize: 10, padding: "1px 5px", borderRadius: 3, flexShrink: 0,
              background: label === "project" ? "rgba(99,102,241,0.12)" : "rgba(120,120,120,0.12)",
              color: label === "project" ? "rgba(99,102,241,0.8)" : "var(--text-dim)",
            }}
          >
            {label === "global" ? t("common_global") : label === "project" ? t("common_project") : t("skills_path")}
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {skill.name}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {canUpdate && (
            <label
              title={t("skills_lockVersionHint")}
              style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                fontSize: 11, color: "var(--text-muted)", cursor: "pointer",
                padding: "4px 6px", borderRadius: 6, border: "1px solid var(--border)",
              }}
            >
              <input type="checkbox" checked={locked} onChange={onToggleLock} />
              {t("skills_lockVersion")}
            </label>
          )}
          {hasUpdate && !locked && (
            <button
              type="button"
              onClick={onUpdate}
              disabled={updating}
              title={updating ? t("skills_updating") : t("skills_update")}
              aria-label={updating ? t("skills_updating") : t("skills_update")}
              style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 32, height: 32, borderRadius: 7, border: "1px solid var(--border)",
                background: "var(--bg-panel)", color: "var(--accent)", cursor: updating ? "not-allowed" : "pointer",
              }}
            >
              {updating ? <LoaderCircle size={13} className="animate-spin" aria-hidden /> : <CircleArrowUp size={13} aria-hidden />}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              if (window.confirm(t("skills_confirmRemove", { name: skill.name }))) onRemove();
            }}
            disabled={toggling || updating}
            title={t("common_remove")}
            aria-label={t("common_remove")}
            style={settingsDangerIconButtonStyle(!(toggling || updating))}
          >
            <Trash2 size={13} aria-hidden />
          </button>
        </div>
      </div>

      {skill.description && (
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{skill.description}</div>
      )}

      {skill.install && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(72px, 100px) minmax(0, 1fr)", gap: "8px 12px", fontSize: 12 }}>
          <div style={{ color: "var(--text-dim)" }}>{t("common_version")}</div>
          <div style={{ color: hasUpdate ? "var(--status-warning)" : "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{versionText}</div>
          {skill.install.package && (
            <>
              <div style={{ color: "var(--text-dim)" }}>{t("plugins_package")}</div>
              <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>{skill.install.package}</div>
            </>
          )}
        </div>
      )}

      {(saveError || updateError) && (
        <div style={{ fontSize: 12, color: "var(--status-danger)" }}>{saveError || updateError}</div>
      )}
    </div>
  );
}


function AddSkillPanel({
  cwd,
  installedPackages,
  onInstalled,
}: {
  cwd: string;
  installedPackages: Record<SkillInstallScope, ReadonlySet<string>>;
  onInstalled: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkillSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [newlyInstalledPkgs, setNewlyInstalledPkgs] = useState<Set<string>>(
    new Set(),
  );
  const [scope, setScope] = useState<"global" | "project">("global");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) return;
    setSearching(true);
    setSearchError(null);
    setResults([]);
    try {
      const res = await fetch("/api/skills/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q.trim() }),
      });
      const d = (await res.json()) as {
        results?: SkillSearchResult[];
        error?: string;
      };
      if (d.error) {
        setSearchError(d.error);
        return;
      }
      setResults(d.results ?? []);
      if ((d.results ?? []).length === 0) setSearchError(t("skills_noResults"));
    } catch (e) {
      setSearchError(String(e));
    } finally {
      setSearching(false);
    }
  }, [t]);

  const install = useCallback(
    async (pkg: string) => {
      setInstalling(pkg);
      setInstallError(null);
      try {
        const res = await fetch("/api/skills/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ package: pkg, scope, cwd }),
        });
        const d = (await res.json()) as { success?: boolean; error?: string };
        if (!res.ok || d.error) {
          setInstallError(d.error ?? `HTTP ${res.status}`);
          return;
        }
        setNewlyInstalledPkgs((prev) =>
          new Set(prev).add(`${scope}:${pkg}`),
        );
        onInstalled();
      } catch (e) {
        setInstallError(String(e));
      } finally {
        setInstalling(null);
      }
    },
    [onInstalled, scope, cwd],
  );

  const installPath =
    scope === "global"
      ? "~/.pi/agent/skills/"
      : `${shortenPath(cwd)}/.pi/skills/`;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* ── Header area ── */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          marginBottom: 20,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
          {t("skills_add")}
        </div>

        {/* Search row */}
        <div style={{ display: "flex", gap: 8 }}>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") search(query);
            }}
            placeholder="e.g. react, testing, deploy"
            style={{
              flex: 1,
              padding: "7px 10px",
              fontSize: 13,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text)",
              outline: "none",
            }}
          />
          <button
            onClick={() => search(query)}
            disabled={searching || !query.trim()}
            style={{
              padding: "7px 16px",
              fontSize: 13,
              borderRadius: 6,
              border: "none",
              background: "var(--accent)",
              color: "#fff",
              cursor: searching || !query.trim() ? "not-allowed" : "pointer",
              opacity: searching || !query.trim() ? 0.5 : 1,
              flexShrink: 0,
            }}
          >
            {searching ? t("skills_searching") : t("common_search")}
          </button>
        </div>

        {/* Scope + install path row */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              display: "flex",
              borderRadius: 5,
              border: "1px solid var(--border)",
              overflow: "hidden",
              fontSize: 12,
              flexShrink: 0,
            }}
          >
            {(["global", "project"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                style={{
                  padding: "3px 10px",
                  border: "none",
                  cursor: "pointer",
                  background: scope === s ? "var(--bg-selected)" : "none",
                  color: scope === s ? "var(--text)" : "var(--text-dim)",
                  fontWeight: scope === s ? 600 : 400,
                  borderRight:
                    s === "global" ? "1px solid var(--border)" : "none",
                }}
              >
                {s === "global" ? t("common_global") : t("common_project")}
              </button>
            ))}
          </div>
          <span
            style={{
              fontSize: 12,
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            → {installPath}
          </span>
        </div>

        {/* Errors */}
        {searchError && (
          <div style={{ fontSize: 12, color: "var(--status-danger)" }}>{searchError}</div>
        )}
        {installError && (
          <div
            style={{ fontSize: 12, color: "var(--status-danger)", wordBreak: "break-word" }}
          >
            {installError}
          </div>
        )}
      </div>

      {/* ── Results list ── */}
      {results.length > 0 ? (
        <div style={{ flex: 1, overflowY: "auto" }}>
          {results.map((r) => {
            const isInstalled =
              installedPackages[scope].has(r.package) ||
              newlyInstalledPkgs.has(`${scope}:${r.package}`);
            const isInstalling = installing === r.package;
            // split "owner/repo@skill" for cleaner display
            const atIdx = r.package.indexOf("@");
            const repopart = atIdx > -1 ? r.package.slice(0, atIdx) : r.package;
            const skillpart = atIdx > -1 ? r.package.slice(atIdx + 1) : null;
            return (
              <div
                key={r.package}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "12px 0",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* skill name prominent */}
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--text)",
                      marginBottom: 3,
                    }}
                  >
                    {skillpart ?? repopart}
                  </div>
                  {/* repo + installs + link row */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        color: "var(--text-dim)",
                      }}
                    >
                      {repopart}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        color: "var(--text-muted)",
                        fontWeight: 500,
                      }}
                    >
                      {r.installs}
                    </span>
                    {r.url && (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          fontSize: 12,
                          color: "var(--accent)",
                          textDecoration: "none",
                        }}
                      >
                        skills.sh ↗
                      </a>
                    )}
                  </div>
                </div>
                <button
                  onClick={() =>
                    !isInstalled && !isInstalling && install(r.package)
                  }
                  disabled={isInstalled || isInstalling || installing !== null}
                  style={{
                    flexShrink: 0,
                    padding: "5px 14px",
                    fontSize: 12,
                    fontWeight: 500,
                    borderRadius: 5,
                    border: "1px solid var(--border)",
                    cursor:
                      isInstalled || isInstalling || installing !== null
                        ? "not-allowed"
                        : "pointer",
                    background: isInstalled ? "var(--status-success-bg)" : "none",
                    color: isInstalled
                      ? "var(--status-success)"
                      : isInstalling
                        ? "var(--accent)"
                        : "var(--text-muted)",
                    transition: "color 0.12s",
                  }}
                >
                  {isInstalled
                    ? `${"✓"} ${t("skills_installed")}`
                    : isInstalling
                      ? t("skills_installing")
                      : t("common_install")}
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        !searchError &&
        !searching && (
          <div
            style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.8 }}
          >
            {t("skills_discoverPrefix")}{" "}
            <a
              href="https://skills.sh"
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)", textDecoration: "none" }}
            >
              skills.sh
            </a>{" "}
            {t("skills_discoverSuffix")}
          </div>
        )
      )}
    </div>
  );
}

export function SkillsConfig({
  cwd,
  onClose,
  embedded = false,
  /** 仅显示全局技能（设置页用；项目级技能在项目编辑里管理） */
  globalOnly = false,
}: {
  cwd: string;
  onClose: () => void;
  /** 嵌入模式：去掉自身的全屏遮罩/外壳，由宿主（SettingsView）提供 chrome。 */
  embedded?: boolean;
  globalOnly?: boolean;
}) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  /** 手机端：详情/添加页打开（全屏新页面，列表隐藏） */
  const mobileDetailOpen = addMode || selected !== null;
  const [updateStatuses, setUpdateStatuses] = useState<Record<string, SkillUpdateResult>>({});
  const [checkingUpdates, setCheckingUpdates] = useState<Set<string>>(new Set());
  const [checkingAll, setCheckingAll] = useState(false);
  const [updatingSkill, setUpdatingSkill] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [locks, setLocks] = useState<Record<string, boolean>>(() => {
    const raw = getServerPref<Record<string, boolean>>("skillLocks");
    return raw && typeof raw === "object" ? { ...raw } : {};
  });
  const toggleLock = useCallback((key: string) => {
    setLocks((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      setServerPref("skillLocks", next);
      return next;
    });
  }, []);


  const loadSkills = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`);
      const d = (await res.json()) as { skills?: Skill[]; error?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      const list = (d.skills ?? []).filter(
        (s) => !globalOnly || s.sourceInfo?.scope !== "project",
      );
      setSkills(list);
      // 手机端进入只显示列表；桌面端自动选中第一个
      if (list.length > 0 && !selected && !isMobile) setSelected(list[0].filePath);
      return list;
    } catch (e) {
      setError(String(e));
      return [];
    } finally {
      setLoading(false);
    }
  }, [cwd, selected]);

  useEffect(() => {
    setUpdateStatuses({});
    setUpdateError(null);
    void loadSkills();
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  const checkForUpdates = useCallback(async (skill?: Skill) => {
    const targets = skill
      ? [skill]
      : skills.filter((item) => {
          if (!item.install) return false;
          const key = updateKey(item);
          return key ? !locks[key] : false;
        });
    const keys = targets
      .map(updateKey)
      .filter((key): key is string => Boolean(key));
    if (keys.length === 0) return;

    setUpdateError(null);
    setCheckingUpdates((current) => new Set([...current, ...keys]));
    if (!skill) setCheckingAll(true);
    try {
      const res = await fetch("/api/skills/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          package: skill?.install?.package,
          scope: skill?.install?.scope,
        }),
      });
      const data = (await res.json()) as {
        updates?: SkillUpdateResult[];
        error?: string;
      };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setUpdateStatuses((current) => {
        const next = { ...current };
        for (const update of data.updates ?? []) {
          next[`${update.scope}\0${update.package}`] = update;
        }
        return next;
      });
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCheckingUpdates((current) => {
        const next = new Set(current);
        for (const key of keys) next.delete(key);
        return next;
      });
      if (!skill) setCheckingAll(false);
    }
  }, [cwd, skills, locks]);

  const updateInstalledSkill = useCallback(async (skill: Skill) => {
    if (!skill.install) return;
    const key = updateKey(skill)!;
    setUpdatingSkill(key);
    setUpdateError(null);
    try {
      const res = await fetch("/api/skills/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          package: skill.install.package,
          scope: skill.install.scope,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        skill?: Skill;
        error?: string;
      };
      if (!res.ok || data.error || !data.success) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      await loadSkills();
      const versionHash = data.skill?.install?.versionHash;
      setUpdateStatuses((current) => ({
        ...current,
        [key]: {
          package: skill.install!.package,
          scope: skill.install!.scope,
          state: "up-to-date",
          currentVersion: versionHash,
          latestVersion: versionHash,
        },
      }));
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
    } finally {
      setUpdatingSkill(null);
    }
  }, [cwd, loadSkills]);

  const removeInstalledSkill = useCallback(async (skill: Skill) => {
    setSaveError(null);
    try {
      const res = await fetch("/api/skills", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, filePath: skill.filePath }),
      });
      const d = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      setSelected(null);
      await loadSkills();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  }, [cwd, loadSkills]);

  const toggle = useCallback(async (skill: Skill) => {
    const next = !skill.disableModelInvocation;
    setToggling((s) => new Set(s).add(skill.filePath));
    setSaveError(null);
    try {
      const res = await fetch("/api/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          filePath: skill.filePath,
          disableModelInvocation: next,
        }),
      });
      const d = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || d.error) {
        setSaveError(d.error ?? `HTTP ${res.status}`);
        return;
      }
      setSkills((prev) =>
        prev.map((s) =>
          s.filePath === skill.filePath
            ? { ...s, disableModelInvocation: next }
            : s,
        ),
      );
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setToggling((s) => {
        const n = new Set(s);
        n.delete(skill.filePath);
        return n;
      });
    }
  }, []);

  const selectedSkill = skills.find((s) => s.filePath === selected) ?? null;

  return (
    <div
      style={embedded
        ? { position: "relative", display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden" }
        : {
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
      onClick={embedded ? undefined : (e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={embedded
          ? { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg)", overflow: "hidden" }
          : {
              width: isMobile ? "calc(100vw - 16px)" : 860,
              maxWidth: "calc(100vw - 16px)",
              height: isMobile ? "calc(100dvh - 16px)" : "78vh",
              maxHeight: "calc(100dvh - 16px)",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              display: "flex",
              flexDirection: "column",
              boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
              overflow: "hidden",
            }}
      >
        {/* Header：仅独立弹窗显示标题；嵌入时由 Settings 外壳提供 chrome，不显示路径 */}
        {!embedded && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 18px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
            {t("common_skills")}
          </span>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 20,
              lineHeight: 1,
              padding: "2px 6px",
            }}
          >
            ×
          </button>
        </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", overflow: "hidden" }}>
          {/* Left: skill list */}
          <div
            style={{
              width: isMobile ? "100%" : 245,
              borderRight: isMobile ? "none" : "1px solid var(--border)",
              display: isMobile && mobileDetailOpen ? "none" : "flex",
              flexDirection: "column",
              // 移动端列表页占满剩余高度（minHeight:0 让内部 overflowY 生效）；桌面端固定宽度侧栏。
              ...(isMobile ? { flex: 1, minHeight: 0 } : { flexShrink: 0 }),
              background: "var(--bg-panel)",
            }}
          >
            <div style={{ flex: 1, overflowY: "auto", padding: "8px 6px" }}>
              {loading ? (
                <div
                  style={{
                    padding: "10px 8px",
                    fontSize: 12,
                    color: "var(--text-muted)",
                  }}
                >
                  {t("skills_loading")}
                </div>
              ) : error ? (
                <div
                  style={{
                    padding: "10px 8px",
                    fontSize: 11,
                    color: "var(--status-danger)",
                  }}
                >
                  {error}
                </div>
              ) : skills.length === 0 ? (
                <div
                  style={{
                    padding: "10px 8px",
                    fontSize: 11,
                    color: "var(--text-dim)",
                  }}
                >
                  {t("skills_noResults")}
                </div>
              ) : (
                (() => {
                  const groups: { label: string; skills: typeof skills }[] = [];
                  const groupDefinitions = [
                    {
                      label: "project / skills.sh",
                      matches: (skill: Skill) =>
                        sourceLabel(skill) === "project" &&
                        Boolean(skill.install?.skillsShUrl),
                    },
                    {
                      label: "project",
                      matches: (skill: Skill) =>
                        sourceLabel(skill) === "project" &&
                        !skill.install?.skillsShUrl,
                    },
                    {
                      label: "global / skills.sh",
                      matches: (skill: Skill) =>
                        sourceLabel(skill) === "global" &&
                        Boolean(skill.install?.skillsShUrl),
                    },
                    {
                      label: "global",
                      matches: (skill: Skill) =>
                        sourceLabel(skill) === "global" &&
                        !skill.install?.skillsShUrl,
                    },
                    {
                      label: "path",
                      matches: (skill: Skill) => sourceLabel(skill) === "path",
                    },
                  ];
                  for (const { label, matches } of groupDefinitions) {
                    const grpSkills = skills.filter(matches);
                    if (grpSkills.length > 0)
                      groups.push({ label, skills: grpSkills });
                  }
                  return groups.map(
                    ({ label: grpLabel, skills: grpSkills }) => (
                      <div key={grpLabel} style={{ marginBottom: 6 }}>
                        <div
                          style={{
                            padding: "4px 8px 3px",
                            fontSize: 10,
                            fontWeight: 600,
                            color: "var(--text-dim)",
                            textTransform: "uppercase",
                          }}
                        >
                          {(() => {
                            const base = grpLabel.startsWith("project")
                              ? t("common_project")
                              : grpLabel.startsWith("global")
                                ? t("common_global")
                                : t("skills_path");
                            return grpLabel.endsWith("skills.sh") ? `${base} / skills.sh` : base;
                          })()}
                        </div>
                        {grpSkills.map((skill) => {
                          const isSelected =
                            !addMode && selected === skill.filePath;
                          const disabled = skill.disableModelInvocation;
                          const key = updateKey(skill);
                          const status = key ? updateStatuses[key] : undefined;
                          const hasUpdate = status?.state === "update-available";
                          const versionHash = shortVersion(skill.install?.versionHash);
                          return (
                            <div
                              key={skill.filePath}
                              onClick={() => {
                                setSelected(skill.filePath);
                                setAddMode(false);
                              }}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 7,
                                padding: "8px 8px",
                                borderRadius: 5,
                                cursor: "pointer",
                                background: isSelected
                                  ? "var(--bg-selected)"
                                  : "none",
                              }}
                              onMouseEnter={(e) => {
                                if (!isSelected)
                                  e.currentTarget.style.background =
                                    "var(--bg-hover)";
                              }}
                              onMouseLeave={(e) => {
                                if (!isSelected)
                                  e.currentTarget.style.background = "none";
                              }}
                            >
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div
                                  style={{
                                    fontSize: 12,
                                    fontWeight: isSelected ? 600 : 400,
                                    color: disabled
                                      ? "var(--text-dim)"
                                      : "var(--text)",
                                    fontFamily: "var(--font-mono)",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {skill.name}
                                </div>
                                {hasUpdate && (
                                  <span
                                    style={{
                                      display: "inline-block",
                                      fontSize: 9,
                                      marginTop: 2,
                                      padding: "1px 6px",
                                      borderRadius: 999,
                                      background: "color-mix(in srgb, var(--status-warning) 18%, transparent)",
                                      color: "var(--status-warning)",
                                      fontWeight: 600,
                                      fontFamily: "var(--font-mono)",
                                    }}
                                  >
                                    {`${shortVersion(status?.currentVersion ?? skill.install?.versionHash) ?? "?"} → ${shortVersion(status?.latestVersion) ?? "?"}`}
                                  </span>
                                )}
                                {skill.description && (
                                  <div
                                    style={{
                                      fontSize: 10,
                                      color: "var(--text-dim)",
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                      marginTop: 2,
                                    }}
                                    title={skill.description}
                                  >
                                    {skill.description}
                                  </div>
                                )}
                                {versionHash && (
                                  <div
                                    style={{
                                      fontSize: 10,
                                      color: "var(--text-dim)",
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                      marginTop: 2,
                                      fontFamily: "var(--font-mono)",
                                    }}
                                  >
                                    {versionHash}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ),
                  );
                })()
              )}
            </div>
            <div style={{ padding: "8px 6px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  onClick={() => void checkForUpdates()}
                  disabled={checkingAll || updatingSkill !== null || skills.every((s) => !s.install)}
                  style={{
                    ...settingsSecondaryButtonStyle(!(checkingAll || updatingSkill !== null || skills.every((s) => !s.install))),
                    flex: 1, minHeight: 30, padding: "0 6px", fontSize: 11,
                  }}
                >
                  {checkingAll ? t("common_loading") : t("skills_checkUpdates")}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const updatable = skills.filter((s) => {
                      const key = updateKey(s);
                      return key && !locks[key] && updateStatuses[key]?.state === "update-available";
                    });
                    for (const s of updatable) await updateInstalledSkill(s);
                  }}
                  disabled={
                    updatingSkill !== null
                    || !skills.some((s) => {
                      const key = updateKey(s);
                      return key && !locks[key] && updateStatuses[key]?.state === "update-available";
                    })
                  }
                  style={{
                    flex: 1, minHeight: 30, padding: "0 6px", borderRadius: 7,
                    border: "1px solid var(--accent)", background: "var(--accent)",
                    color: "var(--accent-foreground)", fontSize: 11, fontWeight: 600,
                    cursor: updatingSkill !== null ? "not-allowed" : "pointer",
                    opacity: updatingSkill !== null ? 0.5 : 1,
                  }}
                >
                  {t("skills_upgradeAll")}
                </button>
                <button
                  type="button"
                  onClick={() => setAddMode(true)}
                  style={{
                    ...settingsSecondaryButtonStyle(true),
                    flex: 1, minHeight: 30, padding: "0 6px", fontSize: 11,
                    background: addMode ? "var(--bg-selected)" : "var(--bg-panel)",
                    color: addMode ? "var(--accent)" : "var(--text-muted)",
                  }}
                >
                  {t("skills_add")}
                </button>
              </div>
            </div>
          </div>

          {/* Right: detail or add panel */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: 20,
              // 移动端列表视图隐藏右侧占位（列表整页显示），详情/添加页全屏
              display: isMobile && !mobileDetailOpen ? "none" : undefined,
            }}
          >
            {isMobile && mobileDetailOpen && (
              <button
                type="button"
                onClick={() => {
                  setSelected(null);
                  setAddMode(false);
                  setSaveError(null);
                }}
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  minHeight: 32, padding: "0 10px", marginBottom: 12,
                  borderRadius: 7, border: "1px solid var(--border)",
                  background: "var(--bg-panel)", color: "var(--text-muted)",
                  cursor: "pointer", fontSize: 12,
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
                {t("common_back")}
              </button>
            )}
            {addMode ? (
              <AddSkillPanel
                cwd={cwd}
                installedPackages={{
                  global: new Set(
                    skills
                      .filter((skill) => skill.install?.scope === "global")
                      .map((skill) => skill.install!.package),
                  ),
                  project: new Set(
                    skills
                      .filter((skill) => skill.install?.scope === "project")
                      .map((skill) => skill.install!.package),
                  ),
                }}
                onInstalled={() => {
                  void loadSkills();
                }}
              />
            ) : loading ? null : selectedSkill ? (
              <SkillDetail
                key={selectedSkill.filePath}
                skill={selectedSkill}
                cwd={cwd}
                onToggle={toggle}
                toggling={toggling.has(selectedSkill.filePath)}
                saveError={saveError}
                updateStatus={
                  updateKey(selectedSkill)
                    ? updateStatuses[updateKey(selectedSkill)!]
                    : undefined
                }
                updating={updatingSkill === updateKey(selectedSkill)}
                updateError={updateError}
                onUpdate={() => void updateInstalledSkill(selectedSkill)}
                onRemove={() => void removeInstalledSkill(selectedSkill)}
                locked={Boolean(updateKey(selectedSkill) && locks[updateKey(selectedSkill)!])}
                onToggleLock={() => {
                  const key = updateKey(selectedSkill);
                  if (key) toggleLock(key);
                }}
              />
            ) : (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-dim)",
                  fontSize: 13,
                }}
              >
                {t("skills_select")}
              </div>
            )}
          </div>
        </div>

        <SettingsPageFooter
          fixedHint={t("skills_countHint", { count: String(skills.length) })}
          dynamicHint={
            Object.values(updateStatuses).filter((s) => s.state === "update-available").length > 0 ? (
              <span style={{ color: "var(--status-warning)" }}>
                {Object.values(updateStatuses).filter((s) => s.state === "update-available").length}{" "}
                {Object.values(updateStatuses).filter((s) => s.state === "update-available").length === 1
                  ? t("skills_updateSingle")
                  : t("skills_updatePlural")}
              </span>
            ) : saveError ? (
              <span style={{ color: "var(--status-danger)" }}>{saveError}</span>
            ) : updateError ? (
              <span style={{ color: "var(--status-danger)" }}>{updateError}</span>
            ) : null
          }
          onClose={onClose}
        />
      </div>
    </div>
  );
}
