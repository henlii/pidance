"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { formatShortcutKey, type ExtensionShortcutEntry } from "@/lib/extension-shortcuts";

/**
 * 「设置 → 插件 → 插件快捷键」清单（issue #105）。
 *
 * 数据来自会话状态投影里的 `extensionShortcuts`（**只读** GET，不需要写权限）：
 * 解析与冲突判定都在服务端做（复用 SDK 的 `getShortcuts`），这里只呈现。
 *
 * 为什么不可用的键也要列出来：`pi.registerShortcut` 在 Web 上有一批键绑不了
 * （浏览器保留、壳自己占用、与打字冲突）。静默丢掉会让插件作者以为自己写错了键，
 * 所以逐条给出**原因**，并且**不改键**（改键会让按 TUI 文档操作的人触发别的东西）。
 */
export function ExtensionShortcutsList({ sessionId }: { sessionId: string | null }) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<ExtensionShortcutEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setEntries(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setFailed(false);
    void (async () => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/state`);
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as { state?: { extensionShortcuts?: unknown } };
        const list = json?.state?.extensionShortcuts;
        if (!cancelled) setEntries(Array.isArray(list) ? (list as ExtensionShortcutEntry[]) : []);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const reasonLabel = (reason: ExtensionShortcutEntry["reason"]): string => {
    if (reason === "browser-reserved") return t("plugins_shortcutsReasonBrowser");
    if (reason === "shell-reserved") return t("plugins_shortcutsReasonShell");
    return t("plugins_shortcutsReasonTyping");
  };

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
      {!sessionId ? (
        <div style={{ padding: "2px 8px", fontSize: 11, color: "var(--text-dim)" }}>
          {t("plugins_shortcutsNeedsSession")}
        </div>
      ) : failed ? (
        <div style={{ padding: "2px 8px", fontSize: 11, color: "var(--status-danger)" }}>
          {t("plugins_shortcutsLoadFailed")}
        </div>
      ) : entries === null ? (
        <div style={{ padding: "2px 8px", fontSize: 11, color: "var(--text-muted)" }}>
          {t("common_loading")}
        </div>
      ) : entries.length === 0 ? (
        <div style={{ padding: "2px 8px", fontSize: 11, color: "var(--text-dim)" }}>
          {t("plugins_shortcutsEmpty")}
        </div>
      ) : (
        entries.map((entry) => (
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
        ))
      )}
    </div>
  );
}
