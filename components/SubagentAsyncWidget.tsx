"use client";

/**
 * pi-subagents 异步状态面板（Web 版）。
 *
 * 对应 TUI 的 aboveEditor widget：pi-subagents 在终端里画
 * `⠋ worker · 12s · bash` + `⎿ bash 10ms · 1 turns · 1 tools` 这样的行；
 * 宿主报告 rpc 模式时它发的是同一份数据的一行快照（`PI_SUBAGENT_ASYNC_JSON:{…}`），
 * 这里解码后按同样的行结构渲染，样式改用 Pidance 的 token。
 *
 * 有意不搬终端键位提示（`↓/← to inspect`）：Web 面板本身就是可折叠卡片，
 * 子会话导航在顶栏谱系下拉里（那里才有真正的会话 id，不靠 label 猜）。
 */

import { useMemo } from "react";
import { useI18n } from "@/lib/i18n";
import {
  summarizeSubagentAsyncSnapshot,
  type SubagentAsyncRow,
  type SubagentAsyncSnapshot,
  type SubagentAsyncState,
} from "@/lib/subagent-async-widget";

function formatDuration(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** 状态字形与颜色：与 TUI 的 widgetStatusGlyph 同一套语义。 */
function stateGlyph(state: SubagentAsyncState): { glyph: string; color: string } {
  switch (state) {
    case "running":
      return { glyph: "●", color: "var(--accent)" };
    case "queued":
      return { glyph: "◦", color: "var(--text-muted)" };
    case "complete":
      return { glyph: "✓", color: "var(--status-success)" };
    case "paused":
    case "stopped":
      return { glyph: "■", color: "var(--status-warning, var(--text-muted))" };
    default:
      return { glyph: "✗", color: "var(--status-danger)" };
  }
}

type SubagentStateLabelKey =
  | "subagent_state_running"
  | "subagent_state_queued"
  | "subagent_state_complete"
  | "subagent_state_failed"
  | "subagent_state_partial"
  | "subagent_state_paused"
  | "subagent_state_stopped"
  | "subagent_state_rejected";

function stateLabelKey(state: SubagentAsyncState): SubagentStateLabelKey {
  switch (state) {
    case "running": return "subagent_state_running";
    case "queued": return "subagent_state_queued";
    case "complete": return "subagent_state_complete";
    case "failed": return "subagent_state_failed";
    case "partial": return "subagent_state_partial";
    case "paused": return "subagent_state_paused";
    case "stopped": return "subagent_state_stopped";
    default: return "subagent_state_rejected";
  }
}

export function SubagentAsyncWidget({ snapshot, collapsed = false, onToggleCollapse }: {
  snapshot: SubagentAsyncSnapshot;
  /** 折叠开关（与通用扩展部件共用同一套折叠状态，按 widget key 持久化）。 */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { t } = useI18n();
  const summary = useMemo(() => summarizeSubagentAsyncSnapshot(snapshot), [snapshot]);
  const single = snapshot.runs.length === 1 ? snapshot.runs[0] : null;
  const active = summary.running > 0 || summary.queued > 0;

  const detailOf = (row: SubagentAsyncRow): string[] => {
    const parts: string[] = [];
    if (row.tool) {
      const toolMs = formatDuration(row.toolMs);
      parts.push(toolMs ? `${row.tool} ${toolMs}` : row.tool);
    }
    if (row.turns !== null && row.turns > 0) parts.push(t("subagent_widgetTurns", { count: row.turns }));
    if (row.tools !== null && row.tools > 0) parts.push(t("subagent_widgetTools", { count: row.tools }));
    return parts;
  };

  return (
    <div style={{ padding: "7px 9px", display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, lineHeight: 1.4 }}>
        <span aria-hidden="true" style={{ color: active ? "var(--accent)" : "var(--text-dim)", fontSize: 11 }}>◆</span>
        <span style={{ color: active ? "var(--accent)" : "var(--text-dim)", fontSize: 12, fontWeight: 600 }}>
          {single ? t("subagent_widgetSingle", { name: single.label }) : t("subagent_widgetTitle")}
        </span>
        <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
          {t("subagent_widgetBackground")}
          {summary.queued > 0 ? ` · ${t("subagent_widgetQueued", { count: summary.queued })}` : ""}
          {summary.hidden > 0 ? ` · ${t("subagent_widgetMore", { count: summary.hidden })}` : ""}
          {summary.byteLimitExceeded ? ` · ${t("subagent_widgetTruncated")}` : ""}
        </span>
        {onToggleCollapse ? (
          // 与通用扩展部件同一套折叠语义（aria-expanded + 展开/折叠文案），
          // 只是把开关放在标题行里 —— 这个面板的标题由数据给，不走通用卡片头。
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            title={collapsed ? t("extension_widgetExpand", { name: t("subagent_widgetTitle") }) : t("extension_widgetCollapse", { name: t("subagent_widgetTitle") })}
            aria-label={collapsed ? t("extension_widgetExpand", { name: t("subagent_widgetTitle") }) : t("extension_widgetCollapse", { name: t("subagent_widgetTitle") })}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginLeft: "auto",
              padding: "1px 5px",
              border: "none",
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
            }}
          >
            <svg
              width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor"
              strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
              style={{ transform: collapsed ? "none" : "rotate(90deg)", transition: "transform 0.15s ease" }}
            >
              <polyline points="4 2.5 7.5 6 4 9.5" />
            </svg>
          </button>
        ) : null}
      </div>

      {collapsed ? null : summary.rows.map((row) => {
        const { glyph, color } = stateGlyph(row.state);
        const elapsed = formatDuration(row.elapsedMs);
        const details = detailOf(row);
        return (
          <div
            key={`${row.id}:${row.depth}`}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 5,
              paddingLeft: row.depth * 14,
              fontSize: 11.5,
              lineHeight: 1.5,
              fontFamily: "var(--font-mono)",
            }}
          >
            <span aria-hidden="true" style={{ color, flexShrink: 0 }}>{glyph}</span>
            <span style={{ color: "var(--text)", flexShrink: 0 }}>{row.label}</span>
            <span style={{ color, flexShrink: 0 }}>{t(stateLabelKey(row.state))}</span>
            {elapsed && <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>{elapsed}</span>}
            {details.length > 0 && (
              <span style={{ color: "var(--text-dim)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                ⎿ {details.join(" · ")}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
