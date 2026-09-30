"use client";

import { useEffect, useState } from "react";

/**
 * 根布局级错误边界（App Router 约定文件）。
 *
 * `app/error.tsx` 盖不住**根布局自身**的异常（那时 I18nProvider 还没挂上，整棵树会直接
 * 白屏）。这个文件是最外层保险：它必须自带 <html>/<body>，因此也不能用 `useI18n()`
 * —— 按 `documentElement.lang` 直接选一段文案（客户端组件，render 时 document 可用）。
 */
const COPY = {
  zh: {
    title: "界面启动失败",
    body: "页面在挂载最外层布局时抛错。错误内容见下方，完整堆栈在浏览器控制台（F12）。刷新通常可以恢复。",
    reload: "刷新页面",
  },
  en: {
    title: "The UI failed to start",
    body: "An error was thrown while mounting the root layout. The message is below; the full stack is in the browser console (F12). Reloading usually recovers.",
    reload: "Reload page",
  },
} as const;

export default function GlobalError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  const [lang, setLang] = useState<"zh" | "en">("en");

  useEffect(() => {
    setLang((document.documentElement.lang || "").toLowerCase().startsWith("zh") ? "zh" : "en");
    console.error("[pidance] 根布局渲染异常（已由 global-error 接住，未白屏）:", error);
  }, [error]);

  const copy = COPY[lang];
  return (
    <html lang={lang} translate="no">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          padding: 24,
          background: "#111",
          color: "#eee",
          textAlign: "center",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600 }}>{copy.title}</div>
        <p style={{ margin: 0, maxWidth: 560, fontSize: 13, lineHeight: 1.6, color: "#aaa" }}>{copy.body}</p>
        <pre
          style={{
            margin: 0,
            maxWidth: 560,
            maxHeight: 160,
            overflow: "auto",
            textAlign: "left",
            padding: "8px 10px",
            border: "1px solid #333",
            borderRadius: 6,
            color: "#ccc",
            fontSize: 11,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {error.message || String(error)}
          {error.digest ? `\n(digest: ${error.digest})` : ""}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            height: 32,
            padding: "0 14px",
            border: "none",
            borderRadius: 6,
            background: "#4a7",
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {copy.reload}
        </button>
      </body>
    </html>
  );
}
