"use client";

import { memo, useState, useRef, useEffect, useMemo, type ReactNode } from "react";
import { AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronUp, Copy, FilePlus, FileText, GitBranch, Globe, ListTodo, Pencil, Search, ShieldCheck, Terminal, Webhook, XCircle } from "lucide-react";
import { MarkdownBody } from "./MarkdownBody";
import { copyText } from "@/lib/clipboard";
import {
  ACTIVITY_KINDS,
  PIDANCE_ACTIVITY_CUSTOM_TYPE,
  PIDANCE_ACTIVITY_VERSION,
  type ActivityKind,
  type SessionActivity,
} from "@/lib/session-activity";
import { PIDANCE_COMMAND_CUSTOM_TYPE } from "@/lib/session-command-entry";
import { getBranchSummaryFileMetadata } from "@/lib/branch-bookmarks";
import { parseCompactionSummary } from "@/lib/compaction-summary";
import { isEmptyThinkingBlock } from "@/lib/message-display";
import { parseAnsiLine } from "@/lib/ansi";
import type { ToolExecutionSnapshot, ToolExecutionStatus } from "@/lib/tool-execution-buffer";
import { parseUnifiedPatch, type SplitDiffCell } from "@/lib/patch";
import { useI18n } from "@/lib/i18n";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { extractMediaPathsFromText } from "@/lib/file-types";
import type {
  AgentMessage,
  UserMessage,
  AssistantMessage,
  CustomMessage,
  ToolResultMessage,
  BashExecutionMessage,
  AssistantContentBlock,
  TextContent,
  ImageContent,
  ToolCallContent,
  ThinkingContent,
} from "@/lib/types";

function fileApiReadUrl(filePath: string): string {
  return `/api/files/${encodeFilePathForApi(filePath)}?type=read`;
}

/** 消息内嵌媒体预览：路径附件 / 多模态图片。 */
function MessageMediaGallery({
  imageBlocks,
  pathImages,
  pathAudio,
  pathVideo,
}: {
  imageBlocks?: ImageContent[];
  pathImages?: string[];
  pathAudio?: string[];
  pathVideo?: string[];
}) {
  const blocks = imageBlocks ?? [];
  const images = pathImages ?? [];
  const audio = pathAudio ?? [];
  const video = pathVideo ?? [];
  if (blocks.length === 0 && images.length === 0 && audio.length === 0 && video.length === 0) {
    return null;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 8 }}>
      {(blocks.length > 0 || images.length > 0) && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {blocks.map((img, i) => {
            const flat = img as unknown as { data?: string; mimeType?: string };
            const src = img.source
              ? img.source.type === "base64"
                ? `data:${img.source.media_type};base64,${img.source.data}`
                : img.source.url ?? ""
              : flat.data
                ? `data:${flat.mimeType};base64,${flat.data}`
                : "";
            if (!src) return null;
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={`b-${i}`}
                src={src}
                alt=""
                style={{ maxWidth: 280, maxHeight: 280, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid var(--border)" }}
              />
            );
          })}
          {images.map((path) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={path}
              src={fileApiReadUrl(path)}
              alt={path}
              title={path}
              style={{ maxWidth: 280, maxHeight: 280, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid var(--border)" }}
            />
          ))}
        </div>
      )}
      {audio.map((path) => (
        <div key={path} style={{ minWidth: 200, maxWidth: 420 }}>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={path}>
            {path.split(/[\\/]/).pop()}
          </div>
          <audio controls preload="metadata" src={fileApiReadUrl(path)} style={{ width: "100%" }} />
        </div>
      ))}
      {video.map((path) => (
        <div key={path} style={{ minWidth: 200, maxWidth: 480 }}>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={path}>
            {path.split(/[\\/]/).pop()}
          </div>
          <video controls preload="metadata" src={fileApiReadUrl(path)} style={{ width: "100%", maxHeight: 320, borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)" }} />
        </div>
      ))}
    </div>
  );
}

const MAX_THINKING_CACHE_ENTRIES = 100;
const thinkingContentCache = new Map<string, Promise<string>>();

function loadThinkingContent(sessionId: string, entryId: string, blockIndex: number): Promise<string> {
  const key = `${sessionId}:${entryId}:${blockIndex}`;
  const cached = thinkingContentCache.get(key);
  if (cached) {
    thinkingContentCache.delete(key);
    thinkingContentCache.set(key, cached);
    return cached;
  }

  const request = fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/thinking?blockIndex=${blockIndex}`,
  ).then(async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { thinking?: unknown };
    if (typeof data.thinking !== "string") throw new Error("Invalid thinking response");
    return data.thinking;
  }).catch((error) => {
    thinkingContentCache.delete(key);
    throw error;
  });

  thinkingContentCache.set(key, request);
  if (thinkingContentCache.size > MAX_THINKING_CACHE_ENTRIES) {
    const oldestKey = thinkingContentCache.keys().next().value;
    if (oldestKey) thinkingContentCache.delete(oldestKey);
  }
  return request;
}

const MAX_TOOL_DETAILS_CACHE_ENTRIES = 50;
const toolDetailsCache = new Map<string, Promise<unknown>>();

function isDeferredHeavyToolDetails(details: unknown): boolean {
  return typeof details === "object" && details !== null && !Array.isArray(details)
    && (details as { deferredHeavy?: unknown }).deferredHeavy === true;
}

function loadToolResultDetails(sessionId: string, toolCallId: string): Promise<unknown> {
  const key = `${sessionId}:${toolCallId}`;
  const cached = toolDetailsCache.get(key);
  if (cached) {
    toolDetailsCache.delete(key);
    toolDetailsCache.set(key, cached);
    return cached;
  }

  const request = fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/tool-results/${encodeURIComponent(toolCallId)}`,
  ).then(async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { details?: unknown };
    return data.details ?? null;
  }).catch((error) => {
    toolDetailsCache.delete(key);
    throw error;
  });

  toolDetailsCache.set(key, request);
  if (toolDetailsCache.size > MAX_TOOL_DETAILS_CACHE_ENTRIES) {
    const oldestKey = toolDetailsCache.keys().next().value;
    if (oldestKey) toolDetailsCache.delete(oldestKey);
  }
  return request;
}

interface Props {
  message: AgentMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  toolExecutionSnapshots?: ToolExecutionSnapshot[];
  modelNames?: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  entryId?: string;
  /** 用户「从此处分支」：回到该消息之前（发送后形成新分支）。 */
  onBranchHere?: (entryId: string, text: string) => void;
  /** 用户「从此处开始新会话」：fork 到该消息之前，预填此消息文本。 */
  onNewSessionFromHere?: (entryId: string, text: string) => void;
  /** Assistant「基于此回答分支」：轮末锚点（选项 B），发送后长新枝。 */
  onBranchFromAssistant?: (entryId: string) => void;
  /** Assistant「基于此回答开始新会话」：fork 到该回答轮末，不预填。 */
  onNewSessionFromAnswer?: (entryId: string) => void;
  forking?: boolean;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  sessionId?: string;
}

function formatTime(ts?: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  const date = d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
  return `${date} ${time}`;
}

function haveSameRelevantToolResults(
  message: AgentMessage,
  previous: Map<string, ToolResultMessage> | undefined,
  next: Map<string, ToolResultMessage> | undefined,
): boolean {
  if (previous === next || message.role !== "assistant") return true;
  for (const block of (message as AssistantMessage).content ?? []) {
    if (block.type === "toolCall" && previous?.get(block.toolCallId) !== next?.get(block.toolCallId)) {
      return false;
    }
  }
  return true;
}

export const MessageView = memo(function MessageView({ message, isStreaming, toolResults, toolExecutionSnapshots, modelNames, cwd, onOpenFile, entryId, onBranchHere, onNewSessionFromHere, onBranchFromAssistant, onNewSessionFromAnswer, forking, showTimestamp, prevTimestamp, sessionId }: Props) {
  if (message.role === "user") {
    return <UserMessageView message={message as UserMessage} cwd={cwd} onOpenFile={onOpenFile} entryId={entryId} onBranchHere={onBranchHere} onNewSessionFromHere={onNewSessionFromHere} forking={forking} />;
  }
  if (message.role === "assistant") {
    return <AssistantMessageView message={message as AssistantMessage} isStreaming={isStreaming} toolResults={toolResults} toolExecutionSnapshots={toolExecutionSnapshots} modelNames={modelNames} cwd={cwd} onOpenFile={onOpenFile} showTimestamp={showTimestamp} prevTimestamp={prevTimestamp} sessionId={sessionId} entryId={entryId} onBranchFromAssistant={onBranchFromAssistant} onNewSessionFromAnswer={onNewSessionFromAnswer} />;
  }
  if (message.role === "toolResult") {
    // Rendered inline under its toolCall — skip standalone rendering if paired
    return null;
  }
  if (message.role === "custom") {
    if ((message as CustomMessage).customType === "compaction") {
      return <CompactionMessageView message={message as CustomMessage} />;
    }

    if ((message as CustomMessage).customType === PIDANCE_COMMAND_CUSTOM_TYPE) {
      return <CommandMessageView message={message as CustomMessage} />;
    }
    if ((message as CustomMessage).customType === "branch_summary") {
      return <BranchSummaryMessageView message={message as CustomMessage} />;
    }
    if ((message as CustomMessage).customType === PIDANCE_ACTIVITY_CUSTOM_TYPE) {
      const activity = toRenderableActivity((message as CustomMessage).details);
      if (activity) {
        return <PidanceActivityView message={message as CustomMessage} activity={activity} />;
      }
      // 非法 details：安全回退通用 custom view（转义文本，不注入、不崩溃）。
    }
    return <CustomMessageView message={message as CustomMessage} cwd={cwd} onOpenFile={onOpenFile} />;
  }
  if (message.role === "bashExecution") {
    return <BashExecutionView message={message as BashExecutionMessage} sessionId={sessionId} />;
  }
  return null;
}, (prev, next) => {
  return prev.message === next.message
    && prev.isStreaming === next.isStreaming
    && haveSameRelevantToolResults(prev.message, prev.toolResults, next.toolResults)
    && prev.toolExecutionSnapshots === next.toolExecutionSnapshots
    && prev.modelNames === next.modelNames
    && prev.cwd === next.cwd
    && prev.onOpenFile === next.onOpenFile
    && prev.entryId === next.entryId
    && prev.onBranchHere === next.onBranchHere
    && prev.onNewSessionFromHere === next.onNewSessionFromHere
    && prev.onBranchFromAssistant === next.onBranchFromAssistant
    && prev.onNewSessionFromAnswer === next.onNewSessionFromAnswer
    && prev.forking === next.forking
    && prev.showTimestamp === next.showTimestamp
    && prev.prevTimestamp === next.prevTimestamp
    && prev.sessionId === next.sessionId;
});

function UserMessageView({ message, cwd, onOpenFile, entryId, onBranchHere, onNewSessionFromHere, forking }: {
  message: UserMessage;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  entryId?: string;
  onBranchHere?: (entryId: string, text: string) => void;
  onNewSessionFromHere?: (entryId: string, text: string) => void;
  forking?: boolean;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);

  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("\n");

  const imageBlocks: ImageContent[] =
    typeof message.content === "string"
      ? []
      : message.content.filter((b): b is ImageContent => b.type === "image");
  const pathMedia = useMemo(() => extractMediaPathsFromText(content), [content]);

  const time = formatTime(message.timestamp);
  const canBranchHere = !!entryId && !!onBranchHere;
  const canNewSession = !!entryId && !!onNewSessionFromHere;

  const copyContent = () => {
    copyText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      style={{ marginBottom: 28, display: "flex", flexDirection: "column", alignItems: "flex-end" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, maxWidth: "85%" }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--user-bg)",
            border: "1px solid color-mix(in srgb, var(--accent) 18%, var(--border))",
            borderRadius: "var(--radius-lg) var(--radius-lg) var(--radius-xs) var(--radius-lg)",
            padding: "11px 14px",
            fontSize: 14,
            lineHeight: 1.6,
            color: "var(--text)",
            wordBreak: "break-word",
          }}
        >
          <MessageMediaGallery
            imageBlocks={imageBlocks}
            pathImages={pathMedia.images}
            pathAudio={pathMedia.audio}
            pathVideo={pathMedia.video}
          />
          {content && <MarkdownBody className="markdown-user-message" cwd={cwd} onOpenFile={onOpenFile}>{content}</MarkdownBody>}
        </div>

      </div>

      {/* Bottom row: action buttons + timestamp */}
      {(time || canBranchHere || true) && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          gap: 6, marginTop: 3,
        }}>
          <div style={{
            display: "flex", gap: 3,
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? "auto" : "none",
            transition: "opacity 0.12s",
          }}>
            <button
              onClick={copyContent}
              data-tooltip={t("message_copy")}
              className="instant-tooltip"
              aria-label={t("message_copy")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                padding: "3px 6px", height: 22,
                background: "none", border: "none",
                borderRadius: 5,
                color: copied ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                transition: "color 0.12s",
              }}
              onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--accent)"; }}
              onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              {copied ? <Check size={11} strokeWidth={1.8} /> : <Copy size={11} strokeWidth={1.8} />}
            </button>
          </div>
          {(canBranchHere || canNewSession) && (
            <div style={{
              display: "flex", gap: 3,
              opacity: (hovered || forking) ? 1 : 0,
              pointerEvents: (hovered || forking) ? "auto" : "none",
              transition: "opacity 0.12s",
            }}>
              {canBranchHere && (
                <button
                  onClick={() => { onBranchHere!(entryId!, content); }}
                  data-tooltip={t("message_branchHereTooltip")}
                  className="instant-tooltip"
                  aria-label={t("message_branchHere")}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 26, height: 22, padding: 0,
                    background: "none", border: "none",
                    borderRadius: 5,
                    color: "var(--text-dim)",
                    cursor: "pointer",
                    transition: "color 0.12s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
                >
                  <GitBranch size={14} strokeWidth={1.8} />
                </button>
              )}
              {canNewSession && (
                <button
                  onClick={() => { onNewSessionFromHere!(entryId!, content); }}
                  disabled={forking}
                  title={forking ? t("message_creating") : t("message_newSessionFromHereTooltip")}
                  data-tooltip={forking ? t("message_creating") : t("message_newSessionFromHereTooltip")}
                  className="instant-tooltip"
                  aria-label={t("message_newSessionFromHere")}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 26, height: 22, padding: 0,
                    background: "none", border: "none",
                    borderRadius: 5,
                    color: forking ? "var(--accent)" : "var(--text-dim)",
                    cursor: forking ? "not-allowed" : "pointer",
                    transition: "color 0.12s",
                  }}
                  onMouseEnter={(e) => { if (!forking) e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={(e) => { if (!forking) e.currentTarget.style.color = "var(--text-dim)"; }}
                >
                  <FilePlus size={14} strokeWidth={1.8} />
                </button>
              )}
            </div>
          )}
          {time && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{time}</span>}
        </div>
      )}
    </div>
  );
}

function AssistantMessageView({
  message,
  isStreaming,
  toolResults,
  toolExecutionSnapshots,
  modelNames,
  cwd,
  onOpenFile,
  showTimestamp,
  prevTimestamp,
  sessionId,
  entryId,
  onBranchFromAssistant,
  onNewSessionFromAnswer,
}: {
  message: AssistantMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  toolExecutionSnapshots?: ToolExecutionSnapshot[];
  modelNames?: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  sessionId?: string;
  entryId?: string;
  onBranchFromAssistant?: (entryId: string) => void;
  onNewSessionFromAnswer?: (entryId: string) => void;
}) {
  const { t } = useI18n();
  const time = showTimestamp ? formatTime(message.timestamp) : null;
  const blockItems = (message.content ?? [])
    .map((block, originalIndex) => ({ block, originalIndex }))
    .filter(({ block }) => !isEmptyThinkingBlock(block, { isStreaming }));
  const blocks = blockItems.map(({ block }) => block);
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const streamStartRef = useRef<number | null>(null);
  const [tps, setTps] = useState<number | null>(null);
  const blockItemsRef = useRef(blockItems);
  blockItemsRef.current = blockItems;

  // Streaming-based timing for thinking blocks
  const blockStartTimesRef = useRef<Map<number, number>>(new Map());
  const [streamingDurations, setStreamingDurations] = useState<Map<number, number>>(new Map());

  // Thinking duration derived from file timestamps: time from prev message end to this message end
  // This is the total generation time (thinking + any text before first tool call)
  const thinkingDurationFromFile = useMemo<number | undefined>(() => {
    if (!message.timestamp || !prevTimestamp) return undefined;
    const secs = Math.round((message.timestamp - prevTimestamp) / 1000);
    return secs > 0 ? secs : undefined;
  }, [message.timestamp, prevTimestamp]);

  // Tool call durations derived from session file timestamps (accurate for completed messages)
  // assistant message timestamp = when generation ended = when tools started running
  // toolResult timestamp = when tool execution finished
  const toolCallDurations = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    if (!toolResults || !message.timestamp) return map;
    for (const [callId, result] of toolResults) {
      if (result.timestamp && message.timestamp) {
        const secs = Math.round((result.timestamp - message.timestamp) / 1000);
        if (secs > 0) map.set(callId, secs);
      }
    }
    return map;
  }, [toolResults, message.timestamp]);
  const toolExecutionMap = useMemo(
    () => new Map(toolExecutionSnapshots?.map((snapshot) => [snapshot.toolCallId, snapshot]) ?? []),
    [toolExecutionSnapshots],
  );

  const textContent = blocks
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const copyContent = () => {
    copyText(textContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  useEffect(() => {
    if (!isStreaming) {
      // Finalise any un-finished thinking block durations on stream end
      const now = new Date().getTime();
      setStreamingDurations((prev: Map<number, number>) => {
        const next = new Map(prev);
        for (const [idx, start] of blockStartTimesRef.current) {
          if (!next.has(idx)) next.set(idx, Math.round((now - start) / 1000));
        }
        return next;
      });
      streamStartRef.current = null;
      setTps(null);
      return;
    }
    const tick = () => {
      const items = blockItemsRef.current;
      const bs = items.map(({ block }) => block);
      const now = Date.now();

      // Record start time for each block the first time we see it
      items.forEach(({ originalIndex }) => {
        if (!blockStartTimesRef.current.has(originalIndex)) blockStartTimesRef.current.set(originalIndex, now);
      });

      // When a non-last block has a successor already started, finalise its duration
      setStreamingDurations((prev: Map<number, number>) => {
        let changed = false;
        const next = new Map(prev);
        for (let i = 0; i < items.length - 1; i++) {
          const originalIndex = items[i].originalIndex;
          const nextOriginalIndex = items[i + 1].originalIndex;
          if (!next.has(originalIndex) && blockStartTimesRef.current.has(originalIndex)) {
            const start = blockStartTimesRef.current.get(originalIndex)!;
            const nextStart = blockStartTimesRef.current.get(nextOriginalIndex) ?? now;
            next.set(originalIndex, Math.round((nextStart - start) / 1000));
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      let chars = 0;
      for (const b of bs) {
        if (b.type === "text") chars += (b as TextContent).text?.length ?? 0;
        else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0;
        else if (b.type === "toolCall") chars += JSON.stringify((b as ToolCallContent).input ?? {}).length;
      }
      if (chars === 0) return;
      if (streamStartRef.current === null) streamStartRef.current = now;
      const elapsed = (now - streamStartRef.current) / 1000;
      if (elapsed > 0.5) setTps(chars / 4 / elapsed);
    };
    const id = setInterval(tick, 300);
    return () => clearInterval(id);
  }, [isStreaming]);

  if (blocks.length === 0 && !isStreaming) return null;

  return (
    <div
      style={{ marginBottom: 30 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Model label */}
      <div
        style={{
          fontSize: 11,
          color: "var(--text-dim)",
          marginBottom: 8,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {message.provider && (
          <span>{modelNames?.[`${message.provider}:${message.model}`] ?? modelNames?.[message.model] ?? message.model}</span>
        )}
        {isStreaming && (() => {
          let chars = 0;
          for (const b of blocks) {
            if (b.type === "text") chars += (b as TextContent).text?.length ?? 0;
            else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0;
            else if (b.type === "toolCall") chars += JSON.stringify((b as ToolCallContent).input ?? {}).length;
          }
          const est = Math.round(chars / 4);
          return (
            <>

              {est > 0 && (
                <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text)" }} title={t("message_estimatedTokensStreaming")}>
                  <span style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 11, fontWeight: 400 }}>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                    {est}
                  </span>
                  {tps !== null && (() => {
                    const bg = tps >= 50 ? "#53b3cb" : tps >= 30 ? "#9bc53d" : tps >= 15 ? "#f9c22e" : "#e01a4f";
                    return (
                      <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 4, background: bg, color: "#fff", fontSize: 11, fontWeight: 400 }}>
                        {tps.toFixed(1)} t/s
                      </span>
                    );
                  })()}
                </span>
              )}
            </>
          );
        })()}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {blockItems.map(({ block, originalIndex }) => (
          <BlockView key={`${entryId ?? "stream"}-${originalIndex}`} block={block} toolResults={toolResults} toolExecutionMap={toolExecutionMap} isStreaming={isStreaming} streamingDuration={streamingDurations.get(originalIndex) ?? (block.type === "thinking" ? thinkingDurationFromFile : undefined)} toolCallDurations={toolCallDurations} cwd={cwd} onOpenFile={onOpenFile} sessionId={sessionId} entryId={entryId} blockIndex={originalIndex} />
        ))}
      </div>

      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginTop: 4,
      }}>
        {message.usage && !isStreaming && (
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {formatUsage(message.usage)}
          </div>
        )}
        {textContent && !isStreaming && (
          <button
            onClick={copyContent}
            data-tooltip={t("message_copyAnswer")}
            className="instant-tooltip"
            aria-label={t("message_copyAnswer")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: "3px 6px", height: 22, width: 22,
              background: "none", border: "none",
              borderRadius: 5,
              color: copied ? "var(--accent)" : "var(--text-dim)",
              cursor: "pointer",
              transition: "opacity 0.12s, color 0.12s",
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? "auto" : "none",
            }}
            onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--text-dim)"; }}
          >
            {copied ? <Check size={11} strokeWidth={1.8} /> : <Copy size={11} strokeWidth={1.8} />}
          </button>
        )}
        {entryId && !isStreaming && onBranchFromAssistant && (
          <button
            onClick={() => { onBranchFromAssistant!(entryId); }}
            data-tooltip={t("message_branchFromAnswerTooltip")}
            className="instant-tooltip"
            aria-label={t("message_branchFromAnswer")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 22, padding: 0,
              background: "none", border: "none",
              borderRadius: 5,
              color: "var(--text-dim)",
              cursor: "pointer",
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? "auto" : "none",
              transition: "opacity 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
          >
            <GitBranch size={14} strokeWidth={1.8} />
          </button>
        )}
        {entryId && !isStreaming && onNewSessionFromAnswer && (
          <button
            onClick={() => { onNewSessionFromAnswer!(entryId); }}
            data-tooltip={t("message_newSessionFromAnswerTooltip")}
            className="instant-tooltip"
            aria-label={t("message_newSessionFromAnswer")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 22, padding: 0,
              background: "none", border: "none",
              borderRadius: 5,
              color: "var(--text-dim)",
              cursor: "pointer",
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? "auto" : "none",
              transition: "opacity 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
          >
            <FilePlus size={14} strokeWidth={1.8} />
          </button>
        )}
        {time && !isStreaming && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>{time}</span>
        )}
      </div>
    </div>
  );
}

function BlockView({ block, toolResults, toolExecutionMap, isStreaming, streamingDuration, toolCallDurations, cwd, onOpenFile, sessionId, entryId, blockIndex }: { block: AssistantContentBlock; toolResults?: Map<string, ToolResultMessage>; toolExecutionMap?: Map<string, ToolExecutionSnapshot>; isStreaming?: boolean; streamingDuration?: number; toolCallDurations?: Map<string, number>; cwd?: string; onOpenFile?: (filePath: string) => void; sessionId?: string; entryId?: string; blockIndex: number }) {
  if (block.type === "text") {
    return <TextBlock block={block as TextContent} isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile} />;
  }
  if (block.type === "thinking") {
    return <ThinkingBlock block={block as ThinkingContent} duration={streamingDuration} isStreaming={isStreaming} sessionId={sessionId} entryId={entryId} blockIndex={blockIndex} />;
  }
  if (block.type === "toolCall") {
    const tc = block as ToolCallContent;
    const result = toolResults?.get(tc.toolCallId);
    const duration = toolCallDurations?.get(tc.toolCallId);
    return (
      <ToolCallBlock
        block={tc}
        result={result}
        snapshot={toolExecutionMap?.get(tc.toolCallId)}
        duration={duration}
        sessionId={sessionId}
      />
    );
  }
  return null;
}

function TextBlock({ block, isStreaming, cwd, onOpenFile }: { block: TextContent; isStreaming?: boolean; cwd?: string; onOpenFile?: (filePath: string) => void }) {
  return <MarkdownBody isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile}>{block.text}</MarkdownBody>;
}

/** 思考 / 工具明细默认最大高度：超出在块内滚动，避免会话视口被无限撑高。 */
const STREAM_BLOCK_MAX_HEIGHT = 320;
/** 距块底多少 px 内视为仍跟随；用户上滚超出后停止自动向下。 */
const STREAM_BLOCK_FOLLOW_TOLERANCE_PX = 24;

function ThinkingBlock({ block, duration, isStreaming, sessionId, entryId, blockIndex }: {
  block: ThinkingContent;
  duration?: number;
  /** 所在消息正在流式生成：思考块默认展开、流式结束自动折叠 */
  isStreaming?: boolean;
  sessionId?: string;
  entryId?: string;
  blockIndex: number;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(isStreaming ?? false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const followBodyRef = useRef(true);

  // 流式开始展开（默认可见），流式结束折叠；用户手动 toggle 在流式状态不变时不打扰
  useEffect(() => {
    setExpanded(isStreaming ?? false);
  }, [isStreaming]);
  const bodyText = loading
    ? t("message_thinkingLoading")
    : error ?? (block.deferred ? content : block.thinking);

  // deferred 思考内容按需加载（点击展开或流式中默认展开均触发）
  const loadIfDeferred = async () => {
    if (!block.deferred || content !== null || loading) return;
    if (!sessionId || !entryId) {
      setError(t("message_thinkingUnavailable"));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setContent(await loadThinkingContent(sessionId, entryId, blockIndex));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (expanded) void loadIfDeferred();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅展开状态变化时触发
  }, [expanded]);

  const toggle = async () => {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (nextExpanded && block.deferred && content === null) await loadIfDeferred();
  };

  // 展开后内容增长时块内自动向下；用户上滚后停止，滚回底部再恢复。
  useEffect(() => {
    const body = bodyRef.current;
    if (!expanded || !body || !followBodyRef.current) return;
    body.scrollTop = body.scrollHeight;
  }, [expanded, bodyText]);

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 6,
        overflow: "hidden",
        fontSize: 13,
      }}
    >
      <button
        onClick={() => void toggle()}
        aria-expanded={expanded}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "6px 10px",
          background: "var(--bg-panel)",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
      >
        <span>{t("chat_thinking")}</span>
        {duration !== undefined && (
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{formatElapsedDuration(duration * 1000)}</span>
        )}
      </button>
      {expanded && (
        <div
          ref={bodyRef}
          tabIndex={0}
          onScroll={(event) => {
            const body = event.currentTarget;
            followBodyRef.current =
              body.scrollHeight - body.scrollTop - body.clientHeight <= STREAM_BLOCK_FOLLOW_TOLERANCE_PX;
          }}
          style={{
            padding: "8px 10px",
            color: error ? "var(--error-text)" : "var(--text-muted)",
            fontSize: 12,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            background: "var(--bg-panel)",
            borderTop: "1px solid var(--border)",
            maxHeight: STREAM_BLOCK_MAX_HEIGHT,
            overflow: "auto",
            overscrollBehavior: "contain",
          }}
        >
          {bodyText}
        </div>
      )}
    </div>
  );
}


function ToolCallBlock({ block, result, snapshot, duration, sessionId, pending }: {
  block: ToolCallContent;
  result?: ToolResultMessage;
  snapshot?: ToolExecutionSnapshot;
  duration?: number;
  sessionId?: string;
  /** 已知执行中但无快照（如刷新后恢复的 bash 气泡）；无快照时以此推导运行色。 */
  pending?: boolean;
}) {
  const { t } = useI18n();
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [resolvedDetails, setResolvedDetails] = useState<unknown>(undefined);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const followOutputRef = useRef(true);
  const isRunning = snapshot?.status === "running" || pending === true;
  const expanded = expandedOverride ?? isRunning;
  const isEditTool = isEditToolName(block.toolName);
  // 首屏可能 deferredHeavy：展开后懒加载完整 details 再算 diff
  const effectiveResult = result && resolvedDetails !== undefined
    ? { ...result, details: resolvedDetails }
    : result;
  const resultDiff = effectiveResult && !effectiveResult.isError ? getResultDiff(effectiveResult) : null;

  // Result display
  const resultText = effectiveResult
    ? effectiveResult.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n")
    : null;
  const resultIsEmpty = resultText === null ? false : (resultText.trim() === "(no output)" || resultText.trim() === "");
  const isError = effectiveResult?.isError ?? false;
  const status = snapshot?.status;
  // 无快照时从磁盘结果推导：result 存在（非 error）即完成成功（刷新后保持绿色）；
  // pending（bash 执行中恢复）推导运行色。快照仍是内存态权威（实时渲染）。
  const statusColor = getToolStatusColor(status, isError, effectiveResult != null, pending);
  const command = getToolCommand(block, snapshot);
  const renderedCallLines = getRenderableAnsiLines(snapshot?.renderedCallLines ?? block.renderedCallLines);
  const renderedLiveLines = getRenderableAnsiLines(snapshot?.renderedLines);
  const renderedResultLines = getRenderableAnsiLines(snapshot?.renderedResultLines ?? effectiveResult?.renderedResultLines);
  const elapsedMs = snapshot
    ? Math.max(0, (snapshot.status === "running" ? now : (snapshot.endedAt ?? snapshot.startedAt)) - snapshot.startedAt)
    : duration === undefined ? undefined : duration * 1000;

  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [isRunning]);

  useEffect(() => {
    const output = outputRef.current;
    if (!expanded || !output || !followOutputRef.current) return;
    output.scrollTop = output.scrollHeight;
  }, [expanded, snapshot?.output, snapshot?.renderedLines, renderedLiveLines]);

  // 展开工具卡且 details 被首屏剥离时，按 toolCallId 补全 diff/patch
  useEffect(() => {
    if (!expanded || !result || !sessionId) return;
    if (!isDeferredHeavyToolDetails(result.details)) return;
    if (resolvedDetails !== undefined || detailsLoading) return;
    let cancelled = false;
    setDetailsLoading(true);
    void loadToolResultDetails(sessionId, block.toolCallId)
      .then((details) => {
        if (!cancelled) setResolvedDetails(details);
      })
      .catch(() => {
        // 失败时保留轻量 details + 文本结果，不阻塞展开
        if (!cancelled) setResolvedDetails(result.details);
      })
      .finally(() => {
        if (!cancelled) setDetailsLoading(false);
      });
    return () => { cancelled = true; };
  }, [expanded, result, sessionId, block.toolCallId, resolvedDetails, detailsLoading]);

  return (
    <div
      style={{
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
        fontSize: 12,
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${statusColor}`,
        background: "var(--tool-bg)",
      }}
    >
      {/* ── Tool call header ── */}
      <button
        onClick={() => setExpandedOverride(!expanded)}
        aria-expanded={expanded}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: "100%",
          padding: "6px 10px",
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
          minWidth: 0,
        }}
      >
        {/* 工具图标 + 静态状态点：运行反馈由状态文字和右侧耗时共同表达。 */}
        <span style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
          {getToolIcon(block.toolName, statusColor)}
          {isRunning && (
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: statusColor }} aria-hidden="true" />
          )}
        </span>
        <span style={{ color: statusColor, fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 11, flexShrink: 0 }}>
          {block.toolName}
        </span>
        <span title={command} style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
          {command}
        </span>
        {status && (
          <span style={{ color: statusColor, fontSize: 10, fontWeight: 600, flexShrink: 0 }}>{t(TOOL_STATUS_KEYS[status])}</span>
        )}
        {elapsedMs !== undefined && (
          <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{formatElapsedDuration(elapsedMs)}</span>
        )}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>

      {/* ── Expanded: 参数友好摘要（替代原始 JSON，OpenChamber 风格） ── */}
      {expanded && command && (
        <div style={{ padding: "8px 10px", borderTop: `1px solid color-mix(in srgb, ${statusColor} 22%, var(--border))`, background: "var(--bg-subtle)" }}>
          <div style={{ marginBottom: 4, color: "var(--text-dim)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>{t("message_toolCommand")}</div>
          <code style={{ display: "block", maxHeight: STREAM_BLOCK_MAX_HEIGHT, overflow: "auto", overscrollBehavior: "contain", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{command}</code>
        </div>
      )}

      {expanded && renderedCallLines && (
        <AnsiToolLines lines={renderedCallLines} statusColor={statusColor} />
      )}

      {expanded && !isEditTool && (
        <div
          style={{
            margin: 0,
            padding: "8px 10px",
            color: "var(--text-muted)",
            fontSize: 12,
            lineHeight: 1.5,
maxHeight: STREAM_BLOCK_MAX_HEIGHT,
            overflow: "auto",
            overscrollBehavior: "contain",
            background: "var(--bg-subtle)",
            borderTop: `1px solid color-mix(in srgb, ${statusColor} 20%, var(--border))`,
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
          {formatInputSummary(block.input as Record<string, unknown>).filter((row) => row.key !== "command").map((row) => (
            <div key={row.key} style={{ display: "flex", gap: 8, minWidth: 0 }}>
              <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", width: 88, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.key}</span>
              <span style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{row.value}</span>
            </div>
          ))}
        </div>
      )}

      {expanded && snapshot && (
        <div style={{ borderTop: `1px solid color-mix(in srgb, ${statusColor} 24%, var(--border))`, background: "var(--tool-bg)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 10px 4px", color: "var(--text-dim)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>
            <span>{t("message_toolLiveOutput")}</span>
            {snapshot.truncated && <span style={{ color: "var(--warning)", textTransform: "none", letterSpacing: 0 }}>{t("message_toolOutputTruncated")}</span>}
          </div>
          <pre
            ref={outputRef}
            tabIndex={0}
            onScroll={(event) => {
              const output = event.currentTarget;
              followOutputRef.current = output.scrollHeight - output.scrollTop - output.clientHeight <= STREAM_BLOCK_FOLLOW_TOLERANCE_PX;
            }}
            style={{ margin: 0, padding: "4px 10px 10px", maxHeight: STREAM_BLOCK_MAX_HEIGHT, overflow: "auto", overscrollBehavior: "contain", color: renderedLiveLines || snapshot.output ? "var(--text-muted)" : "var(--text-dim)", background: "var(--tool-bg)", fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
          >{renderedLiveLines ? renderAnsiLines(renderedLiveLines, "tool-live") : snapshot.output || t("message_toolWaitingOutput")}</pre>
        </div>
      )}

      {/* ── Paired result — only shown when expanded ── */}
      {expanded && effectiveResult && (
        renderedResultLines ? (
          <AnsiToolLines lines={renderedResultLines} statusColor={statusColor} />
        ) : detailsLoading && isDeferredHeavyToolDetails(result?.details) && !resultDiff ? (
          <div style={{ padding: "8px 10px", borderTop: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 11 }}>
            {t("message_thinkingLoading")}
          </div>
        ) : resultDiff ? (
          <PairedDiffResult
            diff={resultDiff}
          />
        ) : (
          <PairedResult
            text={resultText ?? ""}
            isEmpty={resultIsEmpty}
            isError={isError}
          />
        )
      )}
    </div>
  );
}

/** 空数组或畸形数组视为缺失，保证插件渲染不可用时绝不遮住原始输出。 */
function getRenderableAnsiLines(lines: unknown): string[] | null {
  return Array.isArray(lines) && lines.length > 0 && lines.every((line) => typeof line === "string") ? lines : null;
}

function renderAnsiLine(line: string, keyPrefix: string): ReactNode[] {
  return parseAnsiLine(line).map((segment, index) => (
    Object.keys(segment.style).length > 0
      ? <span key={`${keyPrefix}-${index}`} style={segment.style}>{segment.text}</span>
      : segment.text
  ));
}

function renderAnsiLines(lines: string[], keyPrefix: string): ReactNode[] {
  return lines.map((line, index) => (
    <span key={`${keyPrefix}-${index}`}>
      {renderAnsiLine(line, `${keyPrefix}-${index}`)}
      {index < lines.length - 1 ? "\n" : null}
    </span>
  ));
}

/** 插件 TUI 行沿用工具卡片的边框、底色和等宽排版，不引入新视觉语义。 */
function AnsiToolLines({ lines, statusColor }: { lines: string[]; statusColor: string }) {
  return (
    <pre
      tabIndex={0}
      style={{ margin: 0, padding: "8px 10px", maxHeight: STREAM_BLOCK_MAX_HEIGHT, overflow: "auto", overscrollBehavior: "contain", borderTop: `1px solid color-mix(in srgb, ${statusColor} 24%, var(--border))`, background: "var(--bg-subtle)", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
    >
      {renderAnsiLines(lines, "tool-rendered")}
    </pre>
  );
}

const TOOL_STATUS_KEYS = {
  running: "message_toolStatusRunning",
  success: "message_toolStatusSuccess",
  error: "message_toolStatusError",
  cancelled: "message_toolStatusCancelled",
} as const;

function getToolStatusColor(
  status: ToolExecutionStatus | undefined,
  resultIsError: boolean,
  hasResult = false,
  pending = false,
): string {
  if (status === "running" || pending) return "var(--status-running)";
  if (status === "success" || (hasResult && !resultIsError)) return "var(--status-success)";
  if (status === "error" || resultIsError) return "var(--status-danger)";
  if (status === "cancelled") return "var(--text-dim)";
  return "var(--text-muted)";
}

function getToolCommand(block: ToolCallContent, snapshot?: ToolExecutionSnapshot): string {
  if (snapshot?.command) return snapshot.command;
  const input = block.input;
  if (input && typeof input === "object" && "command" in input) {
    const command = input.command;
    if (typeof command === "string") return command;
    if (command && typeof command === "object") {
      const nested = command as Record<string, unknown>;
      if (typeof nested.command === "string") return nested.command;
      if (typeof nested.cmd === "string") return nested.cmd;
    }
  }
  return getToolPreview(block);
}

export function formatElapsedDuration(milliseconds: number): string {
  const safeMs = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
  if (safeMs < 1000) return `${Math.floor(safeMs)}ms`;
  const seconds = safeMs / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const wholeSeconds = Math.round(seconds);
  return `${Math.floor(wholeSeconds / 60)}m ${String(wholeSeconds % 60).padStart(2, "0")}s`;
}

interface ResultDiff {
  text: string;
}

function PairedDiffResult({ diff }: {
  diff: ResultDiff;
}) {
  return (
    <div
      style={{
        borderTop: "1px solid var(--status-success-border)",
        background: "var(--bg)",
      }}
    >
      <SplitPatchView text={diff.text} />
    </div>
  );
}

function SplitPatchView({ text }: { text: string }) {
  const files = useMemo(() => parseUnifiedPatch(text), [text]);
  if (!files) return <PatchTextView text={text} />;
  const showFileHeaders = files.length > 1;

  return (
    <div style={{ maxHeight: 560, overflowY: "auto", overflowX: "hidden", background: "var(--bg)" }}>
      {files.map((file, fileIndex) => (
        <div
          key={fileIndex}
          style={{
            minWidth: 0,
            borderTop: fileIndex === 0 ? "none" : "1px solid var(--border)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.55,
          }}
        >
          {showFileHeaders && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                position: "sticky",
                top: 0,
                zIndex: 1,
                background: "var(--bg-panel)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <SplitDiffHeader title={file.oldPath || "Before"} side="left" />
              <SplitDiffHeader title={file.newPath || "After"} side="right" />
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
            {file.rows.map((row, rowIndex) => {
              if (row.type === "hunk") {
                return null;
              }

              return (
                <div key={rowIndex} style={{ display: "contents" }}>
                  <SplitDiffCellView cell={row.left} side="left" />
                  <SplitDiffCellView cell={row.right} side="right" />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function SplitDiffHeader({ title, side }: { title: string; side: "left" | "right" }) {
  return (
    <div
      title={title}
      style={{
        padding: "5px 10px",
        color: "var(--text-dim)",
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {title}
    </div>
  );
}

function SplitDiffCellView({ cell, side }: { cell: SplitDiffCell; side: "left" | "right" }) {
  const bg =
    cell.type === "added"
      ? "var(--diff-added-bg)"
      : cell.type === "removed"
      ? "var(--diff-removed-bg)"
      : cell.type === "empty"
      ? "var(--bg-subtle)"
      : "transparent";
  const marker =
    cell.type === "added" ? "+" : cell.type === "removed" ? "-" : " ";
  const markerColor =
    cell.type === "added" ? "var(--diff-added-text)" : cell.type === "removed" ? "var(--diff-removed-text)" : "var(--text-dim)";

  return (
    <div
      style={{
        display: "flex",
        minWidth: 0,
        background: bg,
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
      }}
    >
      <span
        style={{
          width: 42,
          padding: "0 6px",
          textAlign: "right",
          color: "var(--text-dim)",
          userSelect: "none",
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        {cell.lineNo ?? ""}
      </span>
      <span
        style={{
          width: 18,
          padding: "0 5px",
          color: markerColor,
          userSelect: "none",
          fontWeight: cell.type === "context" || cell.type === "empty" ? 400 : 700,
          flexShrink: 0,
        }}
      >
        {marker}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          padding: "0 10px 0 0",
          color: cell.type === "empty" ? "var(--text-dim)" : "var(--text)",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {cell.text || "\u00a0"}
      </span>
    </div>
  );
}

function PatchTextView({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);

  return (
    <div style={{ maxHeight: 520, overflowY: "auto", overflowX: "hidden", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.55, minWidth: 0 }}>
      {lines.map((line, i) => {
        const kind =
          line.startsWith("@@") ? "hunk" :
          line.startsWith("+") && !line.startsWith("+++") ? "added" :
          line.startsWith("-") && !line.startsWith("---") ? "removed" :
          "context";
        const bg =
          kind === "added" ? "var(--diff-added-bg)" :
          kind === "removed" ? "var(--diff-removed-bg)" :
          kind === "hunk" ? "var(--diff-hunk-bg)" :
          "transparent";
        const color =
          kind === "added" ? "var(--diff-added-text)" :
          kind === "removed" ? "var(--diff-removed-text)" :
          kind === "hunk" ? "var(--accent)" :
          "var(--text)";

        return (
          <div
            key={i}
            style={{
              display: "flex",
              background: bg,
              borderLeft: kind === "added"
                ? "3px solid var(--diff-added-border)"
                : kind === "removed"
                ? "3px solid var(--diff-removed-border)"
                : kind === "hunk"
                ? "3px solid var(--accent)"
                : "3px solid transparent",
            }}
          >
            <span
              style={{
                width: 48,
                padding: "0 8px",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                borderRight: "1px solid var(--border)",
                textAlign: "right",
                userSelect: "none",
                flexShrink: 0,
              }}
            >
              {i + 1}
            </span>
            <span style={{ padding: "0 10px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color }}>
              {line || "\u00a0"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function getResultDiff(result: ToolResultMessage): ResultDiff | null {
  const details = (result as ToolResultMessage & { details?: unknown }).details;
  if (!isRecord(details)) return null;

  const patch = typeof details.patch === "string" ? details.patch : null;
  if (patch) return { text: patch };

  const diff = typeof details.diff === "string" ? details.diff : null;
  if (diff) return { text: diff };

  return null;
}

function isEditToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "edit" ||
    name.startsWith("edit_") ||
    name.endsWith(".edit") ||
    name.endsWith("_edit") ||
    name.includes("str_replace") ||
    name.includes("replace_editor");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 工具名 → lucide 图标元素（OpenChamber 风格：每种工具一个可识别图标）。
 * 返回 JSX 元素而非组件类型：避免 render 中创建组件（react-hooks/static-components）。 */
function getToolIcon(toolName: string, color: string): ReactNode {
  const name = toolName.toLowerCase();
  const props = { size: 12, color };
  if (name === "bash" || name === "exec_command" || name === "terminal" || name.includes("shell")) return <Terminal {...props} />;
  if (name === "edit" || name === "write" || name.includes("edit") || name.includes("write")) return <Pencil {...props} />;
  if (name === "read" || name === "multi_read" || name.includes("read") || name.includes("view")) return <FileText {...props} />;
  if (name === "grep" || name === "search" || name.includes("grep") || name.includes("search") || name.includes("find")) return <Search {...props} />;
  if (name.includes("web") || name.includes("fetch") || name.includes("http") || name.includes("url")) return <Globe {...props} />;
  if (name.includes("todo") || name.includes("task")) return <ListTodo {...props} />;
  if (name.includes("notify") || name.includes("message")) return <Webhook {...props} />;
  if (name.includes("approve") || name.includes("permission") || name.includes("confirm")) return <ShieldCheck {...props} />;
  return <Terminal {...props} />;
}

/** 参数友好摘要：展开区替代原始 JSON 的关键字段展示（OpenChamber formatInputForDisplay 风格）。 */
function formatInputSummary(input: Record<string, unknown>): Array<{ key: string; value: string }> {
  const rows: Array<{ key: string; value: string }> = [];
  for (const [key, raw] of Object.entries(input)) {
    if (raw === undefined || raw === null) continue;
    const friendly = typeof raw === "string"
      ? raw
      : typeof raw === "number" || typeof raw === "boolean"
        ? String(raw)
        : "";
    if (friendly) rows.push({ key, value: friendly });
    else {
      try {
        rows.push({ key, value: JSON.stringify(raw).slice(0, 200) });
      } catch {
        rows.push({ key, value: "[…]" });
      }
    }
  }
  return rows;
}

function PairedResult({ text, isEmpty, isError }: {
  text: string;
  isEmpty: boolean;
  isError: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        borderTop: `1px solid ${isError ? "var(--status-danger-border)" : "var(--status-success-border)"}`,
        background: isError ? "var(--status-danger-bg)" : "var(--bg-subtle)",
      }}
    >
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          color: isError ? "var(--error-text)" : (isEmpty ? "var(--text-dim)" : "var(--text-muted)"),
          fontSize: 12,
          lineHeight: 1.5,
          overflow: "auto",
          maxHeight: 400,
          background: "var(--bg)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          fontStyle: isEmpty ? "italic" : "normal",
          opacity: isEmpty ? 0.6 : 1,
        }}
      >
        {isEmpty ? `(${t("message_noOutput").toLowerCase()})` : text}
      </pre>
    </div>
  );
}

function CompactionMessageView({ message }: { message: CustomMessage }) {
  const { t } = useI18n();
  const summary = getMessageText(message.content);
  const parsedSummary = useMemo(() => parseCompactionSummary(summary), [summary]);
  const time = formatTime(message.timestamp);

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
          }}
        >
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650 }}>
            {t("message_compaction")}
          </span>
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>{time}</span>}
        </div>

        <div style={{ padding: "11px 13px 12px" }}>
          <div style={{ color: "var(--text)", fontSize: 15, fontWeight: 700, lineHeight: 1.35 }}>
            {t("message_conversationCompacted")}
          </div>
          <div style={{ marginTop: 3, marginBottom: 10, color: "var(--text)", fontSize: 14, lineHeight: 1.5 }}>
            {t("message_conversationCompactedDescription")}
          </div>
          {parsedSummary.body ? (
            <MarkdownBody className="markdown-compaction-message">{parsedSummary.body}</MarkdownBody>
          ) : (
            <span style={{ color: "var(--text-dim)", fontSize: 12 }}>({t("message_noSummary")})</span>
          )}
          <FileContextMetadata readFiles={parsedSummary.readFiles} modifiedFiles={parsedSummary.modifiedFiles} />
        </div>
      </div>
    </div>
  );
}

function CommandMessageView({ message }: { message: CustomMessage }) {
  const { t } = useI18n();
  const command = getMessageText(message.content);
  const ok = (message.details as { ok?: boolean } | undefined)?.ok !== false;
  const result = (message.details as { result?: string } | undefined)?.result;
  const time = formatTime(message.timestamp);
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          border: "1px solid var(--border)",
          borderLeft: "2px solid var(--accent)",
          borderRadius: 8,
          background: "var(--bg-subtle)",
        }}
      >
        <span style={{ color: "var(--text-dim)", fontSize: 10, whiteSpace: "nowrap" }}>{t("message_command")}</span>
        <code style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text)", overflowWrap: "anywhere" }}>
          {command}
        </code>
        {ok && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>✓</span>}
        {!ok && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>✗</span>}
        {time && <span style={{ color: "var(--text-dim)", fontSize: 10, whiteSpace: "nowrap" }}>{time}</span>}
      </div>
      {result && (
        <div style={{ marginTop: 4, padding: "0 4px", color: "var(--text-muted)", fontSize: 12 }}>{result}</div>
      )}
    </div>
  );
}

function BranchSummaryMessageView({ message }: { message: CustomMessage }) {
  const { t } = useI18n();
  const summary = getMessageText(message.content);
  const parsedSummary = useMemo(() => parseCompactionSummary(summary), [summary]);
  const structuredFiles = useMemo(() => getBranchSummaryFileMetadata(message.details), [message.details]);
  const readFiles = structuredFiles?.readFiles ?? parsedSummary.readFiles;
  const modifiedFiles = structuredFiles?.modifiedFiles ?? parsedSummary.modifiedFiles;
  const time = formatTime(message.timestamp);

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderLeft: "2px solid var(--accent)",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650 }}>
            {t("message_branchSummary")}
          </span>
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>{time}</span>}
        </div>

        <div style={{ padding: "11px 13px 12px" }}>
          <div style={{ marginBottom: 10, color: "var(--text-muted)", fontSize: 13, lineHeight: 1.5 }}>
            {t("message_branchSummaryDescription")}
          </div>
          {parsedSummary.body ? (
            <MarkdownBody className="markdown-compaction-message">{parsedSummary.body}</MarkdownBody>
          ) : (
            <span style={{ color: "var(--text-dim)", fontSize: 12 }}>({t("message_noSummary")})</span>
          )}
          <FileContextMetadata readFiles={readFiles} modifiedFiles={modifiedFiles} />
        </div>
      </div>
    </div>
  );
}

/** compaction 与 branch_summary 共享同一套文件上下文展示。 */
function FileContextMetadata({ readFiles, modifiedFiles }: { readFiles: string[]; modifiedFiles: string[] }) {
  const { t } = useI18n();
  const total = readFiles.length + modifiedFiles.length;
  if (total === 0) return null;

  const parts = [];
  if (readFiles.length > 0) parts.push(`${readFiles.length} ${t("message_read").toLowerCase()}`);
  if (modifiedFiles.length > 0) parts.push(`${modifiedFiles.length} ${t("message_modified").toLowerCase()}`);

  return (
    <details className="compaction-file-details">
      <summary>{t("message_fileContext")}: {parts.join(", ")}</summary>
      {modifiedFiles.length > 0 && <FileContextList title={t("message_modifiedFiles")} files={modifiedFiles} />}
      {readFiles.length > 0 && <FileContextList title={t("message_readFiles")} files={readFiles} />}
    </details>
  );
}

function FileContextList({ title, files }: { title: string; files: string[] }) {
  return (
    <div className="compaction-file-section">
      <div className="compaction-file-title">{title}</div>
      <ul className="compaction-file-list">
        {files.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * pidance.activity 渲染门禁：服务端 session-reader 投影时已由 parseActivityData
 * 严格校验；此处做浏览器安全的结构复验（parseActivityData 依赖 Node Buffer，
 * 不能进客户端 bundle）。只检查渲染所需不变量，不复制写入侧 schema/有界逻辑；
 * 不合法返回 null，由调用方回退通用 custom view。
 */
function toRenderableActivity(details: unknown): SessionActivity | null {
  if (!isRecord(details)) return null;
  if (details.version !== PIDANCE_ACTIVITY_VERSION) return null;
  if (typeof details.kind !== "string" || !(ACTIVITY_KINDS as readonly string[]).includes(details.kind)) return null;
  if (typeof details.title !== "string" || details.title.trim() === "") return null;
  if (typeof details.content !== "string") return null;
  if (details.source !== undefined && typeof details.source !== "string") return null;
  if (details.requestId !== undefined && typeof details.requestId !== "string") return null;
  if (details.metadata !== undefined && !isRecord(details.metadata)) return null;
  return details as unknown as SessionActivity;
}

const ACTIVITY_KIND_STYLES: Record<ActivityKind, { color: string; border: string; background: string; Icon: typeof CheckCircle2 }> = {
  result: { color: "var(--status-success)", border: "var(--status-success-border)", background: "var(--status-success-bg)", Icon: CheckCircle2 },
  warning: { color: "var(--status-warning)", border: "var(--status-warning-border)", background: "var(--status-warning-bg)", Icon: AlertTriangle },
  error: { color: "var(--error-text)", border: "var(--status-danger-border)", background: "var(--status-danger-bg)", Icon: XCircle },
  output: { color: "var(--accent)", border: "var(--border)", background: "var(--bg)", Icon: Terminal },
};

/** metadata 只取前几个原始类型键值做一行预览，绝不整对象倾倒。 */
function activityMetadataPreview(metadata: SessionActivity["metadata"]): [string, string][] {
  if (!metadata) return [];
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (entries.length >= 4) break;
    if (typeof value === "string") entries.push([key, value]);
    else if (typeof value === "number" || typeof value === "boolean") entries.push([key, String(value)]);
  }
  return entries;
}

/**
 * pidance.activity 持久卡片：title + 纯文本 content（pre-wrap，不注入 HTML），
 * 长 content 内部滚动。kind 用「图标 + 可见枚举 token + 色彩」三重区分，
 * 图标 aria-hidden，不作为唯一区分手段；不新增 locale key。
 */
function PidanceActivityView({ message, activity }: { message: CustomMessage; activity: SessionActivity }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const time = formatTime(message.timestamp);
  const { color, border, background, Icon } = ACTIVITY_KIND_STYLES[activity.kind];
  const hasContent = activity.content.trim() !== "";
  const metadataEntries = activityMetadataPreview(activity.metadata);

  const copyContent = () => {
    copyText(hasContent ? activity.content : activity.title).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <section
        aria-label={`${activity.kind}: ${activity.title}`}
        style={{
          border: `1px solid ${border}`,
          borderLeft: `2px solid ${color}`,
          borderRadius: 8,
          overflow: "hidden",
          background,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            minWidth: 0,
          }}
        >
          <span style={{ display: "flex", color, flexShrink: 0 }} aria-hidden="true">
            <Icon size={12} strokeWidth={1.8} />
          </span>
          <span
            style={{
              color,
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              fontWeight: 650,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              flexShrink: 0,
            }}
          >
            {activity.kind}
          </span>
          <span style={{ color: "var(--text)", fontSize: 13, fontWeight: 600, minWidth: 0, overflowWrap: "anywhere" }}>
            {activity.title}
          </span>
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>{time}</span>}
        </div>

        {hasContent && (
          <pre
            tabIndex={0}
            style={{
              margin: 0,
              padding: "8px 12px",
              maxHeight: 320,
              overflow: "auto",
              color: "var(--text)",
              fontSize: 12,
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {activity.content}
          </pre>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "4px 10px",
            padding: "4px 9px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-subtle)",
            color: "var(--text-dim)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
          }}
        >
          <button
            onClick={copyContent}
            title={t("message_copy")}
            aria-label={t("message_copy")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: "3px 7px",
              border: "none",
              background: "none",
              color: copied ? "var(--accent)" : "var(--text-dim)",
              cursor: "pointer",
            }}
          >
            {copied ? <Check size={11} strokeWidth={1.8} /> : <Copy size={11} strokeWidth={1.8} />}
          </button>
          {activity.source && <span style={{ overflowWrap: "anywhere" }}>{activity.source}</span>}
          {activity.requestId && <span style={{ overflowWrap: "anywhere" }} title={activity.requestId}>{activity.requestId}</span>}
          {metadataEntries.map(([key, value]) => (
            <span key={key} style={{ overflowWrap: "anywhere" }}>{key}={value}</span>
          ))}
        </div>
      </section>
    </div>
  );
}

function CustomMessageView({ message, cwd, onOpenFile }: { message: CustomMessage; cwd?: string; onOpenFile?: (filePath: string) => void }) {
  const { t } = useI18n();
  const isHiddenDisplay = message.display === false;
  const [contentExpanded, setContentExpanded] = useState(!isHiddenDisplay);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = getMessageText(message.content);
  const images = getMessageImages(message.content);
  const hasDetails = message.details !== undefined;
  const detailsText = hasDetails ? safeJson(message.details) : "";
  const title = message.customType || t("message_extensionDefaultType");
  const time = formatTime(message.timestamp);
  const renderedLines = getRenderableAnsiLines(message.renderedLines);

  const copyContent = () => {
    copyText(text || detailsText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: isHiddenDisplay ? "var(--bg-subtle)" : "var(--bg)",
          opacity: !renderedLines && isHiddenDisplay && !contentExpanded ? 0.82 : 1,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650 }}>
            {title}
          </span>
          {isHiddenDisplay && <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("message_hiddenExtensionMessage")}</span>}
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>{time}</span>}
        </div>

        {renderedLines ? (
          <pre
            style={{
              margin: 0,
              padding: "6px 9px",
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              lineHeight: 1.55,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {renderAnsiLines(renderedLines, "custom-rendered")}
          </pre>
        ) : contentExpanded ? (
          <div style={{ padding: "6px 9px" }}>
            {images.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: text ? 8 : 0 }}>
                {images.map((img, i) => {
                  const src = imageSource(img);
                  if (!src) return null;
                  return (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={i}
                      src={src}
                      alt=""
                      style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid var(--border)" }}
                    />
                  );
                })}
              </div>
            )}
            {text ? <MarkdownBody className="markdown-custom-message" cwd={cwd} onOpenFile={onOpenFile}>{text}</MarkdownBody> : <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("message_noMessages")}</span>}
          </div>
        ) : (
          <button
            onClick={() => setContentExpanded(true)}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 10px",
              border: "none",
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: 12,
              textAlign: "left",
            }}
          >
            {text ? previewText(text, t("message_noExtensionMessage")) : t("message_showExtensionMessage")}
          </button>
        )}

        {!renderedLines && <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "4px 9px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-subtle)",
          }}
        >
          {text || detailsText ? (
            <button
              onClick={copyContent}
              title={t("message_copy")}
              aria-label={t("message_copy")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: copied ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
              }}
            >
              {copied ? <Check size={11} strokeWidth={1.8} /> : <Copy size={11} strokeWidth={1.8} />}
            </button>
          ) : null}
          {(hasDetails || isHiddenDisplay) && (
            <button
              onClick={() => {
                if (isHiddenDisplay) setContentExpanded((v) => !v);
                else setDetailsExpanded((v) => !v);
              }}
              title={isHiddenDisplay
                ? (contentExpanded ? t("message_collapse") : t("message_expand"))
                : (detailsExpanded ? t("message_hideDetails") : t("message_showDetails"))}
              aria-label={isHiddenDisplay
                ? (contentExpanded ? t("message_collapse") : t("message_expand"))
                : (detailsExpanded ? t("message_hideDetails") : t("message_showDetails"))}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                marginLeft: "auto",
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: "var(--text-dim)",
                cursor: "pointer",
              }}
            >
              {(isHiddenDisplay ? contentExpanded : detailsExpanded)
                ? <ChevronUp size={12} strokeWidth={1.8} />
                : <ChevronDown size={12} strokeWidth={1.8} />}
            </button>
          )}
        </div>}

        {!renderedLines && hasDetails && ((isHiddenDisplay && contentExpanded) || (!isHiddenDisplay && detailsExpanded)) && (
          <pre
            style={{
              margin: 0,
              padding: "9px 10px",
              borderTop: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 360,
              overflow: "auto",
              fontFamily: "var(--font-mono)",
            }}
          >
            {detailsText}
          </pre>
        )}
      </div>
    </div>
  );
}

function getMessageText(content: CustomMessage["content"] | UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function getMessageImages(content: CustomMessage["content"] | UserMessage["content"]): ImageContent[] {
  if (typeof content === "string") return [];
  return content.filter((b): b is ImageContent => b.type === "image");
}

function imageSource(img: ImageContent): string {
  const flat = img as unknown as { data?: string; mimeType?: string };
  if (img.source) {
    return img.source.type === "base64"
      ? `data:${img.source.media_type};base64,${img.source.data}`
      : img.source.url ?? "";
  }
  return flat.data ? `data:${flat.mimeType};base64,${flat.data}` : "";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}


function previewText(text: string, fallback: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.length > 140 ? `${normalized.slice(0, 140)}...` : normalized;
}


function getToolPreview(block: ToolCallContent): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";
  const keys = Object.keys(input);
  if (keys.length === 0) return "";

  // Common tool input patterns
  if ("command" in input) return String(input.command).slice(0, 120);
  if ("path" in input) return String(input.path).slice(0, 120);
  if ("file_path" in input) return String(input.file_path).slice(0, 120);
  if ("pattern" in input) return String(input.pattern).slice(0, 120);
  if ("query" in input) return String(input.query).slice(0, 120);

  const first = input[keys[0]];
  return String(first).slice(0, 120);
}

function formatUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}): string {
  const parts = [];
  if (usage.input) parts.push(`${usage.input.toLocaleString()} in`);
  if (usage.output) parts.push(`${usage.output.toLocaleString()} out`);
  if (usage.cacheRead) parts.push(`${usage.cacheRead.toLocaleString()} cache`);
  if (usage.cost?.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
  return parts.join(" · ");
}

function BashExecutionView({ message, sessionId }: { message: BashExecutionMessage; sessionId?: string }) {
  const { t } = useI18n();
  const [fullOutput, setFullOutput] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fullError, setFullError] = useState<string | null>(null);

  const isPending = !message.output && message.exitCode === undefined && !message.cancelled;
  const isError = message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);
  const fullOutputUrl = sessionId && message.fullOutputPath
    ? `/api/agent/${encodeURIComponent(sessionId)}/bash-output?path=${encodeURIComponent(message.fullOutputPath)}`
    : null;
  const showFullButton = message.truncated && fullOutputUrl && fullOutput === null;
  const displayOutput = fullOutput ?? message.output;

  async function loadFullOutput() {
    if (!fullOutputUrl) return;
    setLoadingFull(true);
    setFullError(null);
    try {
      const res = await fetch(fullOutputUrl);
      const d = await res.json() as { success?: boolean; data?: { output?: string }; error?: string };
      if (d.success) {
        setFullOutput(d.data?.output ?? "");
      } else {
        setFullError(d.error ?? "failed");
      }
    } catch (e) {
      setFullError(String(e));
    } finally {
      setLoadingFull(false);
    }
  }

  // Reuse the existing ToolCallBlock so user-run bash looks identical to an
  // agent-run bash tool call: same header, collapse behavior, result pane.
  // Synthesize an equivalent ToolCallContent + ToolResultMessage pair.
  const toolName = message.excludeFromContext ? "bash (local)" : "bash";
  const block: ToolCallContent = {
    type: "toolCall",
    toolCallId: `bash-${message.timestamp ?? ""}`,
    toolName,
    input: { command: message.command },
  };
  const result: ToolResultMessage | undefined = isPending
    ? undefined
    : {
        role: "toolResult",
        toolCallId: block.toolCallId,
        toolName,
        content: displayOutput ? [{ type: "text", text: displayOutput }] : [],
        isError,
        timestamp: message.timestamp,
      };

  return (
    <div style={{ margin: "6px 0" }}>
      <ToolCallBlock block={block} result={result} pending={isPending} />
      {message.truncated && fullOutputUrl && (
        <div style={{ padding: "4px 10px", fontSize: 11, marginTop: -1 }}>
          {showFullButton && (
            <button
              onClick={loadFullOutput}
              disabled={loadingFull}
              style={{ background: "none", border: "none", color: "var(--accent)", cursor: loadingFull ? "default" : "pointer", fontSize: 11, padding: 0, textDecoration: "underline" }}
            >
              {loadingFull ? t("message_loadingOutput") : t("message_viewFullOutput")}
            </button>
          )}
          <a
            href={`${fullOutputUrl}&download=1`}
            style={{ marginLeft: showFullButton ? 10 : 0, color: "var(--accent)", fontSize: 11, textDecoration: "underline" }}
          >
            {t("message_downloadFullOutput")}
          </a>
          {fullError && <span style={{ marginLeft: 6, color: "var(--text-dim)", fontSize: 11 }}>({fullError})</span>}
        </div>
      )}
    </div>
  );
}
