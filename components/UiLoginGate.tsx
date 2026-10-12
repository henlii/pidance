"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { syncServerPrefsFromServer } from "@/lib/server-preferences";
import { reconnectAppEvents } from "@/lib/app-events-stream";

type AuthStatus = {
  authenticated: boolean;
  passwordRequired?: boolean;
  locked?: boolean;
};

type Props = {
  children: React.ReactNode;
};

/**
 * #18 页内登录门：启用密码时先查 /api/auth/ui-session，未认证则渲染登录表单。
 * 未设密码或已认证时直接渲染子树。
 */
export function UiLoginGate({ children }: Props) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<"loading" | "login" | "ready">("loading");
  const [password, setPassword] = useState("");
  const [trustDevice, setTrustDevice] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/ui-session", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = (await res.json().catch(() => ({}))) as AuthStatus;
      if (!data.passwordRequired) {
        setPhase("ready");
        return;
      }
      if (res.ok && data.authenticated) {
        setPhase("ready");
        return;
      }
      setPhase("login");
    } catch {
      // 网络失败时仍尝试进入（middleware 会拦 API）
      setPhase("login");
    }
  }, []);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  const onSubmit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/ui-session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, trustDevice }),
      });
      const data = await res.json().catch(() => ({})) as {
        error?: string;
        retryAfter?: number;
        authenticated?: boolean;
      };
      if (res.status === 429) {
        setError(t("auth_loginRateLimited", { seconds: data.retryAfter ?? 60 }));
        return;
      }
      if (!res.ok || !data.authenticated) {
        setError(data.error === "Invalid credentials" ? t("auth_invalidCredentials") : (data.error ?? t("auth_loginFailed")));
        return;
      }
      setPassword("");
      reconnectAppEvents();
      void syncServerPrefsFromServer();
      if (typeof window !== "undefined" && typeof window.location?.reload === "function") {
        window.location.reload();
        return;
      }
      setPhase("ready");
    } catch {
      setError(t("auth_loginFailed"));
    } finally {
      setSubmitting(false);
    }
  }, [password, submitting, t, trustDevice]);

  if (phase === "loading") {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)", color: "var(--text-muted)", fontSize: 13 }}>
        {t("auth_checking")}
      </div>
    );
  }

  if (phase === "login") {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)", padding: 24 }}>
        <form
          onSubmit={(e) => { void onSubmit(e); }}
          style={{
            width: "100%",
            maxWidth: 360,
            padding: "28px 24px",
            borderRadius: "var(--radius-md, 10px)",
            border: "1px solid var(--border)",
            background: "var(--bg-panel)",
            boxShadow: "var(--shadow-float, 0 8px 28px rgba(0,0,0,0.12))",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/pidance-logo.png" alt="" width={32} height={32} style={{ borderRadius: 8 }} />
            <div>
              <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text)" }}>{t("auth_loginTitle")}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{t("auth_loginHint")}</div>
            </div>
          </div>
          <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
            {t("auth_password")}
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              style={{
                display: "block",
                width: "100%",
                marginTop: 6,
                height: 36,
                padding: "0 10px",
                boxSizing: "border-box",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text)",
                fontSize: 14,
              }}
            />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, fontSize: 12, color: "var(--text-muted)", cursor: "pointer", userSelect: "none" }}>
            <input
              type="checkbox"
              checked={trustDevice}
              onChange={(e) => setTrustDevice(e.target.checked)}
              disabled={submitting}
            />
            {t("auth_trustDevice")}
          </label>
          {error && (
            <div role="alert" style={{ marginTop: 12, fontSize: 12, color: "var(--status-danger)", lineHeight: 1.4 }}>
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={submitting || !password}
            style={{
              marginTop: 18,
              width: "100%",
              height: 36,
              border: "none",
              borderRadius: 6,
              background: !password || submitting ? "var(--border)" : "var(--accent)",
              color: !password || submitting ? "var(--text-dim)" : "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: !password || submitting ? "not-allowed" : "pointer",
            }}
          >
            {submitting ? t("auth_loggingIn") : t("auth_login")}
          </button>
        </form>
      </div>
    );
  }

  return <>{children}</>;
}

/** 退出登录：清 Cookie 后刷新以回到登录门。 */
export async function logoutUiSession(): Promise<void> {
  await fetch("/api/auth/ui-session", {
    method: "DELETE",
    credentials: "same-origin",
  }).catch(() => undefined);
  window.location.reload();
}
