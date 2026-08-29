"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ViewportDialog } from "./ui/ViewportDialog";
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { PluginsConfig } from "./PluginsConfig";
import { AgentDefaultsConfig } from "./AgentDefaultsConfig";
import { PromptsConfig } from "./PromptsConfig";
import { logoutUiSession } from "./UiLoginGate";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useTheme } from "@/hooks/useTheme";
import { loadStreamingEnterAction, saveStreamingEnterAction, type StreamingEnterAction } from "@/lib/ui-preferences";
import { readSoundEnabled, writeSoundEnabled } from "@/hooks/useAudio";
import { getServerPref, setServerPref, useServerPreferences } from "@/lib/server-preferences";
import { useI18n, type Locale } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/locales/en";
import { SettingsPageFooter } from "./SettingsPageFooter";
import { loadAutoUpdateCheck, saveAutoUpdateCheck } from "@/lib/ui-preferences";
import {
  SETTINGS_PAGE_STORAGE_KEY,
  getSettingsPages,
  loadStoredSettingsPage,
  nextMobileSettingsView,
  type MobileSettingsView,
  type SettingsPageId,
} from "./settings-nav";

interface SettingsViewProps {
  /** 活动项目目录；Skills/Plugins 需要，Appearance/Models 不需要 */
  cwd: string | null;
  sessionId: string | null;
  onClose: () => void;
  /** 命令面板等外部入口指定的初始页（null 时用 localStorage 记忆页） */
  initialPage?: SettingsPageId | null;
  /** Models 保存后刷新聊天区的模型列表 */
  onModelsChanged?: () => void;
  /** Models 页内认证状态变化（OAuth 登录/登出、API Key 保存/移除）后刷新模型列表 */
  onAuthStateChange?: () => void;
  /** Plugins reload 后需要重建会话（沿用旧 AppShell 行为） */
  onPluginsReloaded?: () => void;
}

/** 设置页 id → 本地化标签 key：nav 按钮、对话框标题与 section aria-label 共用同一映射。 */
function settingsPageLabelKey(id: SettingsPageId) {
  switch (id) {
    case "general":
      return "common_general";
    case "appearance":
      return "common_appearance";
    case "models":
      return "common_models";
    case "defaults":
      return "common_defaults";
    case "prompts":
      return "common_prompts";
    case "skills":
      return "common_skills";
    case "plugins":
      return "common_plugins";
      return "common_trust";
  }
}

function readInitialPage(): SettingsPageId {
  if (typeof window === "undefined") return loadStoredSettingsPage({
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
  try {
    return loadStoredSettingsPage(window.localStorage);
  } catch {
    return loadStoredSettingsPage({
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
  }
}

/** 无 cwd 页面的具体提示：保留导航项，内容区指引用户先选择项目。 */
function NeedsProjectHint({ hint }: { hint: "skills" | "plugins" }) {
  const { t } = useI18n();
  void hint;
  return (
    <div className="settings-empty-state">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      </svg>
      <div style={{ fontSize: 13, color: "var(--text)", fontWeight: 600 }}>{t("common_selectProject")}</div>
      <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6, maxWidth: 380 }}>{t("common_selectProjectHint")}</div>
    </div>
  );
}

/** 明确的二选一分段控件（主题/语言共用）：不用 toggle，选中态一目了然。 */
function SegmentedChoice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="settings-choice">
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{label}</div>
      <div
        className="settings-segmented-control"
        role="group"
        aria-label={label}
      >
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              className={`settings-segmented-option${active ? " is-active" : ""}`}
              aria-pressed={active}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 设置 → 通用：服务端变更错误码 → i18n 键。 */
const SERVER_ERROR_KEYS: Record<string, TranslationKey> = {
  password_too_short: "general_passwordTooShort",
  remote_requires_password: "general_remoteRequiresPassword",
  port_invalid: "general_portInvalid",
  bad_request: "general_badRequest",
};

/** 设置 → 通用：UI 会话登录管理（服务器密码门禁）。 */
function GeneralPage({ onClose }: { onClose?: () => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<{
    passwordRequired: boolean;
    authenticated: boolean;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [autoUpdateCheck, setAutoUpdateCheck] = useState(true);
  // 服务端密码 / 远程服务状态（/api/settings/remote）
  const [serverState, setServerState] = useState<{
    passwordSet: boolean;
    remoteEnabled: boolean;
    port: number | null;
  } | null>(null);
  const [serverFailed, setServerFailed] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [portInput, setPortInput] = useState("");
  const [savingServer, setSavingServer] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverSaved, setServerSaved] = useState(false);
  // 已登录设备列表（登录管理）
  const [devices, setDevices] = useState<
    { id: string; label: string; createdAt: number; expiresAt: number; current: boolean }[] | null
  >(null);
  const [devicesFailed, setDevicesFailed] = useState(false);
  const [removingDevice, setRemovingDevice] = useState<string | null>(null);

  useEffect(() => {
    setAutoUpdateCheck(loadAutoUpdateCheck());
  }, []);

  /** 刷新登录门禁状态（挂载与密码变更后共用）。 */
  const refreshLoginStatus = useCallback(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/ui-session", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        });
        const data = (await res.json().catch(() => ({}))) as {
          authenticated?: boolean;
          passwordRequired?: boolean;
        };
        if (cancelled) return;
        setStatus({
          passwordRequired: Boolean(data.passwordRequired),
          authenticated: Boolean(data.authenticated),
        });
        setFailed(false);
      } catch {
        if (!cancelled) {
          setFailed(true);
          setStatus(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => refreshLoginStatus(), [refreshLoginStatus]);

  /** 刷新服务端密码/远程状态。 */
  const refreshServerState = useCallback(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings/remote", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          passwordSet?: boolean;
          remoteEnabled?: boolean;
          port?: number | null;
        };
        if (cancelled) return;
        setServerState({
          passwordSet: Boolean(data.passwordSet),
          remoteEnabled: Boolean(data.remoteEnabled),
          port: typeof data.port === "number" ? data.port : null,
        });
        setServerFailed(false);
      } catch {
        if (!cancelled) setServerFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => refreshServerState(), [refreshServerState]);

  /** 刷新已登录设备列表。 */
  const refreshDevices = useCallback(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/ui-sessions", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          devices?: { id: string; label: string; createdAt: number; expiresAt: number; current: boolean }[];
        };
        if (cancelled) return;
        setDevices(Array.isArray(data.devices) ? data.devices : []);
        setDevicesFailed(false);
      } catch {
        if (!cancelled) setDevicesFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => refreshDevices(), [refreshDevices]);

  /** 删除设备：非当前设备直接移除；当前设备删除后同时清除本地 cookie（登出）。 */
  const removeDevice = useCallback(async (device: { id: string; current: boolean }) => {
    setRemovingDevice(device.id);
    try {
      const res = await fetch(`/api/auth/ui-sessions/${encodeURIComponent(device.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (device.current) {
        await logoutUiSession();
      }
      refreshDevices();
      refreshLoginStatus();
    } catch {
      setServerError(t("general_deviceRemoveFailed"));
    } finally {
      setRemovingDevice(null);
    }
  }, [refreshDevices, refreshLoginStatus, t]);

  // 服务端端口变化（加载/保存成功）时同步到输入框；用户编辑中不覆盖。
  useEffect(() => {
    if (serverState) setPortInput(serverState.port === null ? "" : String(serverState.port));
  }, [serverState]);

  /** 保存服务端密码/远程变更，成功后刷新两端状态。 */
  const putServerConfig = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    setSavingServer(true);
    setServerError(null);
    setServerSaved(false);
    try {
      const res = await fetch("/api/settings/remote", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        passwordSet?: boolean;
        remoteEnabled?: boolean;
        port?: number | null;
      };
      if (!res.ok) {
        const key = (data.error && SERVER_ERROR_KEYS[data.error]) || "general_badRequest";
        setServerError(t(key));
        return false;
      }
      setServerState({
        passwordSet: Boolean(data.passwordSet),
        remoteEnabled: Boolean(data.remoteEnabled),
        port: typeof data.port === "number" ? data.port : null,
      });
      setServerSaved(true);
      setNewPassword("");
      refreshLoginStatus();
      return true;
    } catch {
      setServerError(t("general_serverCheckFailed"));
      return false;
    } finally {
      setSavingServer(false);
    }
  }, [refreshLoginStatus, t]);

  const sectionTitle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text)",
    marginBottom: 8,
  };

  // 交互偏好（本地，非 settings.json）：回车动作 / 提示音 / 队列一次性投递
  const [streamingEnter, setStreamingEnter] = useState<StreamingEnterAction>("followUp");
  useEffect(() => {
    setStreamingEnter(loadStreamingEnterAction());
  }, []);
  const [soundEnabled, setSoundEnabled] = useState(true);
  useEffect(() => {
    setSoundEnabled(readSoundEnabled());
  }, []);
  const serverPrefs = useServerPreferences();
  // 本地 state 优先：不受 serverPrefs 同步延迟/覆盖影响，点击立即生效
  const [queueFlushAsOne, setQueueFlushAsOne] = useState(() => serverPrefs.queueFlushAsOne === true);
  useEffect(() => {
    setQueueFlushAsOne(serverPrefs.queueFlushAsOne === true);
    const remoteEnter = getServerPref<unknown>("streamingEnter");
    if (remoteEnter === "steer" || remoteEnter === "followUp") {
      setStreamingEnter(remoteEnter);
      saveStreamingEnterAction(remoteEnter);
    }
    const remoteUpdate = getServerPref<unknown>("autoUpdateCheck");
    if (typeof remoteUpdate === "boolean") {
      setAutoUpdateCheck(remoteUpdate);
      saveAutoUpdateCheck(remoteUpdate);
    }
  }, [serverPrefs]);

  let statusLabel = t("common_loading");
  if (failed) statusLabel = t("general_loginCheckFailed");
  else if (status) {
    if (!status.passwordRequired) statusLabel = t("general_loginNotRequired");
    else if (status.authenticated) statusLabel = t("general_loginAuthenticated");
    else statusLabel = t("general_loginNotAuthenticated");
  }

  const canLogout = Boolean(status?.passwordRequired && status.authenticated);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div className="settings-page-content" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
      <div style={{ marginBottom: 22 }}>
        <div style={sectionTitle}>{t("general_loginSection")}</div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6, marginBottom: 12, maxWidth: 480 }}>
          {t("general_loginHint")}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>{t("general_loginStatus")}</div>
        <div style={{ fontSize: 13, color: "var(--text)", marginBottom: 14, lineHeight: 1.5 }}>{statusLabel}</div>
        {canLogout && (
          <>
            <button
              type="button"
              disabled={loggingOut}
              onClick={() => {
                setLoggingOut(true);
                void logoutUiSession();
              }}
              style={{
                minHeight: 32,
                padding: "0 14px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                cursor: loggingOut ? "not-allowed" : "pointer",
                fontSize: 12,
                fontWeight: 600,
                opacity: loggingOut ? 0.65 : 1,
              }}
            >
              {t("auth_logout")}
            </button>
            <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-dim)", maxWidth: 420, lineHeight: 1.45 }}>
              {t("general_logoutHint")}
            </div>
            <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-dim)", maxWidth: 420, lineHeight: 1.45 }}>
              {t("general_trustedDeviceHint")}
            </div>
          </>
        )}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>
            {t("general_connectedDevices")}
          </div>
          {devicesFailed ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("general_serverCheckFailed")}</div>
          ) : devices === null ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("common_loading")}</div>
          ) : devices.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("general_noDevices")}</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 480 }}>
              {devices.map((device) => (
                <div
                  key={device.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    fontSize: 12,
                    color: "var(--text)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "8px 10px",
                    background: "var(--bg-panel)",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {device.label}
                      {device.current && (
                        <span style={{ marginLeft: 6, fontSize: 10, color: "var(--accent)" }}>
                          {t("general_thisDevice")}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
                      {new Date(device.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={removingDevice !== null}
                    onClick={() => void removeDevice(device)}
                    style={{
                      flexShrink: 0,
                      minHeight: 28,
                      padding: "0 10px",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background: "var(--bg)",
                      color: "var(--text-muted)",
                      cursor: removingDevice !== null ? "not-allowed" : "pointer",
                      fontSize: 11,
                      fontWeight: 600,
                      opacity: removingDevice !== null && removingDevice !== device.id ? 0.5 : 1,
                    }}
                  >
                    {t("general_deleteDevice")}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ marginBottom: 22 }}>
        <div style={sectionTitle}>{t("general_serverSection")}</div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6, marginBottom: 12, maxWidth: 480 }}>
          {t("general_serverHint")}
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text)", cursor: "pointer", userSelect: "none" }}>
          <input
            type="checkbox"
            checked={serverState?.remoteEnabled === true}
            disabled={savingServer || serverState === null}
            onChange={(e) => {
              const next = e.target.checked;
              if (next && serverState && !serverState.passwordSet) {
                setServerError(t("general_remoteNeedsPassword"));
                return;
              }
              void putServerConfig({ remoteEnabled: next });
            }}
            style={{ width: 16, height: 16, accentColor: "var(--accent)" }}
          />
          <span>{t("general_remoteEnabled")}</span>
        </label>
        <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-dim)", maxWidth: 420, lineHeight: 1.45 }}>
          {t("general_remoteHint")}
        </div>
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>{t("general_port")}</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="number"
              min={1}
              max={65535}
              placeholder={t("general_portPlaceholder")}
              value={portInput}
              disabled={savingServer}
              onChange={(e) => setPortInput(e.target.value)}
              style={{
                width: 130,
                padding: "7px 10px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text)",
                fontSize: 13,
                outline: "none",
              }}
            />
            <button
              type="button"
              disabled={savingServer}
              onClick={() => {
                const trimmed = portInput.trim();
                const port = trimmed === "" ? null : Number(trimmed);
                if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
                  setServerError(t("general_portInvalid"));
                  return;
                }
                void putServerConfig({ port });
              }}
              style={{
                minHeight: 32,
                padding: "0 14px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                cursor: savingServer ? "not-allowed" : "pointer",
                fontSize: 12,
                fontWeight: 600,
                opacity: savingServer ? 0.65 : 1,
              }}
            >
              {t("general_savePort")}
            </button>
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-dim)", maxWidth: 420, lineHeight: 1.45 }}>
            {t("general_portHint")}
          </div>
        </div>
        <div style={{ marginTop: 14, fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>
          {serverFailed
            ? t("general_serverCheckFailed")
            : serverState
              ? serverState.passwordSet
                ? t("general_passwordSet")
                : t("general_passwordNotSet")
              : t("common_loading")}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="password"
            placeholder={t("general_newPassword")}
            value={newPassword}
            disabled={savingServer}
            onChange={(e) => setNewPassword(e.target.value)}
            style={{
              width: 170,
              padding: "7px 10px",
              borderRadius: 7,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text)",
              fontSize: 13,
              outline: "none",
            }}
          />
          {serverState?.passwordSet && (
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("general_newPasswordHint")}</span>
          )}
          <button
            type="button"
            disabled={savingServer}
            onClick={() => {
              if (newPassword.length < 6) {
                setServerError(t("general_passwordTooShort"));
                return;
              }
              void putServerConfig({ password: newPassword });
            }}
            style={{
              minHeight: 32,
              padding: "0 14px",
              borderRadius: 7,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text)",
              cursor: savingServer ? "not-allowed" : "pointer",
              fontSize: 12,
              fontWeight: 600,
              opacity: savingServer ? 0.65 : 1,
            }}
          >
            {t("general_setPassword")}
          </button>
          {serverState?.passwordSet && (
            <button
              type="button"
              disabled={savingServer}
              onClick={() =>
                void putServerConfig({
                  clearPassword: true,
                })
              }
              style={{
                minHeight: 32,
                padding: "0 14px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                cursor: savingServer ? "not-allowed" : "pointer",
                fontSize: 12,
                fontWeight: 600,
                opacity: savingServer ? 0.65 : 1,
              }}
            >
              {t("general_clearPassword")}
            </button>
          )}
        </div>
        {serverError && (
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--error-text)", maxWidth: 420, lineHeight: 1.45 }}>
            {serverError}
          </div>
        )}
        {serverSaved && (
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-muted)" }}>{t("general_saved")}</div>
        )}
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-dim)", maxWidth: 420, lineHeight: 1.45 }}>
          {t("general_serverRestartHint")}
        </div>
      </div>

      <div style={{ marginBottom: 22 }}>
        <div style={sectionTitle}>{t("general_updateSection")}</div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6, marginBottom: 12, maxWidth: 480 }}>
          {t("general_updateHint")}
        </div>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 13,
            color: "var(--text)",
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <input
            type="checkbox"
            checked={autoUpdateCheck}
            onChange={(e) => {
              const next = e.target.checked;
              setAutoUpdateCheck(next);
              saveAutoUpdateCheck(next);
              setServerPref("autoUpdateCheck", next);
            }}
            style={{ width: 16, height: 16, accentColor: "var(--accent)" }}
          />
          <span>{t("general_autoUpdateCheck")}</span>
        </label>
      </div>

      <div>
        <div style={sectionTitle}>{t("general_interactionSection")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>{t("defaults_streamingEnter")}</div>
            <select
              value={streamingEnter}
              onChange={(e) => {
                const next = e.target.value === "steer" ? "steer" : "followUp";
                setStreamingEnter(next);
                saveStreamingEnterAction(next);
                setServerPref("streamingEnter", next);
                window.dispatchEvent(new Event("pidance:streaming-enter-changed"));
              }}
              style={{
                width: "100%", maxWidth: 420, padding: "7px 10px", borderRadius: 7,
                border: "1px solid var(--border)", background: "var(--bg)",
                color: "var(--text)", fontSize: 13, outline: "none", cursor: "pointer",
              }}
            >
              <option value="followUp">{t("defaults_streamingEnterQueue")}</option>
              <option value="steer">{t("defaults_streamingEnterSteer")}</option>
            </select>
            <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-dim)", maxWidth: 420, lineHeight: 1.45 }}>
              {t("defaults_streamingEnterHint")}
            </div>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text)", cursor: "pointer", userSelect: "none" }}>
            <input
              type="checkbox"
              checked={soundEnabled}
              onChange={(e) => {
                const next = e.target.checked;
                setSoundEnabled(next);
                writeSoundEnabled(next);
              }}
              style={{ width: 16, height: 16, accentColor: "var(--accent)" }}
            />
            {t("defaults_completionSound")}
          </label>
          <div style={{ marginTop: -6, fontSize: 11, color: "var(--text-dim)", maxWidth: 420, lineHeight: 1.45 }}>
            {t("defaults_completionSoundHint")}
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text)", cursor: "pointer", userSelect: "none" }}>
            <input
              type="checkbox"
              checked={queueFlushAsOne}
              onChange={(e) => {
                const next = e.target.checked;
                setQueueFlushAsOne(next);
                setServerPref("queueFlushAsOne", next);
              }}
              style={{ width: 16, height: 16, accentColor: "var(--accent)" }}
            />
            {t("defaults_queueFlushAsOne")}
          </label>
          <div style={{ marginTop: -6, fontSize: 11, color: "var(--text-dim)", maxWidth: 420, lineHeight: 1.45 }}>
            {t("defaults_queueFlushAsOneHint")}
          </div>
        </div>
      </div>
      </div>
      <SettingsPageFooter onClose={onClose} />
    </div>
  );
}

function AppearancePage({ onClose }: { onClose?: () => void }) {
  const { mode, themeStyle, setTheme, setThemeStyle } = useTheme();
  const { locale, setLocale, t } = useI18n();
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div className="settings-page-content" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
      <SegmentedChoice
        label={t("appearance_colorMode")}
        options={[
          { value: "light", label: t("appearance_light") },
          { value: "dark", label: t("appearance_dark") },
          { value: "system", label: t("appearance_system") },
        ]}
        value={mode}
        onChange={(next) => setTheme(next)}
      />
      <SegmentedChoice
        label={t("appearance_themeStyle")}
        options={[
          { value: "chamber", label: t("appearance_chamber") },
          { value: "fusion", label: t("appearance_fusion") },
        ]}
        value={themeStyle}
        onChange={(next) => setThemeStyle(next)}
      />
      <SegmentedChoice<Locale>
        label={t("appearance_language")}
        options={[
          { value: "en", label: "English" },
          { value: "zh-CN", label: "简体中文" },
        ]}
        value={locale}
        onChange={(next) => setLocale(next)}
      />
      <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6, maxWidth: 420 }}>
        {t("appearance_coverage")}
      </div>
      </div>
      <SettingsPageFooter onClose={onClose} />
    </div>
  );
}

export function SettingsView({ cwd, sessionId, onClose, onModelsChanged, onAuthStateChange, onPluginsReloaded, initialPage }: SettingsViewProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [activePage, setActivePage] = useState<SettingsPageId>(readInitialPage);
  // 外部入口（命令面板）指定的初始页优先于 localStorage 记忆页。
  useEffect(() => {
    if (initialPage) setActivePage(initialPage);
  }, [initialPage]);
  // 移动端「导航首页 → 页面内容」：null 表示导航首页；桌面端始终双栏。
  const [mobileView, setMobileView] = useState<MobileSettingsView>({ page: null });

  // 记忆最近页（localStorage 可安全失败）。
  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_PAGE_STORAGE_KEY, JSON.stringify(activePage));
    } catch {
      // 隐私模式或禁用存储不影响本次使用。
    }
  }, [activePage]);

  const hasCwd = Boolean(cwd);
  const pages = useMemo(() => getSettingsPages(hasCwd), [hasCwd]);
  const activePageInfo = pages.find((page) => page.id === activePage) ?? pages[0];

  const selectPage = useCallback((page: SettingsPageId) => {
    setActivePage(page);
    setMobileView((current) => nextMobileSettingsView(current, { type: "select", page }));
  }, []);
  const goMobileHome = useCallback(() => {
    setMobileView((current) => nextMobileSettingsView(current, { type: "back" }));
  }, []);

  const renderPageContent = () => {
    if (!activePageInfo.available) {
      return <NeedsProjectHint hint={activePageInfo.unavailableHint!} />;
    }
    switch (activePageInfo.id) {
      case "general":
        return <GeneralPage onClose={onClose} />;
      case "appearance":
        return <AppearancePage onClose={onClose} />;
      case "models":
        return <ModelsConfig embedded onClose={onModelsChanged ?? onClose} onAuthStateChange={onAuthStateChange} />;
      case "defaults":
        return <AgentDefaultsConfig cwd={cwd} onClose={onClose} />;
      case "prompts":
        return <PromptsConfig onClose={onClose} />;
      case "skills":
        return <SkillsConfig embedded globalOnly cwd={cwd!} onClose={onClose} />;
      case "plugins":
        return <PluginsConfig embedded cwd={cwd!} sessionId={sessionId} onClose={onClose} onReloaded={onPluginsReloaded} />;
    }
  };

  const navList = (
    <div className="settings-nav-list">
      {pages.map((page) => {
        const active = page.id === activePageInfo.id;
        return (
          <button
            key={page.id}
            type="button"
            className={`settings-nav-item${!isMobile && active ? " is-active" : ""}`}
            aria-current={!isMobile && active ? "page" : undefined}
            onClick={() => selectPage(page.id)}
            style={{
              minHeight: isMobile ? 44 : 34,
              padding: isMobile ? "0 12px" : "0 10px 0 12px",
            }}
          >
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {t(settingsPageLabelKey(page.id))}
            </span>
            {!page.available && (
              <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>{t("common_needsProject")}</span>
            )}
            {isMobile && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)", flexShrink: 0 }} aria-hidden="true">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );

  // 移动端进入页面时，标题栏左侧提供明确的 Back（ARIA 可达）。
  const mobileBackAction = isMobile && mobileView.page !== null ? (
    <button
      type="button"
      onClick={goMobileHome}
      aria-label={t("common_back")}
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 4,
        minHeight: 32,
        padding: "0 8px",
        background: "none",
        border: "none",
        borderRadius: 7,
        color: "var(--text-muted)",
        cursor: "pointer",
        fontSize: 12,
      }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="15 18 9 12 15 6" />
      </svg>
      {t("common_back")}
    </button>
  ) : undefined;

  return (
    <ViewportDialog
      open
      onClose={onClose}
      closeLabel={t("dialog_close")}
      title={isMobile && mobileView.page !== null ? t(settingsPageLabelKey(activePageInfo.id)) : t("common_settings")}
      width={920}
      zIndex={1000}
      headerActions={mobileBackAction}
      contentPadding="0"
    >
      <div className="settings-layout">
        {isMobile ? (
          mobileView.page === null ? (
            <nav aria-label={t("common_settings")} style={{ flex: 1, overflowY: "auto" }}>
              {navList}
            </nav>
          ) : (
            <section aria-label={t(settingsPageLabelKey(activePageInfo.id))} className="settings-content-pane">
              <div className="settings-scroll-region">
                {renderPageContent()}
              </div>
            </section>
          )
        ) : (
          <>
            <nav
              aria-label={t("common_settings")}
              style={{
                width: 190,
                flexShrink: 0,
                borderRight: "1px solid var(--border)",
                background: "var(--bg-panel)",
                overflowY: "auto",
              }}
            >
              {navList}
            </nav>
            <section aria-label={t(settingsPageLabelKey(activePageInfo.id))} className="settings-content-pane">
              <div className="settings-scroll-region">
                {renderPageContent()}
              </div>
            </section>
          </>
        )}
      </div>
    </ViewportDialog>
  );
}
