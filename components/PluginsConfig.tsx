"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import { CircleArrowUp, LoaderCircle, RefreshCw, RotateCw } from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { PluginPackageInfo, PluginsResponse } from "@/lib/api-types";
import { shortenPath } from "@/lib/file-paths";
import { useI18n } from "@/lib/i18n";
import { getServerPref, setServerPref } from "@/lib/server-preferences";

type PluginScope = PluginPackageInfo["scope"];
type PluginAction = "install" | "remove" | "update" | "disable" | "enable";

function packageKey(pkg: Pick<PluginPackageInfo, "source" | "scope">): string {
  return `${pkg.scope}\0${pkg.source}`;
}

function resourceSummary(pkg: PluginPackageInfo, t: ReturnType<typeof useI18n>["t"]): string {
  if (pkg.disabled) return t("plugins_disabled");
  const parts = [
    pkg.counts.extensions ? t("plugins_countExtensions", { count: pkg.counts.extensions }) : "",
    pkg.counts.skills ? t("plugins_countSkills", { count: pkg.counts.skills }) : "",
    pkg.counts.prompts ? t("plugins_countPrompts", { count: pkg.counts.prompts }) : "",
    pkg.counts.themes ? t("plugins_countThemes", { count: pkg.counts.themes }) : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : t("plugins_noResources");
}

function versionSummary(pkg: PluginPackageInfo, t: ReturnType<typeof useI18n>["t"]): string {
  const parts = [];
  if (pkg.version) parts.push(t("plugins_versionInstalled", { version: pkg.version }));
  if (pkg.configuredVersion) parts.push(t("plugins_versionConfigured", { version: pkg.configuredVersion }));
  return parts.length ? parts.join(" · ") : t("common_unknown");
}

function installLocation(scope: PluginScope, cwd: string): string {
  return scope === "project"
    ? `${shortenPath(cwd)}/.pi/agent/{npm,git}`
    : "~/.pi/agent/{npm,git}";
}

function findInstalledPackage(
  packages: PluginPackageInfo[],
  source: string,
  scope: PluginScope,
): PluginPackageInfo | undefined {
  const trimmed = source.trim();
  const withoutNpmPrefix = trimmed.startsWith("npm:") ? trimmed.slice(4) : trimmed;
  return packages.find((pkg) => pkg.scope === scope && pkg.source === trimmed)
    ?? packages.find((pkg) => pkg.scope === scope && pkg.source === `npm:${withoutNpmPrefix}`)
    ?? packages.find((pkg) => pkg.scope === scope && pkg.source.endsWith(trimmed));
}

function statusColor(status: PluginPackageInfo["status"]): string {
  if (status === "loaded") return "var(--accent)";
  if (status === "installed") return "var(--status-warning)";
  if (status === "disabled") return "var(--text-dim)";
  return "var(--status-danger)";
}

function ResourceList({ pkg }: { pkg: PluginPackageInfo }) {
  const { t } = useI18n();
  const groups = ([
    ["extension", t("plugins_extensions")],
    ["skill", t("plugins_skills")],
    ["prompt", t("plugins_prompts")],
    ["theme", t("plugins_themes")],
  ] as const)
    .map(([kind, label]) => ({
      kind,
      label,
      resources: pkg.resources.filter((resource) => resource.kind === kind),
    }))
    .filter((group) => group.resources.length > 0);

  if (groups.length === 0) {
    return (
      <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
        {pkg.disabled ? t("plugins_packageDisabled") : t("plugins_noResolved")}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {groups.map((group, groupIndex) => (
        <div
          key={group.kind}
          style={{
            borderTop: groupIndex === 0 ? "none" : "1px solid var(--border)",
            paddingTop: groupIndex === 0 ? 0 : 12,
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "var(--text-dim)",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            {group.label}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {group.resources.map((resource) => (
              <div key={`${resource.kind}:${resource.path}`} style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--text)",
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={resource.path}
                >
                  {resource.name}
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--text-dim)",
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    marginTop: 1,
                  }}
                  title={resource.path}
                >
                  {resource.relativePath}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ScopeTag({ scope }: { scope: PluginScope }) {
  const { t } = useI18n();
  return (
    <span
      style={{
        fontSize: 10,
        padding: "1px 5px",
        borderRadius: 3,
        flexShrink: 0,
        background: scope === "project" ? "rgba(99,102,241,0.12)" : "rgba(120,120,120,0.12)",
        color: scope === "project" ? "rgba(99,102,241,0.85)" : "var(--text-dim)",
      }}
    >
      {scope === "project" ? t("common_project") : t("common_global")}
    </span>
  );
}

function buttonStyle(disabled?: boolean, danger?: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    background: danger ? "var(--status-danger-bg)" : "none",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: danger ? "var(--status-danger)" : "var(--text-muted)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 12,
    opacity: disabled ? 0.5 : 1,
  };
}

// icon-only 操作按钮：与 buttonStyle 同一套描边/禁用语言，26×26 方盒。
function iconButtonStyle(disabled?: boolean): React.CSSProperties {
  return {
    width: 26,
    height: 26,
    padding: 0,
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: disabled ? "var(--text-dim)" : "var(--text-muted)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    boxSizing: "border-box",
  };
}

function Toggle({
  enabled,
  loading,
  onToggle,
  label,
}: {
  enabled: boolean;
  loading: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={loading}
      title={label}
      aria-label={label}
      aria-pressed={enabled}
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
        opacity: loading ? 0.65 : 1,
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

function SegmentedScope({
  value,
  onChange,
}: {
  value: PluginScope;
  onChange: (scope: PluginScope) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        display: "inline-flex",
        border: "1px solid var(--border)",
        borderRadius: 7,
        overflow: "hidden",
        height: 30,
      }}
    >
      {(["global", "project"] as PluginScope[]).map((scope) => {
        const active = value === scope;
        return (
          <button
            key={scope}
            onClick={() => onChange(scope)}
            style={{
              width: 76,
              border: "none",
              borderRight: scope === "global" ? "1px solid var(--border)" : "none",
              background: active ? "var(--bg-selected)" : "none",
              color: active ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {scope === "project" ? t("common_project") : t("common_global")}
          </button>
        );
      })}
    </div>
  );
}

function AddPluginPanel({
  cwd,
  source,
  scope,
  busy,
  actionError,
  onSourceChange,
  onScopeChange,
  onInstall,
}: {
  cwd: string;
  source: string;
  scope: PluginScope;
  busy: boolean;
  actionError: string | null;
  onSourceChange: (value: string) => void;
  onScopeChange: (scope: PluginScope) => void;
  onInstall: () => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const examples = ["npm:@scope/pi-plugin", "git:https://github.com/user/repo", "/absolute/path/to/plugin"];

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 660, minHeight: "100%" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
          {t("plugins_add")}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
          {installLocation(scope, cwd)}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <label htmlFor="plugin-source" style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
          {t("common_source")}
        </label>
        <input
          id="plugin-source"
          ref={inputRef}
          value={source}
          onChange={(e) => onSourceChange(e.target.value)}
          placeholder="npm:@scope/package"
          style={{
            width: "100%",
            height: 36,
            padding: "0 11px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            outline: "none",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && source.trim() && !busy) onInstall();
          }}
        />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <SegmentedScope value={scope} onChange={onScopeChange} />
        <button
          type="button"
          onClick={onInstall}
          disabled={busy || !source.trim()}
          style={{
            ...buttonStyle(busy || !source.trim()),
            background: "var(--accent)",
            color: "white",
            borderColor: "var(--accent)",
          }}
        >
          {busy ? t("plugins_installing") : t("common_install")}
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
          {t("plugins_examples")}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => onSourceChange(example)}
              style={{
                width: "100%",
                minHeight: 30,
                textAlign: "left",
                padding: "6px 9px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg-panel)",
                color: "var(--text-dim)",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text-muted)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--bg-panel)";
                e.currentTarget.style.color = "var(--text-dim)";
              }}
            >
              {example}
            </button>
          ))}
        </div>
      </div>

      {actionError && (
        <div style={{ fontSize: 12, color: "var(--status-danger)", whiteSpace: "pre-wrap" }}>
          {actionError}
        </div>
      )}

      {/* 插件库搜索（npm registry） */}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14, marginTop: 4 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>
          {t("plugins_searchLibrary")}
        </div>
        <PluginLibrarySearch onPick={(name) => onSourceChange(`npm:${name}`)} />
      </div>
    </div>
  );
}

function PluginLibrarySearch({ onPick }: { onPick: (name: string) => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ name: string; version: string; description: string }> | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setError(null);
    try {
      const res = await fetch("/api/plugins/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { results?: Array<{ name: string; version: string; description: string }> };
      setResults(body.results ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResults(null);
    } finally {
      setSearching(false);
    }
  }, [query]);

  return (
    <div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runSearch();
          }}
          placeholder={t("plugins_searchLibraryPlaceholder")}
          aria-label={t("plugins_searchLibrary")}
          style={{
            flex: 1, height: 30, padding: "0 10px", borderRadius: 6,
            border: "1px solid var(--border)", background: "var(--bg)",
            color: "var(--text)", fontSize: 12, outline: "none",
          }}
        />
        <button
          type="button"
          onClick={() => void runSearch()}
          disabled={searching || !query.trim()}
          style={{
            minHeight: 30, padding: "0 12px", borderRadius: 6,
            border: "1px solid var(--border)", background: "var(--bg-panel)",
            color: "var(--text)", cursor: searching || !query.trim() ? "not-allowed" : "pointer",
            fontSize: 12, opacity: searching || !query.trim() ? 0.5 : 1,
          }}
        >
          {searching ? t("common_loading") : t("common_search")}
        </button>
      </div>
      {error && <div style={{ fontSize: 11, color: "var(--status-danger)", marginTop: 6 }}>{error}</div>}
      {results && results.length === 0 && !error && (
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>{t("plugins_searchEmpty")}</div>
      )}
      {results && results.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8, maxHeight: 240, overflowY: "auto" }}>
          {results.map((r) => (
            <button
              key={r.name}
              type="button"
              onClick={() => onPick(r.name)}
              style={{
                textAlign: "left", padding: "7px 9px", borderRadius: 6,
                border: "1px solid var(--border)", background: "var(--bg-panel)",
                color: "var(--text)", cursor: "pointer", fontSize: 11,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-panel)"; }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.name}
                </span>
                <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>v{r.version}</span>
              </div>
              {r.description && (
                <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.description}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PackageDetail({
  pkg,
  cwd,
  busyKey,
  actionError,
  actionMessage,
  sessionId,
  updateInfo,
  locked,
  onToggleLock,
  onAction,
  onReloadSession,
}: {
  pkg: PluginPackageInfo;
  cwd: string;
  busyKey: string | null;
  actionError: string | null;
  actionMessage: string | null;
  sessionId: string | null;
  updateInfo: { latest: string | null; hasUpdate: boolean } | null;
  locked: boolean;
  onToggleLock: () => void;
  onAction: (action: PluginAction, pkg: PluginPackageInfo) => void;
  onReloadSession: () => void;
}) {
  const { t } = useI18n();
  const key = packageKey(pkg);
  const busy = busyKey?.endsWith(key) ?? false;
  const reloadBusy = busyKey === "reload";
  const enabled = !pkg.disabled;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 680 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, minWidth: 0, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 180, flex: 1 }}>
          <Toggle
            enabled={enabled}
            loading={busy || reloadBusy}
            onToggle={() => onAction(pkg.disabled ? "enable" : "disable", pkg)}
            label={pkg.disabled ? t("plugins_enable") : t("plugins_disable")}
          />
          <ScopeTag scope={pkg.scope} />
          {pkg.disabled ? (
            <span
              style={{
                fontSize: 10,
                padding: "1px 5px",
                borderRadius: 3,
                background: "rgba(120,120,120,0.12)",
                color: "var(--text-dim)",
              }}
            >
              {t("plugins_disabled")}
            </span>
          ) : pkg.filtered && (
            <span
              style={{
                fontSize: 10,
                padding: "1px 5px",
                borderRadius: 3,
                background: "color-mix(in srgb, var(--status-warning) 12%, transparent)",
                color: "var(--status-warning)",
              }}
            >
              {t("plugins_filtered")}
            </span>
          )}
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {pkg.source}
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {/* 锁定版本开关：锁定的不检查更新、隐藏升级按钮 */}
          <label
            title={t("plugins_lockVersionHint")}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              fontSize: 11, color: "var(--text-muted)", cursor: "pointer",
              padding: "4px 6px", borderRadius: 6, border: "1px solid var(--border)",
            }}
          >
            <input type="checkbox" checked={locked} onChange={onToggleLock} />
            {t("plugins_lockVersion")}
          </label>
          {updateInfo?.hasUpdate && (
            <span
              style={{
                fontSize: 10, padding: "2px 6px", borderRadius: 999,
                background: "color-mix(in srgb, var(--status-warning) 15%, transparent)",
                color: "var(--status-warning)", fontWeight: 600,
              }}
            >
              {t("plugins_updateAvailable", { latest: updateInfo.latest ?? "?" })}
            </span>
          )}
          {!locked && (
          <button
            type="button"
            onClick={() => onAction("update", pkg)}
            disabled={busy || reloadBusy}
            style={iconButtonStyle(busy || reloadBusy)}
            title={busyKey === `update:${key}` ? t("plugins_updating", { source: pkg.source }) : t("plugins_update", { source: pkg.source })}
            aria-label={busyKey === `update:${key}` ? t("plugins_updating", { source: pkg.source }) : t("plugins_update", { source: pkg.source })}
          >
            {busyKey === `update:${key}` ? (
              <LoaderCircle size={13} className="animate-spin" aria-hidden />
            ) : (
              <CircleArrowUp size={13} aria-hidden />
            )}
          </button>
          )}
          <button
            type="button"
            onClick={onReloadSession}
            disabled={!sessionId || reloadBusy || busy}
            style={iconButtonStyle(!sessionId || reloadBusy || busy)}
            title={reloadBusy ? t("plugins_reloading") : sessionId ? t("plugins_reload") : t("plugins_openSession")}
            aria-label={reloadBusy ? t("plugins_reloading") : sessionId ? t("plugins_reload") : t("plugins_openSession")}
          >
            {reloadBusy ? (
              <LoaderCircle size={13} className="animate-spin" aria-hidden />
            ) : (
              <RotateCw size={13} aria-hidden />
            )}
          </button>
          <button
            onClick={() => onAction("remove", pkg)}
            disabled={busy || reloadBusy}
            style={buttonStyle(busy || reloadBusy, true)}
          >
            {busyKey === `remove:${key}` ? t("plugins_removing") : t("common_remove")}
          </button>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(96px, 130px) minmax(0, 1fr)",
          gap: "9px 14px",
          fontSize: 12,
          lineHeight: 1.45,
        }}
      >
        <div style={{ color: "var(--text-dim)" }}>{t("common_status")}</div>
        <div style={{ color: statusColor(pkg.status), textTransform: "capitalize" }}>{pkg.status}</div>
        <div style={{ color: "var(--text-dim)" }}>{t("common_version")}</div>
        <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{versionSummary(pkg, t)}</div>
        <div style={{ color: "var(--text-dim)" }}>{t("plugins_package")}</div>
        <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          {pkg.packageName ?? t("common_unknown")}
        </div>
        <div style={{ color: "var(--text-dim)" }}>{t("common_resources")}</div>
        <div style={{ color: "var(--text-muted)" }}>{resourceSummary(pkg, t)}</div>
        <div style={{ color: "var(--text-dim)" }}>{t("plugins_installedPath")}</div>
        <div
          style={{
            color: pkg.installedPath ? "var(--text-muted)" : "var(--status-danger)",
            fontFamily: "var(--font-mono)",
            overflowWrap: "anywhere",
          }}
        >
          {pkg.installedPath ? shortenPath(pkg.installedPath) : t("plugins_notFound")}
        </div>
        <div style={{ color: "var(--text-dim)" }}>{t("plugins_cwd")}</div>
        <div style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          {shortenPath(cwd)}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>
          {t("plugins_resolvedResources")}
        </div>
        <ResourceList pkg={pkg} />
      </div>

      {actionMessage && (
        <div style={{ fontSize: 12, color: "var(--status-success)" }}>
          {actionMessage}
        </div>
      )}
      {actionError && (
        <div style={{ fontSize: 12, color: "var(--status-danger)", whiteSpace: "pre-wrap" }}>
          {actionError}
        </div>
      )}

    </div>
  );
}

export function PluginsConfig({
  cwd,
  sessionId,
  onClose,
  onReloaded,
  embedded = false,
}: {
  cwd: string;
  sessionId: string | null;
  onClose: () => void;
  onReloaded?: () => void;
  /** 嵌入模式：去掉自身的全屏遮罩/外壳，由宿主（SettingsView）提供 chrome。 */
  embedded?: boolean;
}) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [data, setData] = useState<PluginsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  /** 手机端：详情/添加页打开（全屏新页面，列表隐藏） */
  const mobileDetailOpen = addMode || selected !== null;
  /** 插件更新检查结果（packageKey → 信息） */
  const [pluginUpdates, setPluginUpdates] = useState<Record<string, { latest: string | null; hasUpdate: boolean }>>({});
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updatingAll, setUpdatingAll] = useState(false);
  /** 锁定版本（server prefs 持久化） */
  const [locks, setLocks] = useState<Record<string, boolean>>(() => {
    const raw = getServerPref<Record<string, boolean>>("pluginLocks");
    return raw && typeof raw === "object" ? raw : {};
  });
  const toggleLock = useCallback((key: string) => {
    setLocks((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      setServerPref("pluginLocks", next);
      return next;
    });
  }, []);

  /** 检查所有插件更新（锁定项跳过）。 */
  const checkAllUpdates = useCallback(async () => {
    if (!data) return;
    const targets = data.packages.filter((p) => !locks[packageKey(p)]);
    if (targets.length === 0) return;
    setCheckingUpdates(true);
    try {
      const res = await fetch("/api/plugins/updates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packages: targets.map((p) => ({ source: p.source, installed: p.version ?? p.configuredVersion ?? null })),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { updates?: Array<{ source: string; latest: string | null; hasUpdate: boolean }> };
      const map: Record<string, { latest: string | null; hasUpdate: boolean }> = {};
      for (const u of body.updates ?? []) {
        const match = targets.find((p) => p.source === u.source);
        if (match) map[packageKey(match)] = { latest: u.latest, hasUpdate: u.hasUpdate };
      }
      setPluginUpdates(map);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingUpdates(false);
    }
  }, [data, locks]);

  const [installSource, setInstallSource] = useState("");
  const [installScope, setInstallScope] = useState<PluginScope>("global");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const packages = useMemo(() => data?.packages ?? [], [data?.packages]);
  const selectedPackage = packages.find((pkg) => packageKey(pkg) === selected) ?? null;

  const groupedPackages = useMemo(() => {
    return (["project", "global"] as PluginScope[])
      .map((scope) => ({ scope, packages: packages.filter((pkg) => pkg.scope === scope) }))
      .filter((group) => group.packages.length > 0);
  }, [packages]);

  const loadPlugins = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/plugins?cwd=${encodeURIComponent(cwd)}`);
      const next = (await res.json()) as PluginsResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      setAddMode((current) => next.packages.length === 0 || current);
      setSelected((current) => {
        if (current && next.packages.some((pkg) => packageKey(pkg) === current)) return current;
        // 手机端进入只显示列表（全屏详情页不自动进入）；桌面端保留自动选中
        if (isMobile) return null;
        return next.packages[0] ? packageKey(next.packages[0]) : null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cwd, isMobile]);

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  const runAction = useCallback(async (action: PluginAction, pkg: PluginPackageInfo) => {
    const key = packageKey(pkg);
    setBusyKey(`${action}:${key}`);
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, source: pkg.source, scope: pkg.scope, cwd }),
      });
      const next = (await res.json()) as PluginsResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      if (action === "remove") {
        setSelected(next.packages[0] ? packageKey(next.packages[0]) : null);
        if (next.packages.length === 0) setAddMode(true);
        setActionMessage(t("plugins_removed"));
      } else {
        const messages: Record<Exclude<PluginAction, "remove">, string> = {
          install: t("plugins_installed"),
          update: t("plugins_updated"),
          disable: t("plugins_disabledMessage"),
          enable: t("plugins_enabled"),
        };
        setActionMessage(messages[action]);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [cwd, t]);

  /** 升级所有可更新插件（锁定项跳过）。 */
  const upgradeAll = useCallback(async () => {
    if (!data) return;
    const updatable = data.packages.filter((p) => {
      const key = packageKey(p);
      return !locks[key] && pluginUpdates[key]?.hasUpdate;
    });
    if (updatable.length === 0) return;
    setUpdatingAll(true);
    try {
      for (const pkg of updatable) {
        await runAction("update", pkg);
      }
    } finally {
      setUpdatingAll(false);
      // 升级后刷新更新状态
      void checkAllUpdates();
    }
  }, [data, locks, pluginUpdates, runAction, checkAllUpdates]);

  const installPlugin = useCallback(async () => {
    const source = installSource.trim();
    if (!source) return;
    const key = `${installScope}\0${source}`;
    setBusyKey(`install:${key}`);
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "install", source, scope: installScope, cwd }),
      });
      const next = (await res.json()) as PluginsResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      const installed = findInstalledPackage(next.packages, source, installScope);
      setSelected(installed ? packageKey(installed) : key);
      setAddMode(false);
      setInstallSource("");
      setActionMessage(t("plugins_installed"));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [cwd, installScope, installSource, t]);

  const reloadSession = useCallback(async () => {
    if (!sessionId) return;
    setBusyKey("reload");
    setActionError(null);
    setActionMessage(null);
    try {
      await sendAgentCommand(sessionId, { type: "reload" });
      onReloaded?.();
      await loadPlugins();
      setActionMessage(t("plugins_reloaded"));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [loadPlugins, onReloaded, sessionId, t]);

  const addBusy = busyKey?.startsWith("install:") ?? false;

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
              height: isMobile ? "calc(100dvh - 16px)" : "76vh",
              maxHeight: "calc(100dvh - 16px)",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              display: "flex",
              flexDirection: "column",
              boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
              overflow: "hidden",
            }}
      >
        {/* Header：独立弹窗显示标题+关闭；嵌入时只留一行项目路径说明 */}
        {embedded ? (
          <div style={{ padding: "10px 18px 0", flexShrink: 0 }}>
            <code style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
              {shortenPath(cwd)}
            </code>
          </div>
        ) : (
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
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
              {t("common_plugins")}
            </span>
            <code
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {shortenPath(cwd)}
            </code>
          </div>
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

        <div style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", overflow: "hidden" }}>
          <div
            style={{
              width: isMobile ? "100%" : 245,
              maxHeight: isMobile ? undefined : undefined,
              borderRight: isMobile ? "none" : "1px solid var(--border)",
              borderBottom: isMobile ? "1px solid var(--border)" : "none",
              display: isMobile && mobileDetailOpen ? "none" : "flex",
              flexDirection: "column",
              flexShrink: 0,
              background: "var(--bg-panel)",
            }}
          >
            <div style={{ flex: 1, overflowY: "auto", padding: "8px 6px" }}>
              {loading ? (
                <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>
                  {t("common_loading")}
                </div>
              ) : error ? (
                <div style={{ padding: "10px 8px", fontSize: 11, color: "var(--status-danger)" }}>
                  {error}
                </div>
              ) : packages.length === 0 ? (
                <div style={{ padding: "10px 8px", fontSize: 11, color: "var(--text-dim)" }}>
                  {t("plugins_noConfigured")}
                </div>
              ) : (
                groupedPackages.map((group) => (
                  <div key={group.scope} style={{ marginBottom: 6 }}>
                    <div
                      style={{
                        padding: "4px 8px 3px",
                        fontSize: 10,
                        fontWeight: 600,
                        color: "var(--text-dim)",
                        textTransform: "uppercase",
                      }}
                    >
                      {group.scope === "project" ? t("common_project") : t("common_global")}
                    </div>
                    {group.packages.map((pkg) => {
                      const key = packageKey(pkg);
                      const isSelected = !addMode && selected === key;
                      return (
                        <div
                          key={key}
                          onClick={() => {
                            setSelected(key);
                            setAddMode(false);
                            setActionError(null);
                            setActionMessage(null);
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 7,
                            padding: "8px 8px",
                            borderRadius: 5,
                            cursor: "pointer",
                            background: isSelected ? "var(--bg-selected)" : "none",
                          }}
                          onMouseEnter={(e) => {
                            if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            if (!isSelected) e.currentTarget.style.background = "none";
                          }}
                        >

                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div
                              style={{
                                fontSize: 12,
                                fontWeight: isSelected ? 600 : 400,
                                color: "var(--text)",
                                fontFamily: "var(--font-mono)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {pkg.source}
                            </div>
                            {pluginUpdates[packageKey(pkg)]?.hasUpdate && (
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
                                }}
                              >
                                {t("plugins_updateAvailable", { latest: pluginUpdates[packageKey(pkg)]?.latest ?? "?" })}
                              </span>
                            )}
                            <div
                              style={{
                                fontSize: 10,
                                color: "var(--text-dim)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                marginTop: 2,
                              }}
                            >
                              {resourceSummary(pkg, t)}
                            </div>
                            {(pkg.version || pkg.configuredVersion) && (
                              <div
                                style={{
                                  fontSize: 10,
                                  color: "var(--text-dim)",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                  marginTop: 2,
                                }}
                              >
                                {versionSummary(pkg, t)}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
            <div style={{ padding: "8px 6px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
              <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                <button
                  type="button"
                  onClick={() => void checkAllUpdates()}
                  disabled={checkingUpdates || !data}
                  style={{
                    flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                    padding: "6px 4px", borderRadius: 5, border: "1px solid var(--border)",
                    background: "var(--bg-panel)", color: "var(--text-muted)",
                    cursor: checkingUpdates || !data ? "not-allowed" : "pointer",
                    fontSize: 11, opacity: checkingUpdates || !data ? 0.5 : 1,
                  }}
                >
                  {checkingUpdates ? <LoaderCircle size={12} className="animate-spin" aria-hidden /> : <RefreshCw size={12} aria-hidden />}
                  {t("plugins_checkAllUpdates")}
                </button>
                <button
                  type="button"
                  onClick={() => void upgradeAll()}
                  disabled={updatingAll || Object.values(pluginUpdates).filter((u) => u.hasUpdate).length === 0}
                  style={{
                    flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                    padding: "6px 4px", borderRadius: 5, border: "1px solid var(--accent)",
                    background: "var(--accent)", color: "var(--accent-foreground)",
                    cursor: updatingAll || Object.values(pluginUpdates).filter((u) => u.hasUpdate).length === 0 ? "not-allowed" : "pointer",
                    fontSize: 11, fontWeight: 600,
                    opacity: updatingAll || Object.values(pluginUpdates).filter((u) => u.hasUpdate).length === 0 ? 0.5 : 1,
                  }}
                >
                  {updatingAll ? <LoaderCircle size={12} className="animate-spin" aria-hidden /> : <CircleArrowUp size={12} aria-hidden />}
                  {t("plugins_upgradeAll")}
                </button>
              </div>
              <button
                type="button"
                onClick={() => {
                  setAddMode(true);
                  setActionError(null);
                  setActionMessage(null);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 8px",
                  borderRadius: 5,
                  border: "none",
                  width: "100%",
                  cursor: "pointer",
                  background: addMode ? "var(--bg-selected)" : "none",
                  color: addMode ? "var(--accent)" : "var(--text-dim)",
                  fontSize: 12,
                }}
                onMouseEnter={(e) => {
                  if (!addMode) e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  if (!addMode) e.currentTarget.style.background = "none";
                }}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                {t("plugins_add")}
              </button>
            </div>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            {isMobile && mobileDetailOpen && (
              <button
                type="button"
                onClick={() => {
                  setSelected(null);
                  setAddMode(false);
                  setActionError(null);
                  setActionMessage(null);
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
              <AddPluginPanel
                cwd={cwd}
                source={installSource}
                scope={installScope}
                busy={addBusy}
                actionError={actionError}
                onSourceChange={setInstallSource}
                onScopeChange={setInstallScope}
                onInstall={installPlugin}
              />
            ) : loading ? null : selectedPackage ? (
              <PackageDetail
                key={packageKey(selectedPackage)}
                pkg={selectedPackage}
                cwd={cwd}
                busyKey={busyKey}
                actionError={actionError}
                actionMessage={actionMessage}
                sessionId={sessionId}
                updateInfo={pluginUpdates[packageKey(selectedPackage)] ?? null}
                locked={Boolean(locks[packageKey(selectedPackage)])}
                onToggleLock={() => toggleLock(packageKey(selectedPackage))}
                onAction={runAction}
                onReloadSession={reloadSession}
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
                {t("plugins_select")}
              </div>
            )}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 18px",
            borderTop: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <div style={{ minWidth: 0, flex: 1, fontSize: 11, color: "var(--text-dim)", overflow: "hidden" }}>
            {data?.diagnostics.length ? (
              <span
                title={data.diagnostics.map((d) => `${d.type}: ${d.source ? `${d.source}: ` : ""}${d.message}`).join("\n")}
                style={{ color: data.diagnostics.some((d) => d.type === "error") ? "var(--status-danger)" : "var(--status-warning)" }}
              >
                {t(data.diagnostics.length === 1 ? "plugins_diagnostics_one" : "plugins_diagnostics_other", { count: data.diagnostics.length })}
              </span>
            ) : (
              <span>
                {data ? t("plugins_totals", { extensions: data.totals.extensions, skills: data.totals.skills, prompts: data.totals.prompts, themes: data.totals.themes }) : ""}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => void loadPlugins()}
            disabled={loading || busyKey !== null}
            style={iconButtonStyle(loading || busyKey !== null)}
            title={loading ? t("plugins_refreshing") : t("plugins_refresh")}
            aria-label={loading ? t("plugins_refreshing") : t("plugins_refresh")}
          >
            {loading ? (
              <LoaderCircle size={13} className="animate-spin" aria-hidden />
            ) : (
              <RefreshCw size={13} aria-hidden />
            )}
          </button>
          <button onClick={onClose} style={buttonStyle(false)}>
            {t("dialog_close")}
          </button>
        </div>
      </div>
    </div>
  );
}
