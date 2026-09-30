"use client";

import { useEffect } from "react";

import { useI18n } from "@/lib/i18n";

/**
 * 页面级错误边界（App Router 约定文件）。
 *
 * 为什么必须有：此前任何一次渲染期异常都会把整棵树卸掉，用户看到的就是**整页白屏**，
 * 而且没有任何可读信息 —— 只能刷新，问题也就无法反馈（用户报「压缩后整页白屏重载」
 * 时我们连错误内容都拿不到）。这个文件把异常变成一屏可读的错误 + 重试/刷新，
 * 同时把错误打到 console，便于按 F12 取证。
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useI18n();

  useEffect(() => {
    // 保留完整错误对象（页面上的文字可能被截断，console 里有栈）。
    console.error("[pidance] 页面渲染异常（已由错误边界接住，未白屏）:", error);
  }, [error]);

  return (
    <div
      role="alert"
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: 24,
        background: "var(--bg)",
        color: "var(--text)",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 600 }}>{t("app_errorTitle")}</div>
      <p style={{ margin: 0, maxWidth: 560, fontSize: 13, lineHeight: 1.6, color: "var(--text-muted)" }}>
        {t("app_errorBody")}
      </p>
      <pre
        style={{
          margin: 0,
          maxWidth: 560,
          maxHeight: 160,
          overflow: "auto",
          textAlign: "left",
          padding: "8px 10px",
          border: "1px solid var(--border)",
          borderRadius: 6,
          background: "var(--bg-subtle)",
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {error.message || String(error)}
        {error.digest ? `\n(digest: ${error.digest})` : ""}
      </pre>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={() => reset()}
          style={{
            height: 32,
            padding: "0 14px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-subtle)",
            color: "var(--text)",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          {t("app_errorRetry")}
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            height: 32,
            padding: "0 14px",
            border: "none",
            borderRadius: 6,
            background: "var(--accent)",
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {t("app_errorReload")}
        </button>
      </div>
    </div>
  );
}
