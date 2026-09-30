"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useAnchoredOverlay } from "@/hooks/useAnchoredOverlay";
import { useI18n } from "@/lib/i18n";
import type { SessionStatsInfo } from "@/lib/pi-types";

/**
 * 服务端下发的本轮读数。字段与 `lib/browser-session-runtime-registry.ts` 的
 * `TurnMetrics` 一致：host 是唯一权威，客户端只渲染。
 */
export interface TurnMetricsView {
  tokensPerSecond?: number;
  /** 整轮首个 step 的 TTFT。 */
  ttftMs?: number;
  /** 每步 TTFT 的平均值。 */
  ttftAvgMs?: number;
  /** 模型用时（step 请求发出 → 消息结束）合计。 */
  llmMs?: number;
  /** 工具调用用时合计。 */
  toolMs?: number;
  /** 已结算的步骤数。 */
  steps?: number;
  /** 本轮 provider 上报的输出词元合计。 */
  outputTokens?: number;
}

interface ContextUsageView {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

interface Props {
  open: boolean;
  /** 弹窗面板的 id：按钮用 aria-controls 指向它。 */
  panelId: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  turnMetrics: TurnMetricsView | null;
  sessionStats: SessionStatsInfo | null;
  contextUsage: ContextUsageView | null;
  isMobile: boolean;
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}

/** 与 dsh 的显示习惯一致：<60s 保留一位小数，再长走 m/s。 */
function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

function formatLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** 命中率取整：整数四舍五入会撞上 100% 时退一位小数，避免「99.6%」显示成满命中。 */
function formatCacheHit(percent: number): string {
  const rounded = Math.round(percent);
  return rounded >= 100 ? `${Math.floor(percent * 10) / 10}%` : `${rounded}%`;
}

function formatTps(tps: number): string {
  return tps >= 10 ? String(Math.round(tps)) : String(Math.round(tps * 10) / 10);
}

/**
 * 顶栏统计读数的气泡弹窗：上半是本轮的速度与用时（对齐 dsh 的「会话统计」气泡），
 * 下半是会话累计的词元用量（对齐 dsh 的「Token 用量」气泡）。
 *
 * 会话块的模型/工具用时 pidance 算不出来：历史 JSONL 只留 message 时间戳，
 * 没有首 token 与 step 边界，所以那几项只给本轮值。
 */
export function SessionStatsPopover({
  open, panelId, anchorRef, onClose, turnMetrics, sessionStats, contextUsage, isMobile,
}: Props) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const overlay = useAnchoredOverlay({
    open,
    anchorRef,
    overlayRef: panelRef,
    align: "end",
    gap: 6,
    margin: 8,
    minHeight: 180,
    maxWidth: isMobile ? undefined : 320,
    width: isMobile ? "max" : 300,
  });

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return; // 按钮自己的 toggle 负责关闭
      onClose();
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [anchorRef, onClose, open]);

  useEffect(() => {
    if (!open) return;
    const onDocKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      anchorRef.current?.focus();
    };
    document.addEventListener("keydown", onDocKeyDown);
    return () => document.removeEventListener("keydown", onDocKeyDown);
  }, [anchorRef, onClose, open]);

  // 打开后把焦点移入面板：键盘用户从按钮进来就能读到内容（定位就绪后再 focus）。
  useEffect(() => {
    if (!open || !overlay.ready) return;
    panelRef.current?.focus();
  }, [open, overlay.ready]);

  if (!open) return null;

  const section = (title: string, rows: [string, string][]) => rows.length === 0 ? null : (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", letterSpacing: 0.2 }}>{title}</div>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12 }}>
          <span style={{ color: "var(--text-muted)" }}>{label}</span>
          <span style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{value}</span>
        </div>
      ))}
    </div>
  );

  const runRows: [string, string][] = [];
  if (turnMetrics) {
    const tps = turnMetrics.tokensPerSecond;
    if (typeof tps === "number" && Number.isFinite(tps) && tps > 0) {
      runRows.push([t("app_outputSpeed"), `${formatTps(tps)} ${t("app_tokensPerSecondUnit")}`]);
    }
    const ttft = turnMetrics.ttftAvgMs ?? turnMetrics.ttftMs;
    if (typeof ttft === "number" && ttft >= 0) runRows.push([t("app_ttftAvg"), formatLatency(ttft)]);
    if (typeof turnMetrics.llmMs === "number" && turnMetrics.llmMs > 0) {
      runRows.push([t("app_modelTime"), formatDuration(turnMetrics.llmMs)]);
    }
    if (typeof turnMetrics.toolMs === "number" && turnMetrics.toolMs > 0) {
      runRows.push([t("app_toolTime"), formatDuration(turnMetrics.toolMs)]);
    }
    if (typeof turnMetrics.steps === "number" && turnMetrics.steps > 0) {
      runRows.push([t("app_steps"), String(turnMetrics.steps)]);
    }
    if (typeof turnMetrics.outputTokens === "number" && turnMetrics.outputTokens > 0) {
      runRows.push([t("app_output"), turnMetrics.outputTokens.toLocaleString()]);
    }
  }

  const sessionRows: [string, string][] = [];
  if (sessionStats) {
    const { tokens } = sessionStats;
    const billedInput = tokens.input + tokens.cacheRead + tokens.cacheWrite;
    if (billedInput > 0) {
      sessionRows.push([t("app_cacheHit"), formatCacheHit((tokens.cacheRead / billedInput) * 100)]);
    }
    sessionRows.push([t("app_input"), tokens.input.toLocaleString()]);
    if (tokens.cacheRead > 0) sessionRows.push([t("app_cacheRead"), tokens.cacheRead.toLocaleString()]);
    if (tokens.cacheWrite > 0) sessionRows.push([t("app_cacheWrite"), tokens.cacheWrite.toLocaleString()]);
    sessionRows.push([t("app_output"), tokens.output.toLocaleString()]);
    sessionRows.push([t("app_total"), tokens.total.toLocaleString()]);
    if (sessionStats.cost > 0) sessionRows.push([t("app_cost"), `$${sessionStats.cost.toFixed(4)}`]);
  }
  const ctx = contextUsage ?? sessionStats?.contextUsage ?? null;
  if (ctx?.contextWindow) {
    const pct = ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?";
    sessionRows.push([t("app_context"), `${pct} / ${formatCompact(ctx.contextWindow)}`]);
  }
  if (sessionStats) {
    sessionRows.push([t("app_user"), sessionStats.userMessages.toLocaleString()]);
    sessionRows.push([t("app_toolCalls"), sessionStats.toolCalls.toLocaleString()]);
  }

  return createPortal(
    <div
      ref={panelRef}
      id={panelId}
      role="dialog"
      tabIndex={-1}
      aria-label={t("app_sessionStats")}
      data-session-stats-popover
      style={{
        ...overlay.style,
        zIndex: 520,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: "10px 12px",
        background: "var(--bg-elevated, var(--bg-secondary, var(--bg)))",
        border: "1px solid var(--border)",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.28)",
        overflowY: "auto",
        fontSize: 12,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{t("app_sessionStats")}</div>
      {section(t("app_thisRun"), runRows)}
      {section(t("app_sessionTotals"), sessionRows)}
      {runRows.length === 0 && sessionRows.length === 0 && (
        <div style={{ color: "var(--text-muted)" }}>{t("app_sessionInfoAfterMessageHint")}</div>
      )}
    </div>,
    document.body,
  );
}
