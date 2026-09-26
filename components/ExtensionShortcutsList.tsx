"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import {
  formatShortcutKey,
  shortcutListState,
  type ExtensionShortcutEntry,
  type ShortcutListState,
} from "@/lib/extension-shortcuts";

/**
 * 「设置 → 插件 → 插件快捷键」清单（issue #105）。
 *
 * 数据来自会话状态投影里的 `extensionShortcuts`（**只读** GET，不需要写权限）：
 * 解析与冲突判定都在服务端做（复用 SDK 的 `getShortcuts`，传的是有效键位），这里只呈现。
 *
 * 三件事必须如实说，不能糊过去：
 * 1. 不可用的键也列出来并写明**原因**（浏览器保留 / 壳占用 / 与打字冲突 / 与保留快捷键冲突），
 *    而且**不改键** —— 改键会让按 TUI 文档操作的人触发别的东西；
 * 2. 「拿不到状态」（只读会话 / 没有 live host）与「没有插件注册」是两回事：前者扩展压根没加载，
 *    判定在 `shortcutListState`（纯函数，有行为测试）；
 * 3. SDK 的冲突诊断原文照抄（与终端里打印的是同一句英文），让用户能逐字对照。
 */
export function ExtensionShortcutsList({ sessionId, refreshKey = 0 }: {
  sessionId: string | null;
  /** 插件装卸 / reload 后 +1：清单跟着扩展注册走，必须重新取一次。 */
  refreshKey?: number;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<ShortcutListState>({ kind: "no-session" });

  useEffect(() => {
    if (!sessionId) {
      setState({ kind: "no-session" });
      return;
    }
    let cancelled = false;
    setState({ kind: "no-session" });
    void (async () => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/state`);
        if (!res.ok) throw new Error(String(res.status));
        const payload = (await res.json()) as { state?: { extensionShortcuts?: unknown } };
        if (cancelled) return;
        setState(shortcutListState({ sessionId, payload }));
      } catch {
        if (!cancelled) setState(shortcutListState({ sessionId, failed: true }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey]);

  const reasonLabel = (reason: ExtensionShortcutEntry["reason"]): string => {
    // 与 TUI 的 `getShortcuts` 诊断一一对应（Skipping / Using extension / Using 后注册者），
    // 让用户能拿同一份理由去对照终端里的行为。
    if (reason === "browser-reserved") return t("plugins_shortcutsReasonBrowser");
    if (reason === "shell-reserved") return t("plugins_shortcutsReasonShell");
    if (reason === "sdk-conflict") return t("plugins_shortcutsReasonSdkConflict");
    return t("plugins_shortcutsReasonTyping");
  };

  /** 一行提示：键的类型取自 `t`，避免把任意字符串塞进 i18n。 */
  const hint = (key: Parameters<typeof t>[0], color = "var(--text-dim)") => (
    <div style={{ padding: "2px 8px", fontSize: 11, color }}>{t(key)}</div>
  );

  return (
    <div style={{ padding: "8px 6px 0" }}>
      <div
        style={{
          padding: "4px 8px 3px",
          fontSize: 10,
          fontWeight: 600,
          color: "var(--text-dim)",
          textTransform: "uppercase",
        }}
      >
        {t("plugins_shortcuts")}
      </div>
      {state.kind === "no-session"
        ? hint("plugins_shortcutsNeedsSession")
        : state.kind === "failed"
          ? hint("plugins_shortcutsLoadFailed", "var(--status-danger)")
          : state.kind === "no-state"
            ? hint("plugins_shortcutsNoState")
            : state.entries.length === 0
              ? hint("plugins_shortcutsEmpty")
              : state.entries.map((entry) => (
                  <div
                    key={`${entry.extensionPath}:${entry.key}`}
                    style={{ padding: "4px 8px", fontSize: 11, color: "var(--text-muted)" }}
                  >
                    <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                      <span style={{ fontFamily: "var(--font-mono, monospace)", color: "var(--text)" }}>
                        {formatShortcutKey(entry.key)}
                      </span>
                      {entry.available ? null : (
                        <span style={{ color: "var(--status-warning)", fontSize: 10 }}>
                          {t("plugins_shortcutsUnavailable")}·{reasonLabel(entry.reason)}
                        </span>
                      )}
                    </div>
                    {entry.description ? (
                      <div style={{ color: "var(--text-dim)" }}>{entry.description}</div>
                    ) : null}
                  </div>
                ))}

      {state.kind === "ready" && state.entries.length > 0 ? (
        <div style={{ padding: "6px 8px 0", fontSize: 10, color: "var(--text-dim)", lineHeight: 1.5 }}>
          {t("plugins_shortcutsPanelWindowHint")}
        </div>
      ) : null}

      {state.kind === "ready" && state.diagnostics.length > 0 ? (
        <div style={{ padding: "6px 8px 0" }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase" }}>
            {t("plugins_shortcutsDiagnostics")}
          </div>
          {state.diagnostics.map((diagnostic, index) => (
            <div
              key={`${diagnostic.path ?? ""}:${index}`}
              style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.5 }}
            >
              {/* SDK 的原文（与终端里打印的是同一句）：不翻译，用户要能逐字对照。 */}
              {diagnostic.message}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
