"use client";

import React, { useRef, useState, useCallback, useEffect, useMemo, useId, useImperativeHandle, forwardRef, KeyboardEvent } from "react";
import { thinkingLabel as resolveThinkingLabel } from "@/lib/thinking-level-policy";
import { createPortal } from "react-dom";
import type { BuiltinSlashCommandResult, CommandArgumentCompletion, CompactResultInfo, QueuedMessageRow as QueuedRow, QueuedMessages, SlashCommandInfo } from "@/hooks/useAgentSession";
import { clearDraft, getDraft, setDraft, type ChatDraftImage } from "@/lib/draft-store";
import { getServerPref, setServerPref, useServerPreferences } from "@/lib/server-preferences";
import { listThinkingDisplayLevel, modelClickThinkingLevel } from "@/lib/thinking-level-policy";
import { thinkingLevelsFromMap } from "@/lib/thinking-levels";
import { hydrateDraftFromServer } from "@/lib/draft-store";
import { ensureServerPrefsLoaded } from "@/lib/server-preferences";
import {
  buildEntriesFromFiles, buildAtInsertText, extractAtQuery, filterFileEntries,
  type AtQueryMatch, type FileIndexEntry,
} from "@/lib/file-fuzzy";
import { FolderIcon, getFileIcon } from "./FileIcons";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useAnchoredOverlay } from "@/hooks/useAnchoredOverlay";
import { useExtensionWidgetKeys } from "@/hooks/useExtensionWidgetKeys";
import { useI18n } from "@/lib/i18n";
import {
  attachmentBinaryBlocks,
  attachmentPreviewUrl,
  deleteAttachmentMedia,
  imageMediaRefs,
  mediaRefPaths,
  uploadImageAttachment,
  uploadMessageMedia,
} from "@/lib/attachment-upload";
import type { AttachedImage, BinaryMessageInput, ChatInputHandle } from "@/lib/types";
import {
  loadStreamingEnterAction,
  type StreamingEnterAction,
} from "@/lib/ui-preferences";
import { isAudioPath, isImagePath, isVideoPath } from "@/lib/file-types";
import { CHAT_COLUMN_MAX_WIDTH_CSS, CHAT_GUTTER } from "@/lib/chat-column";
import { sessionExceedsModelWindow, DEFAULT_COMPACTION_RESERVE_TOKENS } from "@/lib/session-context-window";

export type { AttachedImage, ChatInputHandle } from "@/lib/types";

/** 非图片附件：落到 ~/.pi/agent/pidance-attachments/，二进制消息保存后把路径注入 prompt。 */
type AttachedUpload = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path?: string;
  status: "uploading" | "ready" | "error";
  error?: string;
};

/** 选图后先上传的附件：未完成/失败时阻塞发送，可重试或移除。 */
type PendingAttachment = {
  id: string;
  file: File;
  previewUrl: string;
  status: "uploading" | "failed";
  error?: string;
  /** 发起上传时的草稿 key：完成时若已不在该草稿，附件作废并回收文件。 */
  draftKey: string | null;
};

function isRasterImageFile(file: File): boolean {
  return file.type.startsWith("image/") && file.type !== "image/svg+xml";
}

function makeUploadId(): string {
  return `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
}

interface Props {
  /**
   * P0-1：返回发送确认结果——false = 发送失败（draft 由上层恢复，此处不清空）；
   * true/undefined = 已确认或无可确认（清空 draft）。
   */
  onSend: (message: string, images?: AttachedImage[], binaryBlocks?: BinaryMessageInput[]) => Promise<boolean> | boolean;
  onAbort: () => void;
  onSteer?: (message: string, images?: AttachedImage[]) => void;
  onFollowUp?: (message: string, images?: AttachedImage[]) => void;
  onPromptWithStreamingBehavior?: (message: string, behavior: "steer" | "followUp", images?: AttachedImage[]) => void;
  isStreaming: boolean;
  /** 阻塞式扩展问答显示时，保留输入框布局但冻结普通聊天操作。 */
  blocked?: boolean;
  model?: { provider: string; modelId: string } | null;
  isAutoModelSelection?: boolean;
  modelNames?: Record<string, string>;
  modelList?: {
    id: string;
    name: string;
    provider: string;
    contextWindow?: number;
    maxTokens?: number;
  }[];
  /** providerId → 是否有可用凭据；未认证且无环境凭据的 provider 模型在列表中灰显禁用。 */
  /** 当前会话上下文占用（tokens，估算）；仅用于切换前与目标模型声明窗口对比。 */
  sessionTokens?: number | null;
  modelAuthConfigured?: Record<string, boolean>;
  onModelChange?: (provider: string, modelId: string, thinkingLevel?: string | null) => void;
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
  compactResult?: CompactResultInfo | null;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** 会话思考档是否已被权威源确认；未确认（会话切换/加载中）时不显示档位标签。 */
  thinkingReady?: boolean;
  onThinkingLevelChange?: (level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => void;
  /** settings.json defaultThinkingLevel，无会话档/无缓存时的回退 */
  defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  /** 每模型思考级别映射（provider:modelId → map） */
  thinkingLevelMaps?: Record<string, Record<string, string | null>> | null;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  queuedMessages?: QueuedMessages | null;
  onRecallQueue?: () => void;
  /** 将队列中消息按引导方式重新入队（follow-up → steer）；可选 extraMessage 并入队尾。 */
  onSendQueueAsSteer?: (extraMessage?: string) => void;
  slashCommands?: SlashCommandInfo[];
  slashCommandsLoading?: boolean;
  onLoadSlashCommands?: () => Promise<SlashCommandInfo[]> | SlashCommandInfo[];
  /**
   * 斜杠命令的参数候选（issue #75）：`prefix` 是命令名之后的整段文本。
   * 与 onLoadSlashCommands 同一注入口径 —— 组件不直接发命令请求。
   */
  onLoadCommandArgumentCompletions?: (name: string, prefix: string) => Promise<CommandArgumentCompletion[]>;
  onBuiltinCommand?: (message: string) => Promise<BuiltinSlashCommandResult>;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  onAudioUnlock?: () => void;
  /** footer（输入框下方状态条）折叠状态与切换 */
  footerCollapsed?: boolean;
  onFooterToggle?: () => void;
  draftKey?: string;
  /** Session working directory — enables the @ file autocomplete menu */
  cwd?: string | null;
  /** 当前会话 id（插件 widget 的按键路由与焦点上报需要）。 */
  sessionId?: string | null;
  /**
   * 插件 widget 的按键窄口子是否可用：没有 custom 面板、该会话存在 widget、
   * 且有插件注册了全局按键监听时才为 true。
   */
  extensionWidgetKeysEnabled?: boolean;
}

/** token 数友好格式化：1000000 → 1M，256000 → 256K。 */
function formatTokens(n: number): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "";
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${Number.isInteger(v) ? v : v.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

const COMPOSITION_END_ENTER_GRACE_MS = 100;
const MODEL_OPTION_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareModelOptions(a: ModelOption, b: ModelOption): number {
  return MODEL_OPTION_COLLATOR.compare(a.name || a.modelId, b.name || b.modelId)
    || MODEL_OPTION_COLLATOR.compare(a.provider, b.provider)
    || MODEL_OPTION_COLLATOR.compare(a.modelId, b.modelId);
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const THINKING_LEVEL_DESC: Record<typeof THINKING_LEVELS[number], "input_thinkingOff" | "input_thinkingMinimal" | "input_thinkingLow" | "input_thinkingMedium" | "input_thinkingHigh" | "input_thinkingXhigh" | "input_thinkingMax"> = {
  off: "input_thinkingOff",
  minimal: "input_thinkingMinimal",
  low: "input_thinkingLow",
  medium: "input_thinkingMedium",
  high: "input_thinkingHigh",
  xhigh: "input_thinkingXhigh",
  max: "input_thinkingMax",
};

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return tokens.toLocaleString();
}

type SlashCommandPaletteItem = SlashCommandInfo | {
  name: string;
  description: string;
  source: "builtin";
};

type SlashCommandSource = SlashCommandPaletteItem["source"];

const BUILTIN_SLASH_COMMANDS: SlashCommandPaletteItem[] = [
  { name: "compact", description: "input_compactCommandDescription", source: "builtin" },
  { name: "reload", description: "input_reloadCommandDescription", source: "builtin" },
  { name: "name", description: "input_nameCommandDescription", source: "builtin" },
  { name: "session", description: "input_sessionCommandDescription", source: "builtin" },
  { name: "copy", description: "input_copyCommandDescription", source: "builtin" },
];

const SLASH_SOURCES: SlashCommandSource[] = ["builtin", "extension", "prompt", "skill"];

const SLASH_SOURCE_GROUP_LABEL: Record<SlashCommandSource, "input_builtIn" | "input_extensions" | "input_prompts" | "input_skills"> = {
  builtin: "input_builtIn",
  extension: "input_extensions",
  prompt: "input_prompts",
  skill: "input_skills",
};

const SLASH_SOURCE_ORDER: Record<SlashCommandSource, number> = {
  builtin: 0,
  extension: 1,
  prompt: 2,
  skill: 3,
};

function slashMatchRank(command: SlashCommandPaletteItem, query: string): number {
  const name = command.name.toLowerCase();
  const description = command.description?.toLowerCase() ?? "";
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (description.includes(query)) return 3;
  return 4;
}

function imageToDraftImage(image: AttachedImage): ChatDraftImage {
  return {
    mimeType: image.mimeType,
    ...(image.media ? { media: image.media } : {}),
    ...(image.original ? { original: image.original } : {}),
    // 兼容路径：既没有引用也没有原图元数据时（旧扩展直调）只能存内联字节
    ...(!image.media && !image.original && image.data ? { data: image.data } : {}),
  };
}

function draftImageToAttachedImage(image: ChatDraftImage): AttachedImage {
  const attached: AttachedImage = {
    mimeType: image.mimeType,
    ...(image.data ? { data: image.data } : {}),
    ...(image.media ? { media: image.media } : {}),
    ...(image.original ? { original: image.original } : {}),
  };
  // 草稿只存引用：缩略图走附件读取 URL，不再拿 base64 拼 data URL。
  attached.previewUrl = image.data
    ? `data:${image.mimeType};base64,${image.data}`
    : attachmentPreviewUrl(attached);
  return attached;
}

/** 附件身份：优先引用路径（取回/草稿恢复都会重建 previewUrl）。 */
function attachmentIdentity(image: AttachedImage): string {
  const path = image.media?.original.path ?? image.original?.path;
  return path ?? `${image.mimeType}:${image.data?.slice(0, 64) ?? ""}`;
}

function revokeImagePreview(image: AttachedImage): void {
  if (image.previewUrl?.startsWith("blob:")) {
    URL.revokeObjectURL(image.previewUrl);
  }
}

/** 菜单/列表框打开时聚焦选项：选中项（aria-checked/aria-selected）优先，否则首项。 */
function focusPanelOption(panel: HTMLElement | null, selector: string): void {
  if (!panel) return;
  const selected = panel.querySelector<HTMLElement>(`${selector}[aria-checked="true"], ${selector}[aria-selected="true"]`);
  const first = panel.querySelector<HTMLElement>(selector);
  (selected ?? first)?.focus({ preventScroll: true });
}

/** ↑↓ 在面板选项间循环移动焦点，Home/End 跳首尾；焦点始终停留在选项按钮上。 */
function movePanelOptionFocus(e: React.KeyboardEvent<HTMLElement>, selector: string): void {
  const key = e.key;
  if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(selector));
  if (items.length === 0) return;
  e.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  if (key === "Home") next = 0;
  else if (key === "End") next = items.length - 1;
  else if (key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
  else next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
  items[next]?.focus({ preventScroll: true });
}

/** 聚焦锚点容器内的触发按钮（菜单关闭后把焦点还给 trigger）。 */
function focusTriggerButton(anchor: HTMLElement | null): void {
  anchor?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
}

/** 队列行。`stateLabel` 非空时额外渲染状态徽标（在途 / 结果未知）。 */
function QueuedMessageRow({ kind, text, state, stateLabel, imageCount }: { kind: "steer" | "follow-up"; text: string; state?: QueuedRow["state"]; stateLabel?: string; imageCount?: number }) {
  return (
    <div
      title={text}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "3px 10px",
        fontSize: 12,
        color: "var(--text-muted)",
        minWidth: 0,
      }}
    >
      <span
        style={{
          flexShrink: 0,
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          padding: "1px 7px",
          borderRadius: 999,
          border: `1px solid ${kind === "steer" ? "color-mix(in srgb, var(--accent) 45%, transparent)" : "var(--border)"}`,
          color: kind === "steer" ? "var(--accent)" : "var(--text-dim)",
        }}
      >
        {kind}
      </span>
      {imageCount ? (
        // 图片数量必须可见：带图消息在 UI 里只有一个文字摘要，没有图数就看不出图还在。
        <span
          style={{
            flexShrink: 0,
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            padding: "1px 7px",
            borderRadius: 999,
            border: "1px solid var(--border)",
            color: "var(--text-dim)",
          }}
        >
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="m21 15-5-5L5 21" />
          </svg>
          {imageCount}
        </span>
      ) : null}
      {state && state !== "waiting" && (
        // 在途/结果未知必须显式可见：用户不能把「已提交未确认」当成还排队着。
        <span
          style={{
            flexShrink: 0,
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            padding: "1px 7px",
            borderRadius: 999,
            border: `1px solid ${state === "unknown" ? "color-mix(in srgb, var(--status-warning) 45%, transparent)" : "color-mix(in srgb, var(--accent) 35%, transparent)"}`,
            color: state === "unknown" ? "var(--status-warning)" : "var(--text-dim)",
          }}
        >
          {stateLabel ?? state}
        </span>
      )}
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
    </div>
  );
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSend, onAbort, onSteer, onFollowUp, isStreaming, blocked = false, model, isAutoModelSelection, modelNames, modelList, sessionTokens, modelAuthConfigured, onModelChange,
  onAbortCompaction, isCompacting, compactError, compactResult,
  thinkingLevel, thinkingReady, onThinkingLevelChange, defaultThinkingLevel, availableThinkingLevels, thinkingLevelMap, thinkingLevelMaps,
  retryInfo, queuedMessages, onRecallQueue, onSendQueueAsSteer,
  slashCommands, slashCommandsLoading, onLoadSlashCommands, onLoadCommandArgumentCompletions,
  onBuiltinCommand,
  onAudioUnlock,
  onPromptWithStreamingBehavior,
  footerCollapsed, onFooterToggle,
  draftKey,
  cwd,
  sessionId,
  extensionWidgetKeysEnabled = false,
}: Props, ref) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  /** 桌面流式期 Enter 默认动作（followUp/steer）；手机端回车仅换行。 */
  const [streamingEnterDefault, setStreamingEnterDefault] = useState<StreamingEnterAction>("followUp");
  /** 输入框（主编辑器）是否聚焦：插件靠它判断 `tui.focusedComponent`。 */
  const [composerFocused, setComposerFocused] = useState(false);
  // 队列行（含在途 claimed 与结果未知 unknown）；旧 Host 不回 followUpRows 时回落正文。
  const queuedRows: QueuedRow[] = queuedMessages?.followUpRows?.length
    ? queuedMessages.followUpRows
    : (queuedMessages?.followUp ?? []).map((text, index) => ({ id: `legacy-${index}`, text, state: "waiting" as const, imageCount: 0 }));
  const queueStateLabel = (state: QueuedRow["state"]) => state === "unknown"
    ? t("input_queueStateUnknown")
    : state === "claimed" ? t("input_queueStateClaimed") : undefined;
  useEffect(() => {
    setStreamingEnterDefault(loadStreamingEnterAction());
    const onStorage = (e: StorageEvent) => {
      if (e.key === "pidance.streamingEnterDefault") {
        setStreamingEnterDefault(loadStreamingEnterAction());
      }
    };
    const onLocal = () => setStreamingEnterDefault(loadStreamingEnterAction());
    window.addEventListener("storage", onStorage);
    window.addEventListener("pidance:streaming-enter-changed", onLocal);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pidance:streaming-enter-changed", onLocal);
    };
  }, []);
  const [value, setValue] = useState(() => (draftKey ? getDraft(draftKey)?.value ?? "" : ""));
  // 插件 widget 的按键交互与焦点上报：只在没有 custom 面板、且该会话存在 widget 时开。
  // 普通打字不走这条路（一次请求都不发），细节见 hooks/useExtensionWidgetKeys.ts。
  useExtensionWidgetKeys({
    sessionId: sessionId ?? null,
    enabled: extensionWidgetKeysEnabled,
    composerEmpty: value.length === 0,
    composerFocused,
  });
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [toolDropdownOpen, setToolDropdownOpen] = useState(false);
  const [queueExpanded, setQueueExpanded] = useState(true);

  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>(() => (
    draftKey ? getDraft(draftKey)?.images.map(draftImageToAttachedImage) ?? [] : []
  ));
  const [imageAttachError, setImageAttachError] = useState<string | null>(null);
  /**
   * 选图后正在上传的附件。
   *
   * 附件进输入框就先上传：条目/草稿只持引用，删除附件才能真的回收字节。
   * 上传未完成或失败时**阻塞发送**（可重试/移除），不得静默降级成纯文本
   * ——那正是 issue #42 要消灭的行为。
   */
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const pendingAttachmentsRef = useRef(pendingAttachments);
  pendingAttachmentsRef.current = pendingAttachments;
  const trimmedValue = value.trimStart();
  const bashMode = attachedImages.length === 0 && trimmedValue.startsWith("!");
  const bashExcluded = bashMode && trimmedValue.startsWith("!!");
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  // 斜杠命令的参数候选（issue #75）：与命令名菜单互斥（由 argQuery 驱动）。
  const [argItems, setArgItems] = useState<CommandArgumentCompletion[]>([]);
  const [argActiveIndex, setArgActiveIndex] = useState(0);
  const [argLoading, setArgLoading] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [atQuery, setAtQuery] = useState<AtQueryMatch | null>(null);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const [fileIndex, setFileIndex] = useState<{ cwd: string; entries: FileIndexEntry[]; truncated: boolean } | null>(null);
  const [fileIndexLoading, setFileIndexLoading] = useState(false);
  const [atServerResult, setAtServerResult] = useState<{ cwd: string; query: string; matches: FileIndexEntry[] } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** 内建 slash 提交中：同帧重复提交只发一次（ref 挡同步重入，state 给 a11y 用）。 */
  const builtinCommandPendingRef = useRef(false);
  const [builtinCommandPending, setBuiltinCommandPending] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const modelDropdownPanelRef = useRef<HTMLDivElement>(null);
  const toolDropdownRef = useRef<HTMLDivElement>(null);
  const toolDropdownPanelRef = useRef<HTMLDivElement>(null);

  const inputContainerRef = useRef<HTMLDivElement>(null);
  const slashOverlayRef = useRef<HTMLDivElement>(null);
  const atOverlayRef = useRef<HTMLDivElement>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const slashCommandsRequestedRef = useRef(false);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const argOverlayRef = useRef<HTMLDivElement>(null);
  const argItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /** 参数补全请求序号：迟到的响应不得覆盖最新一次请求的结果。 */
  const argRequestSeqRef = useRef(0);
  const atItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fileIndexMetaRef = useRef<{ cwd: string; fetchedAt: number } | null>(null);
  const fileIndexFetchingRef = useRef<string | null>(null);
  const draftKeyRef = useRef(draftKey);

  // —— 模型信息与思考深度（需求 5）——
  /** 当前展开思考深度浮层的模型（provider:modelId）；null = 未展开 */
  const [depthMenuFor, setDepthMenuFor] = useState<string | null>(null);
  /** 深度菜单 fixed 坐标（从模型行右侧弹出；portal 到 body，手机同逻辑） */
  const [depthMenuPos, setDepthMenuPos] = useState<{ top: number; left: number } | null>(null);
  const depthMenuRef = useRef<HTMLDivElement | null>(null);
  const openDepthMenu = useCallback((depthKey: string, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    const menuWidth = 120;
    const gap = 6;
    // 优先从触发点右侧弹出；右侧不够则翻到左侧
    let left = rect.right + gap;
    if (left + menuWidth > window.innerWidth - 8) {
      left = Math.max(8, rect.left - menuWidth - gap);
    }
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - 8 - 44 * 8));
    setDepthMenuPos({ top, left });
    setDepthMenuFor(depthKey);
  }, []);
  const closeDepthMenu = useCallback(() => {
    setDepthMenuFor(null);
    setDepthMenuPos(null);
  }, []);
  // 点击外部关闭深度浮层（点在模型列表内延后关闭，避免 pointerdown 重渲染吞掉 click 选模型）
  useEffect(() => {
    if (depthMenuFor === null) return;
    const onDocClick = (e: PointerEvent) => {
      const target = e.target as Node;
      const el = target as HTMLElement;
      if (depthMenuRef.current?.contains(target)) return;
      if (el?.closest?.("[data-depth-trigger]")) return;
      if (modelDropdownPanelRef.current?.contains(target)) {
        window.setTimeout(() => closeDepthMenu(), 0);
        return;
      }
      closeDepthMenu();
    };
    document.addEventListener("pointerdown", onDocClick);
    window.addEventListener("resize", closeDepthMenu);
    // 不 capture：避免模型列表内部滚动时误伤；窗口滚动再关
    window.addEventListener("scroll", closeDepthMenu);
    return () => {
      document.removeEventListener("pointerdown", onDocClick);
      window.removeEventListener("resize", closeDepthMenu);
      window.removeEventListener("scroll", closeDepthMenu);
    };
  }, [closeDepthMenu, depthMenuFor]);

  /** 模型信息 tooltip 文案。 */
  const modelInfoTitle = useCallback(
    (m: { modelId: string; name: string; provider: string; contextWindow?: number; maxTokens?: number }): string => {
      const parts: string[] = [m.name];
      if (typeof m.contextWindow === "number") parts.push(`${t("input_modelContext")} ${formatTokens(m.contextWindow)}`);
      if (typeof m.maxTokens === "number") parts.push(`${t("input_modelMaxOutput")} ${formatTokens(m.maxTokens)}`);
      // 切换前对比：本会话占用（估算）与目标模型声明窗口。声明值可能是乐观的，
      // 文案保留不确定性；命中也只提示、不阻止切换。
      if (typeof sessionTokens === "number" && sessionTokens > 0 && typeof m.contextWindow === "number") {
        parts.push(sessionExceedsModelWindow(sessionTokens, m.contextWindow)
          ? t("input_modelSessionOverflow", {
              tokens: formatTokens(sessionTokens),
              window: formatTokens(m.contextWindow),
              reserve: formatTokens(DEFAULT_COMPACTION_RESERVE_TOKENS),
            })
          : t("input_modelSessionUsage", {
              tokens: formatTokens(sessionTokens),
              window: formatTokens(m.contextWindow),
            }));
      }
      return parts.join(" · ");
    },
    [t, sessionTokens],
  );

  const thinkingFallback = defaultThinkingLevel ?? "off";
  // 标签只在会话权威档位已到时显示；已有会话不回落到 off（切会话瞬间会闪错值），
  // 引导页（defaultThinkingLevel 非空）才用 settings 默认作真实取值。
  const thinkingLabel = resolveThinkingLabel(
    thinkingReady !== false,
    thinkingLevel,
    defaultThinkingLevel ? thinkingFallback : null,
  );

  /** 每模型可用思考深度：仅 map 显式 null 禁用；省略（含 xhigh/max）可用。 */
  const levelsForModel = useCallback(
    (provider: string, modelId: string): string[] => {
      const map = thinkingLevelMaps?.[`${provider}:${modelId}`];
      return thinkingLevelsFromMap(true, map ?? undefined);
    },
    [thinkingLevelMaps],
  );

  // 订阅服务端偏好，保证写缓存后列表立即刷新
  const serverPrefs = useServerPreferences();
  /** 每模型独立缓存的思考深度（嵌套键 thinkingLevel[provider:modelId]）。 */
  const cachedThinkingLevel = useCallback(
    (provider: string, modelId: string): string | null => {
      // 依赖 serverPrefs 触发重渲染；读路径走 getServerPref 解析点路径
      void serverPrefs;
      const v = getServerPref<string>(`thinkingLevel.${provider}:${modelId}`);
      return typeof v === "string" && v ? v : null;
    },
    [serverPrefs],
  );

  /** 选择思考深度：写缓存 + 应用（带深度切换模型）。 */
  const applyModelWithThinking = useCallback(
    (provider: string, modelId: string, level: string) => {
      setServerPref(`thinkingLevel.${provider}:${modelId}`, level);
      closeDepthMenu();
      // 选择后关闭模型选择列表并切换模型 + 思考深度
      setModelDropdownOpen(false);
      modelButtonRef.current?.focus({ preventScroll: true });
      onModelChange?.(provider, modelId, level);
    },
    [closeDepthMenu, onModelChange],
  );

  // 服务端草稿恢复（多客户端同步）：挂载/切 key 时若服务端有草稿且本地为空则回填
  const draftRestoredRef = useRef<string | null>(null);
  useEffect(() => {
    const key = draftKey;
    if (!key) return;
    void ensureServerPrefsLoaded().then(() => {
      if (draftRestoredRef.current === key) return;
      draftRestoredRef.current = key;
      const remote = hydrateDraftFromServer(key);
      if (!remote) return;
      // 本地已有更新的内存草稿（本会话编辑过）则不覆盖
      const local = getDraft(key);
      if (local && (local.value !== "" || local.images.length > 0)) return;
      setValue(remote.value);
      if (remote.images.length > 0) {
        setAttachedImages(remote.images.map(draftImageToAttachedImage));
      }
    });
  }, [draftKey, setAttachedImages]);
  const valueRef = useRef(value);
  const attachedImagesRef = useRef(attachedImages);
  valueRef.current = value;
  attachedImagesRef.current = attachedImages;

  const insertIfEmptyLocal = useCallback((text: string) => {
    const ta = textareaRef.current;
    const current = ta ? ta.value : value;
    if (current.trim()) return;
    setValue(text);
    setAtQuery(null);
    requestAnimationFrame(() => {
      if (!ta) return;
      ta.focus();
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, [value]);

  /**
   * 把图片追加到草稿（去重）：失败回滚与队列取回共用。
   * 预览只是浏览器临时态，这里按 base64 重建。
   */
  const appendAttachedImages = useCallback((images?: AttachedImage[]) => {
    if (!images?.length) return;
    // 已有 previewUrl 的条目原样保留（本地 blob 预览不必重建）
    const restored = images.map((image) => image.previewUrl ? image : draftImageToAttachedImage(imageToDraftImage(image)));
    setAttachedImages((previous) => {
      const known = new Set(previous.map(attachmentIdentity));
      return [...previous, ...restored.filter((image) => !known.has(attachmentIdentity(image)))];
    });
  }, []);

  /** 把 text 放到当前草稿之前（与 TUI 的队列恢复一致，空行分隔）。 */
  const prependDraftText = useCallback((text: string, images?: AttachedImage[]) => {
    if (!text.trim() && !images?.length) return;
    appendAttachedImages(images);
    if (!text.trim()) return;
    const ta = textareaRef.current;
    const current = ta ? ta.value : value;
    const combined = [text, current].filter((t) => t.trim()).join("\n\n");
    setValue(combined);
    setAtQuery(null);
    requestAnimationFrame(() => {
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(combined.length, combined.length);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, [value]);

  /** 从当前 draftKey 的草稿重建输入框（外部写入草稿后刷新显示）。 */
  const reloadDraftLocal = useCallback(() => {
    const key = draftKeyRef.current;
    const draft = key ? getDraft(key) : null;
    setValue(draft?.value ?? "");
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return draft?.images.map(draftImageToAttachedImage) ?? [];
    });
    setAtQuery(null);
  }, []);

  useImperativeHandle(ref, () => ({
    // 焦点交回输入框：插件面板/对话框关闭后由 ChatWindow 调用（见那边的 layout effect）。
    focus() {
      textareaRef.current?.focus();
    },
    insertIfEmpty: insertIfEmptyLocal,
    prependText: prependDraftText,
    reloadDraft: reloadDraftLocal,
    restoreDraft(text: string, failedImages?: AttachedImage[], ownerKey?: string) {
      // 内容已归属别的会话（用户切走后再回来）：写它自己的草稿，**不动**当前输入框。
      // 旧实现只在「仍在原会话」时才恢复，切走后内容既不回输入框也不进草稿 →
      // 队列已清、内容消失（F4）。
      if (ownerKey && ownerKey !== draftKeyRef.current) {
        const existing = getDraft(ownerKey) ?? { value: "", images: [] };
        const restored = (failedImages ?? []).map(imageToDraftImage);
        setDraft(ownerKey, {
          value: [text, existing.value].filter((part) => part.trim()).join("\n\n"),
          images: [...restored, ...existing.images],
        });
        return;
      }
      // 失败回滚：正文与图片一起回原位。
      appendAttachedImages(failedImages);
      prependDraftText(text);
    },
    replaceText(text: string) {
      // 分支 / 新会话预填：整体替换当前草稿（对齐 OC revert/fork 的 pendingInputText replace）。
      const ta = textareaRef.current;
      setValue(text);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        const pos = text.length;
        ta.setSelectionRange(pos, pos);
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    insertText(text: string) {
      const ta = textareaRef.current;
      if (!ta) {
        setValue((v) => v + (v ? " " : "") + text);
        return;
      }
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const sep = before.length > 0 && !before.endsWith(" ") ? " " : "";
      const newVal = before + sep + text + after;
      setValue(newVal);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        const pos = start + sep.length + text.length;
        ta.setSelectionRange(pos, pos);
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    addFiles(files: File[]) {
      void attachFiles(files);
    },
  }));

  const [attachedUploads, setAttachedUploads] = useState<AttachedUpload[]>([]);
  const attachedUploadsRef = useRef(attachedUploads);
  attachedUploadsRef.current = attachedUploads;

  /**
   * 上传一个待附加图片（原图 + 缩小预览 + 模型副本）。
   *
   * 成功才进入已附加列表：失败保留在 pending 里，由用户重试或移除——不静默
   * 丢掉用户刚选的图，也不带着半个附件发送。
   *
   * 完成时必须校验归属：上传期间用户可能移除了该附件、或切到了别的会话/草稿。
   * 旧实现在回调里无条件 append + 只删 pending 项，于是「已经移掉的图」会重新
   * 出现在输入框，而它引用的文件成为没人引用的孤儿（F5）。
   */
  const startAttachmentUpload = useCallback(async (entry: PendingAttachment) => {
    setPendingAttachments((prev) =>
      prev.map((item) => (item.id === entry.id ? { ...item, status: "uploading", error: undefined } : item)));
    try {
      const image = await uploadImageAttachment(entry.file, entry.previewUrl);
      const stillOwned = draftKeyRef.current === entry.draftKey
        && pendingAttachmentsRef.current.some((item) => item.id === entry.id);
      if (!stillOwned) {
        // 已不归属当前输入框：刚上传的文件没人引用，直接删（不靠 GC 兜底）。
        URL.revokeObjectURL(entry.previewUrl);
        void deleteAttachmentMedia(imageMediaRefs(image).flatMap(mediaRefPaths));
        return;
      }
      setAttachedImages((prev) => [...prev, image]);
      // 预览 URL 已交给已附加的图片，不再回收。
      setPendingAttachments((prev) => prev.filter((item) => item.id !== entry.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPendingAttachments((prev) =>
        prev.map((item) => (item.id === entry.id ? { ...item, status: "failed", error: message } : item)));
    }
  }, []);

  const processImageFiles = useCallback(async (files: File[]) => {
    // 运行中同样允许附带图片：steer / follow-up 都支持图片（host 直接发 prompt），
    // 原先这里直接 return 会让粘贴/拖入静默失效。
    const imageFiles = files.filter(isRasterImageFile);
    if (!imageFiles.length) return;
    setImageAttachError(null);
    const draftKey = draftKeyRef.current ?? null;
    const entries: PendingAttachment[] = imageFiles.map((file) => ({
      id: makeUploadId(),
      file,
      previewUrl: URL.createObjectURL(file),
      status: "uploading",
      draftKey,
    }));
    setPendingAttachments((prev) => [...prev, ...entries]);
    await Promise.all(entries.map((entry) => startAttachmentUpload(entry)));
  }, [startAttachmentUpload]);

  /**
   * 附件策略：
   * - 位图图片 → 原图保存为二进制消息，模型只接收安全尺寸副本
   * - 其余 → 上传到 ~/.pi/agent/pidance-attachments/（不限项目），二进制消息保存后路径注入 prompt 由 agent read
   */
  const processAttachmentFiles = useCallback(async (files: File[]) => {
    if (isStreaming || files.length === 0) return;
    const imageFiles = files.filter(isRasterImageFile);
    const otherFiles = files.filter((f) => !isRasterImageFile(f));

    if (imageFiles.length) await processImageFiles(imageFiles);

    if (otherFiles.length === 0) return;

    const pending: AttachedUpload[] = otherFiles.map((file) => ({
      id: makeUploadId(),
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      status: "uploading" as const,
    }));
    setAttachedUploads((prev) => [...prev, ...pending]);

    await Promise.all(
      otherFiles.map(async (file, index) => {
        const id = pending[index]!.id;
        try {
          const uploaded = await uploadMessageMedia(file, file.name, file.type);
          const { path, name } = uploaded;
          setAttachedUploads((prev) =>
            prev.map((item) => (item.id === id ? { ...item, path, name, status: "ready" } : item))
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setAttachedUploads((prev) =>
            prev.map((item) => (item.id === id ? { ...item, status: "error", error: message } : item))
          );
        }
      })
    );
  }, [isStreaming, processImageFiles]);

  /**
   * 附件唯一入口：粘贴、文件选择器、拖拽都走这里。
   *
   * 位图走图片管线（原图+预览+模型副本，运行中也允许，配合入队语义）；其余
   * 文件走二进制上传，运行中暂不可附件（和以前一样只给出一条错误提示，不静默
   * 丢掉用户选的文件）。旧实现每条路径各写一份过滤：粘贴与拖拽只认 `image/*`，
   * 于是「粘/拖一个文件」等于没反应。
   */
  const attachFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    const imageFiles = files.filter(isRasterImageFile);
    if (imageFiles.length) void processImageFiles(imageFiles);
    const otherFiles = files.filter((file) => !isRasterImageFile(file));
    if (otherFiles.length === 0) return;
    if (isStreaming) {
      setAttachedUploads((prev) => [...prev, ...otherFiles.map((file) => ({
        id: makeUploadId(),
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        status: "error" as const,
        error: t("input_uploadWhileStreaming"),
      }))]);
      return;
    }
    void processAttachmentFiles(otherFiles);
  }, [isStreaming, processAttachmentFiles, processImageFiles, t]);

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed) {
        revokeImagePreview(removed);
        // 用户主动移除附件 = 不再需要这些字节：删服务端文件（GC 只是兜底）。
        // 发送后的 clearInput 不走这里——刚发出去的图还被消息引用着。
        void deleteAttachmentMedia(imageMediaRefs(removed).flatMap(mediaRefPaths));
      }
      return next;
    });
  }, []);

  const retryAttachment = useCallback((id: string) => {
    const entry = pendingAttachments.find((item) => item.id === id);
    if (entry) void startAttachmentUpload(entry);
  }, [pendingAttachments, startAttachmentUpload]);

  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => {
      const removed = prev.find((item) => item.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((item) => item.id !== id);
    });
    // 阻塞发送的提示说的是「重试或移除」：移除后就不该再挂着它。
    setImageAttachError(null);
  }, []);

  const removeUpload = useCallback((id: string) => {
    const removed = attachedUploadsRef.current.find((item) => item.id === id);
    // 用户主动移除 = 不再需要这些字节：删服务端文件（GC 只是兜底）。
    // 发送后的 clearInput 不走这里——刚发出去的文件还被消息引用着。
    if (removed?.status === "ready" && removed.path) void deleteAttachmentMedia([removed.path]);
    setAttachedUploads((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const clearImages = useCallback(() => {
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return [];
    });
  }, []);

  /** 清空待上传附件（上传还没完成的那些没有引用者，直接回收预览 URL）。 */
  const clearPendingAttachments = useCallback(() => {
    setPendingAttachments((prev) => {
      prev.forEach((item) => URL.revokeObjectURL(item.previewUrl));
      return [];
    });
  }, []);

  const clearUploads = useCallback(() => {
    setAttachedUploads([]);
  }, []);

  const clearInput = useCallback(() => {
    setValue("");
    valueRef.current = "";
    setAtQuery(null);
    if (draftKey) clearDraft(draftKey);
    if (draftKeyRef.current && draftKeyRef.current !== draftKey) clearDraft(draftKeyRef.current);
    setImageAttachError(null);
    clearImages();
    clearUploads();
    clearPendingAttachments();
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [clearImages, clearUploads, clearPendingAttachments, draftKey]);

  /** 把已就绪上传路径拼进消息正文，供 agent 用工具读取。 */
  const composeMessageWithUploads = useCallback((base: string): string => {
    const ready = attachedUploadsRef.current.filter((u) => u.status === "ready" && u.path);
    if (ready.length === 0) return base;
    // 用 path= 让 agent 能读取附件，同时避免 MessageMediaGallery 把同一
    // 个二进制块当成普通正文路径再渲染一遍（BinaryMessageView 负责阈值）。
    const list = ready.map((u) => `- path=${u.path}`).join("\n");
    const block = `${t("input_attachedFilesPrompt")}\n${list}`;
    return base.trim() ? `${base.trim()}\n\n${block}` : block;
  }, [t]);

  /**
   * 带附件发送时捕获的草稿版本（issue #42 / H3）。
   *
   * 成功回执只能结算**这一份**内容：发送在途时用户可能已经切到别的会话、
   * 或在同一会话里继续编辑。旧实现在回执后用 clearInput() 清「当前输入框」，
   * 于是 A 的附件发完会把 B 未发送的正文/图片/文件一起清掉。
   */
  const sentDraftRef = useRef<{
    key: string | null;
    value: string;
    images: AttachedImage[];
    uploads: Array<{ id: string; name: string; mimeType: string; size: number; status: "ready"; path: string }>;
    imageKeys: string[];
    uploadPaths: string[];
  } | null>(null);

  /** 拒绝回执：把捕获的载荷还给原草稿，保留后来编辑；成功路径不得再改编辑器。 */
  const restoreSentDraft = useCallback(() => {
    const sent = sentDraftRef.current;
    sentDraftRef.current = null;
    if (!sent) return;
    if (sent.key && sent.key !== draftKeyRef.current) {
      const existing = getDraft(sent.key) ?? { value: "", images: [] };
      setDraft(sent.key, {
        value: [sent.value, existing.value].filter((part) => part.trim()).join("\n\n"),
        images: [...sent.images.map(imageToDraftImage), ...existing.images],
      });
      return;
    }
    appendAttachedImages(sent.images);
    if (sent.value.trim()) prependDraftText(sent.value);
    if (sent.uploads.length) {
      setAttachedUploads((prev) => {
        const known = new Set(prev.map((item) => item.path).filter(Boolean));
        return [...prev, ...sent.uploads.filter((item) => !known.has(item.path))];
      });
    }
  }, [appendAttachedImages, prependDraftText]);

  useEffect(() => {
    if (!draftKey || draftKeyRef.current !== draftKey) return;
    setDraft(draftKey, {
      value,
      images: attachedImages.map(imageToDraftImage),
    });
  }, [attachedImages, draftKey, value]);

  useEffect(() => {
    const previousDraftKey = draftKeyRef.current;
    if (previousDraftKey === draftKey) return;

    if (previousDraftKey) {
      setDraft(previousDraftKey, {
        value: valueRef.current,
        images: attachedImagesRef.current.map(imageToDraftImage),
      });
    }

    const draft = draftKey ? getDraft(draftKey) : null;
    draftKeyRef.current = draftKey;
    setValue(draft?.value ?? "");
    setAtQuery(null);
    // 切草稿时丢掉未完成的上传：它们属于旧草稿（完成回调会自行作废并回收文件）。
    setPendingAttachments((prev) => {
      prev.forEach((item) => URL.revokeObjectURL(item.previewUrl));
      return [];
    });
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return draft?.images.map(draftImageToAttachedImage) ?? [];
    });
  }, [draftKey]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    if (value) ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

  useEffect(() => {
    return () => {
      attachedImagesRef.current.forEach(revokeImagePreview);
    };
  }, []);

  const hasReadyUploads = attachedUploads.some((u) => u.status === "ready" && u.path);
  const hasUploading = pendingAttachments.some((item) => item.status === "uploading")
    || attachedUploads.some((u) => u.status === "uploading");
  const hasFailedAttachments = pendingAttachments.some((item) => item.status === "failed");
  const hasAttachments = attachedImages.length > 0 || hasReadyUploads;

  const handleSend = useCallback(async () => {
    const base = value.trim();
    if (!base && !attachedImages.length && !hasReadyUploads) return;
    onAudioUnlock?.();
    // 运行中（流式）：纯文本点击发送默认以 follow_up 方式入本地队列（Codex 风格，
    // 引导按钮/空回车合并消费）；有附件或非流式走下方正常发送。
    if (isStreaming && !attachedImages.length && !hasReadyUploads && onPromptWithStreamingBehavior) {
      clearInput();
      onPromptWithStreamingBehavior(base, "followUp", undefined);
      return;
    }
    if (isStreaming) return;
    // 附件还在上传或上传失败：阻塞发送（用户可以重试/移除），不静默丢掉图。
    if (hasUploading || hasFailedAttachments) {
      if (hasFailedAttachments) setImageAttachError(t("input_imageUploadBlocked"));
      return;
    }
    // 先捕获完整载荷再清编辑器：带图发送也立刻移交，气泡出现时输入框必须已空。
    // 失败只由 restoreSentDraft 把这份载荷还给原草稿，成功不再改当前输入。
    const capturedDraftKey = draftKeyRef.current;
    const capturedImages = attachedImages.slice();
    const capturedUploads = attachedUploads.filter(
      (item): item is typeof item & { path: string } => item.status === "ready" && typeof item.path === "string",
    );
    // 内建命令提交期上锁：判断必须在**任何副作用之前**——下面会写 `sentDraftRef` 并清空
    // 输入框；锁检查晚一步的话，重复提交会把上一次的草稿引用改写成已清空的状态，
    // 于是命令失败时 restoreSentDraft 还给用户一个空草稿（正文被静默吃掉）。
    const isBuiltinCommand = !capturedImages.length
      && !capturedUploads.length
      && base.startsWith("/")
      && Boolean(onBuiltinCommand);
    if (isBuiltinCommand && builtinCommandPendingRef.current) return;
    const msg = composeMessageWithUploads(base);
    const binaryBlocks = attachmentBinaryBlocks(
      capturedImages,
      capturedUploads.map((item) => ({ path: item.path, name: item.name, mimeType: item.mimeType, size: item.size })),
    );
    sentDraftRef.current = {
      key: capturedDraftKey ?? null,
      value: valueRef.current,
      images: capturedImages,
      uploads: capturedUploads.map((item) => ({ ...item, status: "ready" as const })),
      imageKeys: capturedImages.map(attachmentIdentity),
      uploadPaths: capturedUploads.map((item) => item.path),
    };
    clearInput();
    if (isBuiltinCommand && onBuiltinCommand) {
      // 命令是异步的（/compact 会真的跑一整轮），同帧双 Enter（或回车+点击）
      // 会让同一条命令跑两遍。锁只挡「提交中」的重复提交，不硬禁输入框：
      // /compact 这类命令可以跑很久，禁了整个编辑器比重复提交更烦人
      // （用户可见的反馈靠 aria-busy）。
      builtinCommandPendingRef.current = true;
      setBuiltinCommandPending(true);
      try {
        const result = await onBuiltinCommand(base);
        if (result.handled) {
          if (result.error) restoreSentDraft();
          else sentDraftRef.current = null;
          return;
        }
      } finally {
        builtinCommandPendingRef.current = false;
        setBuiltinCommandPending(false);
      }
    }
    const submitted = await onSend(
      msg,
      capturedImages.length ? capturedImages : undefined,
      binaryBlocks.length ? binaryBlocks : undefined,
    );
    if (submitted === false) {
      restoreSentDraft();
      return;
    }
    sentDraftRef.current = null;
  }, [value, attachedImages, attachedUploads, hasReadyUploads, hasUploading, hasFailedAttachments, isStreaming, onBuiltinCommand, onPromptWithStreamingBehavior, onSend, clearInput, restoreSentDraft, onAudioUnlock, composeMessageWithUploads, t]);

  const slashQuery = value.startsWith("/") && !/\s/.test(value.slice(1))
    ? value.slice(1).toLowerCase()
    : null;

  const filteredSlashCommands = (() => {
    if (slashQuery === null) return [];
    // 运行中（isStreaming）也展示全部内置命令：选择后以 followUp/steer 发送，
    // 由上层排队到本轮结束再执行（与纯文本 follow-up 一致），避免菜单空面板。
    const commands = [...BUILTIN_SLASH_COMMANDS, ...(slashCommands ?? [])];
    return [...commands]
      .filter((command) => {
        const name = command.name.toLowerCase();
        const description = command.description?.toLowerCase() ?? "";
        return name.includes(slashQuery) || description.includes(slashQuery);
      })
      .sort((a, b) => {
        const rankDelta = slashMatchRank(a, slashQuery) - slashMatchRank(b, slashQuery);
        if (rankDelta !== 0) return rankDelta;
        return SLASH_SOURCE_ORDER[a.source] - SLASH_SOURCE_ORDER[b.source]
          || MODEL_OPTION_COLLATOR.compare(a.name, b.name);
      });
  })();

  /**
   * 斜杠命令的**参数**补全（issue #75）。
   *
   * 触发条件与 pi-tui 一致：**光标所在行**的、光标之前的文本以 `/命令名 ` 开头
   * （命令名之后有空格），且该命令声明了 `hasArgumentCompletions`。
   * prefix 是命令名之后、光标之前的文本（含空串）—— 光标之后的内容不算 prefix，
   * 它在应用候选时原样保留。多行输入里只看光标那一行：补全只改这一行，
   * 不会动用户的换行结构。
   */
  const argQuery = (() => {
    // 与 pi-tui 同口径（autocomplete.js 的 CombinedAutocompleteProvider.getSuggestions）：
    // 只看**光标所在行、光标之前**的文本 —— 命令名在该行行首、之后一个空格、再后面是 prefix（含空串）。
    // 用光标之后的正文当 prefix 会在「回到参数中间改字」时按错误前缀取候选，再只替换到光标处，
    // 结果是拼出一个用户没要的参数。
    const caret = textareaRef.current?.selectionStart ?? value.length;
    const lineStart = value.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
    const lineBeforeCaret = value.slice(lineStart, caret);
    if (!lineBeforeCaret.startsWith("/")) return null;
    const spaceIndex = lineBeforeCaret.indexOf(" ");
    if (spaceIndex === -1) return null;
    const name = lineBeforeCaret.slice(1, spaceIndex);
    if (!name) return null;
    const command = (slashCommands ?? []).find((c) => c.name === name && c.hasArgumentCompletions);
    if (!command) return null;
    return { name, prefix: lineBeforeCaret.slice(spaceIndex + 1) };
  })();

  const argMenuOpen = argQuery !== null;
  // 取出原始值再进 effect：argQuery 每次渲染都是新对象，直接依赖它会让父级任何一次重渲染
  // 都取消防抖、作废序号（等于每帧重发一次请求），而 effect 里引用它又会被 exhaustive-deps 记一条。
  const argCommandName = argQuery?.name ?? null;
  const argPrefix = argQuery?.prefix ?? null;

  // 前缀（含命令名）变化：立刻丢掉上一轮的候选并作废在途请求 —— 否则会短暂显示
  // 与当前输入不相干的旧候选，或者在途响应回来后重新打开菜单。
  const argQueryKey = argCommandName === null || argPrefix === null ? null : `${argCommandName} ${argPrefix}`;
  useEffect(() => {
    argRequestSeqRef.current += 1;
    setArgItems([]);
    setArgActiveIndex(0);
  }, [argQueryKey]);

  useEffect(() => {
    if (argCommandName === null || argPrefix === null || !onLoadCommandArgumentCompletions) {
      setArgItems([]);
      setArgLoading(false);
      return;
    }
    const seq = ++argRequestSeqRef.current;
    setArgLoading(true);
    // 轻量防抖：连续键入只发最后一次（与 @ 菜单同一思路，避免每个字符一次往返）。
    const timer = setTimeout(() => {
      void Promise.resolve(onLoadCommandArgumentCompletions(argCommandName, argPrefix))
        .then((items) => {
          if (argRequestSeqRef.current !== seq) return; // 迟到的响应不得覆盖最新一次
          setArgItems(Array.isArray(items) ? items : []);
          setArgActiveIndex(0);
        })
        .catch(() => {
          if (argRequestSeqRef.current !== seq) return;
          setArgItems([]);
        })
        .finally(() => {
          if (argRequestSeqRef.current === seq) setArgLoading(false);
        });
    }, 120);
    return () => clearTimeout(timer);
  }, [argCommandName, argPrefix, onLoadCommandArgumentCompletions]);

  /**
   * 应用参数候选：替换**参数区间**（命令名之后到光标处），光标后的内容原样保留。
   * 不额外补空格 —— pi-tui 的 applyCompletion 就是这么做的，候选 value 自己带空格
   * （例如 `"token set "`）表示还能继续补下一级。
   */
  const applyArgCompletion = useCallback((item: CommandArgumentCompletion) => {
    if (!argQuery) return;
    // 替换区间按**当前**光标重新推导（候选可能在光标移动之后才被点或按 Tab）：只改光标
    // 所在行，区间是命令名与它后面那个空格之后、到光标处 —— 光标后的正文与其它行原样保留。
    // 若这一行已经不是该命令的参数（光标移到别处、用户改了命令名），直接不动。
    const caret = textareaRef.current?.selectionStart ?? value.length;
    const lineStart = value.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
    const commandPrefix = "/" + argQuery.name + " ";
    if (!value.slice(lineStart, caret).startsWith(commandPrefix)) return;
    const from = lineStart + commandPrefix.length;
    if (from > caret) return;
    const nextValue = value.slice(0, from) + item.value + value.slice(caret);
    const nextCaret = from + item.value.length;
    setValue(nextValue);
    setArgActiveIndex(0);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(nextCaret, nextCaret);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, [argQuery, value]);

  const groupedSlashCommands = (() => {
    const groups = new Map<SlashCommandSource, { source: SlashCommandSource; items: { command: SlashCommandPaletteItem; index: number }[] }>();
    for (const source of SLASH_SOURCES) {
      groups.set(source, { source, items: [] });
    }
    filteredSlashCommands.forEach((command, index) => {
      groups.get(command.source)?.items.push({ command, index });
    });
    return SLASH_SOURCES
      .map((source) => groups.get(source)!)
      .filter((group) => group.items.length > 0);
  })();

  const slashCommandCountLabel = filteredSlashCommands.length === 1
    ? t(slashQuery ? "input_matchCountOne" : "input_commandCountOne")
    : t(slashQuery ? "input_matchCount" : "input_commandCount", { count: filteredSlashCommands.length });
  // 可入队的内容：正文、已附加的图（流式期只允许图）、或已就绪的上传。
  // 旧定义漏了 attachedImages：纯图消息（不写正文）时发送按钮直接禁用，
  // 用户点了没反应，也无任何提示。
  const hasInputText = Boolean(value.trim()) || attachedImages.length > 0 || hasReadyUploads;
  const canQueueStreamingMessage = hasInputText && !hasUploading && !hasFailedAttachments;

  // ── @ file autocomplete ──────────────────────────────────────────────────
  // Recomputed from the text before the caret on every change/caret move.
  // Disabled entirely when there is no cwd (new session without a directory).
  const updateAtQuery = useCallback((text: string, cursor: number | null) => {
    if (!cwd) {
      setAtQuery(null);
      return;
    }
    const pos = cursor ?? text.length;
    setAtQuery(extractAtQuery(text.slice(0, pos)));
  }, [cwd]);

  const atQueryText = atQuery?.query ?? null;
  const atLocalMatches: FileIndexEntry[] = React.useMemo(() => (
    atQueryText !== null && fileIndex && fileIndex.cwd === cwd
      ? filterFileEntries(fileIndex.entries, atQueryText)
      : []
  ), [atQueryText, fileIndex, cwd]);

  // When the client index is truncated (repo larger than the index cap),
  // local filtering cannot see deep files, so queries are also ranked
  // server-side against the full listing. Local matches render immediately
  // and are replaced when the (debounced) server result for the current
  // query arrives; stale responses are ignored via the query/cwd tag.
  const needsServerSearch = Boolean(atQueryText && fileIndex?.truncated && fileIndex.cwd === cwd);
  useEffect(() => {
    if (!needsServerSearch || !cwd || !atQueryText) return;
    const fetchCwd = cwd;
    const query = atQueryText;
    const timer = setTimeout(() => {
      fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}&q=${encodeURIComponent(query)}`)
        .then((res) => {
          if (!res.ok) throw new Error(`file search failed: ${res.status}`);
          return res.json() as Promise<{ matches?: FileIndexEntry[] }>;
        })
        .then((data) => setAtServerResult({ cwd: fetchCwd, query, matches: data.matches ?? [] }))
        .catch(() => {
          // Keep showing local matches; the next keystroke retries.
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [needsServerSearch, atQueryText, cwd]);

  const serverResultInUse = needsServerSearch
    && atServerResult !== null
    && atServerResult.cwd === cwd
    && atServerResult.query === atQueryText;
  const atMatches: FileIndexEntry[] = serverResultInUse ? atServerResult.matches : atLocalMatches;

  // Open/reset the menu whenever the @token appears or changes (mirrors the
  // slash menu: Escape closes it, the next keystroke re-opens it).
  const atTokenKey = atQuery === null ? null : `${atQuery.start}:${atQuery.quoted ? 1 : 0}:${atQuery.query}`;
  useEffect(() => {
    if (atTokenKey === null) {
      setAtMenuOpen(false);
      setAtActiveIndex(0);
      return;
    }
    setAtMenuOpen(true);
    setAtActiveIndex(0);
  }, [atTokenKey]);

  // Fetch the file index when the menu opens. The server caches per cwd for
  // ~10s, so re-opening refreshes cheaply; while typing nothing refetches.
  const atTokenActive = atQuery !== null;
  useEffect(() => {
    if (!atTokenActive || !cwd) return;
    const meta = fileIndexMetaRef.current;
    if (meta && meta.cwd === cwd && Date.now() - meta.fetchedAt < 10_000) return;
    if (fileIndexFetchingRef.current === cwd) return;
    fileIndexFetchingRef.current = cwd;
    const fetchCwd = cwd;
    setFileIndexLoading(true);
    fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`file index failed: ${res.status}`);
        return res.json() as Promise<{ files?: string[]; truncated?: boolean }>;
      })
      .then((data) => {
        setFileIndex({ cwd: fetchCwd, entries: buildEntriesFromFiles(data.files ?? []), truncated: !!data.truncated });
        fileIndexMetaRef.current = { cwd: fetchCwd, fetchedAt: Date.now() };
      })
      .catch(() => {
        // Leave any previous index in place; next open retries.
        fileIndexMetaRef.current = null;
      })
      .finally(() => {
        fileIndexFetchingRef.current = null;
        setFileIndexLoading(false);
      });
  }, [atTokenActive, cwd]);

  const applyAtCompletion = useCallback((entry: FileIndexEntry) => {
    if (!atQuery) return;
    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? value.length;
    const before = value.slice(0, atQuery.start);
    let after = value.slice(cursor);
    // Completing inside a quoted token (@"my dir/… with the caret before the
    // closing quote): the replacement carries its own closing quote, so drop
    // the old one right after the caret (mirrors the TUI's applyCompletion).
    if (atQuery.quoted && after.startsWith('"')) {
      after = after.slice(1);
    }
    const insert = buildAtInsertText(entry.path, entry.isDir, atQuery.quoted);
    const newValue = before + insert.text + after;
    const newPos = before.length + insert.cursorOffset;
    setValue(newValue);
    // setValue alone does not fire onChange — re-derive the token here. Files
    // end with a space (token closes, menu hides); directories end with "/"
    // before the caret (token stays open for drill-down into the directory).
    setAtQuery(extractAtQuery(newValue.slice(0, newPos)));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(newPos, newPos);
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    });
  }, [atQuery, value]);

  useEffect(() => {
    if (atActiveIndex >= atMatches.length) {
      setAtActiveIndex(Math.max(0, atMatches.length - 1));
    }
  }, [atMatches.length, atActiveIndex]);

  useEffect(() => {
    atItemRefs.current.length = atMatches.length;
  }, [atMatches.length]);

  useEffect(() => {
    if (!atMenuOpen) return;
    atItemRefs.current[atActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [atActiveIndex, atMenuOpen]);

  const applySlashCommand = useCallback((command: SlashCommandPaletteItem) => {
    const nextValue = `/${command.name} `;
    setValue(nextValue);
    setSlashMenuOpen(false);
    setSlashActiveIndex(0);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(nextValue.length, nextValue.length);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, []);

  const sendQueued = useCallback((mode: "steer" | "followup") => {
    const base = value.trim();
    if (!base && !hasReadyUploads && attachedImages.length === 0) return;
    if (hasUploading) return;
    // 附件没传完/传失败时不入队：只把正文排进去 = 静默丢图（用户已明确拒绝这种降级）。
    if (hasFailedAttachments) {
      setImageAttachError(t("input_imageUploadBlocked"));
      return;
    }
    onAudioUnlock?.();
    const msg = composeMessageWithUploads(base);
    const images = attachedImages.length ? attachedImages : undefined;
    const streamingBehavior = mode === "steer" ? "steer" : "followUp";
    if (msg.startsWith("/") && onPromptWithStreamingBehavior) {
      onPromptWithStreamingBehavior(msg, streamingBehavior, images);
      clearInput();
      return;
    }
    // 严格按 intent 投递：steer 只用 onSteer，followup 只用 onFollowUp。
    // 不做隐式降级（缺回调时改走另一条会静默改变发送语义：引导变排队、或排队
    // 变打断当前运行）；缺回调时**不清输入框**，旧实现无论有没有者消费都
    // clearInput()，在繁忙态缺回调时等于静默丢消息。
    const deliver = mode === "steer" ? onSteer : onFollowUp;
    if (!deliver) return;
    deliver(msg, images);
    clearInput();
  }, [value, attachedImages.length, hasReadyUploads, hasUploading, hasFailedAttachments, onPromptWithStreamingBehavior, onSteer, onFollowUp, clearInput, onAudioUnlock, composeMessageWithUploads, t]);

  /** 引导发送队列：若输入框有内容则并入队尾后整队以 steer 发送。 */
  const flushQueueAsSteer = useCallback(() => {
    if (!onSendQueueAsSteer) return;
    // 图片附件流式期不可入队；仅文本/路径附件可并入。
    if (attachedImages.length || hasUploading) {
      onSendQueueAsSteer();
      return;
    }
    const base = value.trim();
    const hasInput = Boolean(base) || hasReadyUploads;
    const extra = hasInput ? composeMessageWithUploads(base).trim() : "";
    onAudioUnlock?.();
    onSendQueueAsSteer(extra || undefined);
    if (extra) clearInput();
  }, [
    onSendQueueAsSteer,
    attachedImages.length,
    hasUploading,
    value,
    hasReadyUploads,
    composeMessageWithUploads,
    onAudioUnlock,
    clearInput,
  ]);

  const getNextSlashIndex = useCallback((direction: "up" | "down" | "left" | "right") => {
    const lastIndex = filteredSlashCommands.length - 1;
    if (lastIndex < 0) return 0;

    if (direction === "left") return Math.max(0, slashActiveIndex - 1);
    if (direction === "right") return Math.min(lastIndex, slashActiveIndex + 1);

    const currentNode = slashItemRefs.current[slashActiveIndex];
    if (!currentNode) {
      return direction === "down"
        ? Math.min(lastIndex, slashActiveIndex + 1)
        : Math.max(0, slashActiveIndex - 1);
    }

    const currentRect = currentNode.getBoundingClientRect();
    const currentX = currentRect.left + currentRect.width / 2;
    const currentY = currentRect.top + currentRect.height / 2;
    let bestIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let index = 0; index <= lastIndex; index += 1) {
      if (index === slashActiveIndex) continue;
      const node = slashItemRefs.current[index];
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      const candidateY = rect.top + rect.height / 2;
      const verticalDelta = candidateY - currentY;
      if (direction === "down" ? verticalDelta <= 4 : verticalDelta >= -4) continue;

      const candidateX = rect.left + rect.width / 2;
      const score = Math.abs(verticalDelta) * 1000 + Math.abs(candidateX - currentX);
      if (score < bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }

    if (bestIndex >= 0) return bestIndex;
    return direction === "down"
      ? Math.min(lastIndex, slashActiveIndex + 1)
      : Math.max(0, slashActiveIndex - 1);
  }, [filteredSlashCommands.length, slashActiveIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent;
      const recentlyComposed = Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS;
      const isComposing =
        isComposingRef.current ||
        nativeEvent.isComposing ||
        nativeEvent.keyCode === 229;

      if (e.key === "Enter" && !e.shiftKey && (isComposing || recentlyComposed)) {
        if (recentlyComposed) e.preventDefault();
        return;
      }

      if (argMenuOpen && argItems.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setArgActiveIndex((i) => Math.min(argItems.length - 1, i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setArgActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          // 作废在途请求：否则响应回来会把菜单又打开（用户已经关掉了它）。
          argRequestSeqRef.current += 1;
          setArgItems([]);
          setArgLoading(false);
          return;
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && argItems[argActiveIndex]) {
          e.preventDefault();
          applyArgCompletion(argItems[argActiveIndex]);
          return;
        }
      }

      if (slashMenuOpen && slashQuery !== null) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("down"));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("up"));
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("right"));
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("left"));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && filteredSlashCommands[slashActiveIndex]) {
          e.preventDefault();
          applySlashCommand(filteredSlashCommands[slashActiveIndex]);
          return;
        }
      }

      // @ file menu — skip while composing so IME candidate navigation
      // (arrows/Enter/Tab) is never intercepted.
      if (atMenuOpen && atQuery !== null && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setAtActiveIndex((i) => Math.min(Math.max(0, atMatches.length - 1), i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAtActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setAtMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && atMatches[atActiveIndex]) {
          e.preventDefault();
          applyAtCompletion(atMatches[atActiveIndex]);
          return;
        }
      }

      // Esc stops the agent when no slash/@ menu or IME composition is active.
      if (e.key === "Escape" && !isComposing && isStreaming && onAbort) {
        e.preventDefault();
        onAbort();
        return;
      }

      // 手机端：Enter 仅换行，通过发送按钮提交。
      // 桌面：Enter = 配置的默认动作；Ctrl/Cmd+Enter = 相反动作（流式期）。
      // 队列有内容时：Ctrl/Cmd+Enter 优先引导发送整队（输入框有内容则先并入队尾）。
      // 非流式：Enter / Ctrl+Enter 均发送。
      if (e.key === "Enter" && !e.shiftKey) {
        if (isMobile) return;
        e.preventDefault();
        const modifier = e.ctrlKey || e.metaKey;
        const queueCount = queuedMessages?.followUp.length ?? 0;
        // 无内容 + follow-up 队列非空：Enter 即整队合并引导发送（Codex 风格）
        const followUpCount = queuedMessages?.followUp.length ?? 0;
        const hasInputText = Boolean(value.trim()) || hasReadyUploads;
        if (!modifier && !hasInputText && followUpCount > 0 && onSendQueueAsSteer) {
          flushQueueAsSteer();
          return;
        }
        if (modifier && queueCount > 0 && onSendQueueAsSteer) {
          flushQueueAsSteer();
          return;
        }
        if (isStreaming && (onSteer || onFollowUp)) {
          const defaultIsQueue = streamingEnterDefault !== "steer";
          // 默认队列：Enter=followup，Ctrl+Enter=steer；默认引导则相反。
          const mode: "steer" | "followup" = modifier
            ? (defaultIsQueue ? "steer" : "followup")
            : (defaultIsQueue ? "followup" : "steer");
          sendQueued(mode);
        } else {
          void handleSend();
        }
      }
    },
    // argMenuOpen / argItems / argActiveIndex / applyArgCompletion 必须在这里：少了它们，
    // 闭包停留在「候选还没到」的那一帧，Tab/Enter 拦不住 —— Enter 会把没补全的正文直接发出去。
    [isStreaming, isMobile, streamingEnterDefault, onSteer, onFollowUp, onAbort, slashMenuOpen, slashQuery, filteredSlashCommands, slashActiveIndex, applySlashCommand, argMenuOpen, argItems, argActiveIndex, applyArgCompletion, sendQueued, handleSend, getNextSlashIndex, atMenuOpen, atQuery, atMatches, atActiveIndex, applyAtCompletion, queuedMessages, onSendQueueAsSteer, flushQueueAsSteer]
  );

  const handleInput = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    // 剪贴板里可能是位图（截图/复制的图），也可能是普通文件（从文件管理器复制
    // 过来的文件带各自 MIME）。旧实现只取 `image/*` 的 item，粘文件等于没反应。
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    e.preventDefault();
    attachFiles(files);
  }, [attachFiles]);

  useEffect(() => {
    if (slashQuery === null) {
      setSlashMenuOpen(false);
      setSlashActiveIndex(0);
      slashCommandsRequestedRef.current = false;
      return;
    }
    setSlashMenuOpen(true);
    setSlashActiveIndex(0);
    if (!slashCommandsRequestedRef.current && onLoadSlashCommands) {
      slashCommandsRequestedRef.current = true;
      Promise.resolve(onLoadSlashCommands()).catch(() => {
        slashCommandsRequestedRef.current = false;
      });
    }
  }, [slashQuery, onLoadSlashCommands]);

  useEffect(() => {
    if (slashActiveIndex >= filteredSlashCommands.length) {
      setSlashActiveIndex(Math.max(0, filteredSlashCommands.length - 1));
    }
  }, [filteredSlashCommands.length, slashActiveIndex]);

  useEffect(() => {
    slashItemRefs.current.length = filteredSlashCommands.length;
  }, [filteredSlashCommands.length]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    slashItemRefs.current[slashActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [slashActiveIndex, slashMenuOpen]);

  useEffect(() => {
    argItemRefs.current.length = argItems.length;
  }, [argItems.length]);

  useEffect(() => {
    if (!argMenuOpen) return;
    argItemRefs.current[argActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [argActiveIndex, argMenuOpen]);

  // 第一阶段：共享运行时目录（modelList/modelNames）和 serverPrefs 中的每模型
  // 思考缓存先到位。第二阶段：把当前会话选择叠加到列表；当前模型即使因
  // enabledModels/凭据过滤暂时不在共享目录，也必须保留为可见的 active 行。
  const modelOptions: ModelOption[] = useMemo(() => {
    const options = modelList && modelList.length > 0
      ? modelList.map((m) => ({
          provider: m.provider,
          modelId: m.id,
          name: m.name,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
        }))
      : Object.entries(modelNames ?? {}).map(([key, name]) => {
          const separator = key.indexOf(":");
          return separator > 0
            ? { provider: key.slice(0, separator), modelId: key.slice(separator + 1), name }
            : { provider: model?.provider ?? "unknown", modelId: key, name };
        });
    if (model && !options.some((option) => option.provider === model.provider && option.modelId === model.modelId)) {
      options.push({ provider: model.provider, modelId: model.modelId, name: model.modelId });
    }
    return options.sort(compareModelOptions);
  }, [modelList, modelNames, model]);

  // Group options by provider, preserving insertion order
  const modelsByProvider: { provider: string; options: ModelOption[] }[] = [];
  for (const opt of modelOptions) {
    const group = modelsByProvider.find((g) => g.provider === opt.provider);
    if (group) group.options.push(opt);
    else modelsByProvider.push({ provider: opt.provider, options: [opt] });
  }

  const displayModelName = model
    ? (modelOptions.find((o) => o.modelId === model.modelId && o.provider === model.provider)?.name ?? model.modelId)
    : null;
  const currentName = displayModelName;

  const compactSavedTokens = compactResult
    ? Math.max(0, compactResult.tokensBefore - compactResult.estimatedTokensAfter)
    : 0;
  const compactReasonKey = compactResult?.reason === "auto"
    ? "input_compactionReason_auto" as const
    : compactResult?.reason === "threshold"
      ? "input_compactionReason_threshold" as const
      : compactResult?.reason === "overflow"
        ? "input_compactionReason_overflow" as const
        : null;
  const compactResultText = compactResult
    ? compactReasonKey
      ? t("input_compactionResultWithReason", {
        before: formatTokenCount(compactResult.tokensBefore),
        after: formatTokenCount(compactResult.estimatedTokensAfter),
        saved: formatTokenCount(compactSavedTokens),
        reason: t(compactReasonKey),
      })
      : t("input_compactionResult", {
        before: formatTokenCount(compactResult.tokensBefore),
        after: formatTokenCount(compactResult.estimatedTokensAfter),
        saved: formatTokenCount(compactSavedTokens),
      })
    : null;

  // ── 视口安全浮层定位 ─────────────────────────────────────────────────────
  // 所有菜单共享 useAnchoredOverlay：visualViewport 感知、上下翻转、边界
  // clamp、maxWidth/maxHeight 写回 style，内容在面板内部滚动。
  const slashListboxId = useId();
  const atListboxId = useId();
  const modelMenuId = useId();
  const slashOverlay = useAnchoredOverlay({
    open: slashMenuOpen && slashQuery !== null,
    anchorRef: inputContainerRef,
    overlayRef: slashOverlayRef,
    preferredPlacement: "above",
    gap: 8,
    margin: 8,
    maxHeight: 460,
    width: "anchor",
  });
  const argOverlay = useAnchoredOverlay({
    open: argMenuOpen && (argItems.length > 0 || argLoading),
    anchorRef: inputContainerRef,
    overlayRef: argOverlayRef,
    preferredPlacement: "above",
    gap: 8,
    margin: 8,
    maxHeight: 260,
    width: "anchor",
  });
  const atOverlay = useAnchoredOverlay({
    open: atMenuOpen && atQuery !== null,
    anchorRef: inputContainerRef,
    overlayRef: atOverlayRef,
    preferredPlacement: "above",
    gap: 8,
    margin: 8,
    maxHeight: 400,
    width: "anchor",
  });
  const modelOverlay = useAnchoredOverlay({
    open: modelDropdownOpen,
    anchorRef: modelButtonRef,
    overlayRef: modelDropdownPanelRef,
    preferredPlacement: "above",
    gap: 6,
    margin: 8,
    minWidth: "anchor",
    width: isMobile ? "max" : undefined,
  });

  const slashMenuVisible = slashMenuOpen && slashQuery !== null;
  const atMenuVisible = atMenuOpen && atQuery !== null;
  const inputActiveDescendant = slashMenuVisible && filteredSlashCommands.length > 0
    ? `${slashListboxId}-opt-${slashActiveIndex}`
    : atMenuVisible && atMatches.length > 0
      ? `${atListboxId}-opt-${atActiveIndex}`
      : undefined;
  const inputControlsId = slashMenuVisible ? slashListboxId : atMenuVisible ? atListboxId : undefined;

  // Esc 分层关闭浮层：思考 → 工具 → 模型，逐层且焦点回 trigger。
  useEffect(() => {
    const anyOpen = toolDropdownOpen || modelDropdownOpen;
    if (!anyOpen) return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      if (toolDropdownOpen) {
        setToolDropdownOpen(false);
        focusTriggerButton(toolDropdownRef.current);
      } else if (modelDropdownOpen) {
        setModelDropdownOpen(false);
        modelButtonRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [toolDropdownOpen, modelDropdownOpen]);

  // 菜单打开时把焦点送进面板（选中项优先，无则首项），Esc/选择后焦点回 trigger。
  useEffect(() => {
    if (toolDropdownOpen) focusPanelOption(toolDropdownPanelRef.current, '[role="menuitemradio"]');
  }, [toolDropdownOpen]);
  useEffect(() => {
    if (modelDropdownOpen) focusPanelOption(modelDropdownPanelRef.current, '[role="option"]');
  }, [modelDropdownOpen]);

  // Close dropdowns on outside click（深度菜单 portal 也算「内部」，不关模型列表）
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const inDepth = depthMenuRef.current?.contains(target);
      if (
        dropdownRef.current && !dropdownRef.current.contains(target) &&
        modelDropdownPanelRef.current && !modelDropdownPanelRef.current.contains(target) &&
        !inDepth
      ) {
        setModelDropdownOpen(false);
        closeDepthMenu();
      }
      if (
        toolDropdownRef.current && !toolDropdownRef.current.contains(target) &&
        toolDropdownPanelRef.current && !toolDropdownPanelRef.current.contains(target)
      ) {
        setToolDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [closeDepthMenu]);



  return (
    <div
      style={{
        flexShrink: 0,
        background: "transparent",
        // 左右各让出一个竖条宽度：与消息列（两侧 18px 竖条）逐像素对齐
        padding: `0 ${isMobile ? 16 : CHAT_GUTTER}px 8px`,
      }}
    >
      {/* Hidden file input：图片走模型副本；所有原文件作为二进制消息保存。
          不设 `accept`：手机端一旦写死类型，选择器就只剩相册/相机，文档与
          其他文件根本选不到。运行中也保持可用（图片可入队）。 */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        disabled={blocked}
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          attachFiles(files);
          e.target.value = "";
        }}
      />
      <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH_CSS, margin: "0 auto" }}>
        <fieldset
          disabled={blocked}
          aria-disabled={blocked || undefined}
          aria-busy={builtinCommandPending || undefined}
          style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
        >
        {/* Queued follow-up messages（steering 即时投递，不在队列块显示） */}
        {queuedRows.length > 0 && (
          <div style={{
            marginBottom: 8,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-panel)",
            padding: "5px 0",
          }}>
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "2px 8px 4px 10px",
            }}>
              <span style={{
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                color: "var(--text-dim)",
                textTransform: "uppercase",
                letterSpacing: 0.4,
              }}>
                {t("input_queued", { count: queuedRows.length })}
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                <button
                  type="button"
                  onClick={() => setQueueExpanded((expanded) => !expanded)}
                  aria-expanded={queueExpanded}
                  aria-label={queueExpanded ? t("input_collapseQueue") : t("input_expandQueue")}
                  title={queueExpanded ? t("input_collapseQueue") : t("input_expandQueue")}
                  className="instant-tooltip tooltip-up"
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 26, height: 26, padding: 0,
                    border: "1px solid var(--border)", borderRadius: 6,
                    background: "transparent", color: "var(--text-dim)", cursor: "pointer",
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: queueExpanded ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.12s" }}>
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {onSendQueueAsSteer && (
                  <button
                    type="button"
                    onClick={flushQueueAsSteer}
                    data-tooltip={t("input_sendQueueAsSteerTooltip")}
                    className="instant-tooltip tooltip-up"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 12px",
                      fontSize: 12,
                      color: "var(--accent)",
                      background: "transparent",
                      border: "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))",
                      borderRadius: 7,
                      cursor: "pointer",
                      transition: "background 0.12s, border-color 0.12s",
                      whiteSpace: "nowrap",
                      fontWeight: 600,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 10%, transparent)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <line x1="22" y1="2" x2="11" y2="13" />
                      <polygon points="22 2 15 22 11 13 2 9 22 2" />
                    </svg>
                    {t("input_sendQueueAsSteer")}
                  </button>
                )}
                {onRecallQueue && (
                  <button
                    type="button"
                    onClick={onRecallQueue}
                    data-tooltip={t("input_recall")}
                    className="instant-tooltip tooltip-up"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 12px",
                      fontSize: 12,
                      color: "var(--text)",
                      background: "transparent",
                      border: "1px solid var(--border)",
                      borderRadius: 7,
                      cursor: "pointer",
                      transition: "background 0.12s, border-color 0.12s",
                      whiteSpace: "nowrap",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "var(--bg-hover)";
                      e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 45%, var(--border))";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                      e.currentTarget.style.borderColor = "var(--border)";
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="9 14 4 9 9 4" />
                      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
                    </svg>
                    {t("input_recall")}
                  </button>
                )}
              </div>
            </div>
            {queueExpanded && queuedRows.map((row) => (
              <QueuedMessageRow
                key={row.id}
                kind="follow-up"
                text={row.text}
                state={row.state}
                stateLabel={queueStateLabel(row.state)}
                imageCount={row.imageCount}
              />
            ))}
          </div>
        )}
        {/* Retry banner */}
        {retryInfo && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "color-mix(in srgb, var(--status-warning) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--status-warning) 28%, transparent)",
            borderRadius: 6, fontSize: 12, color: "var(--status-warning)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            {t("input_retrying")} ({retryInfo.attempt}/{retryInfo.maxAttempts}){retryInfo.errorMessage && <span style={{ opacity: 0.7, marginLeft: 4 }}>— {retryInfo.errorMessage}</span>}
          </div>
        )}
        {compactError && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "color-mix(in srgb, var(--status-danger) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--status-danger) 28%, transparent)",
            borderRadius: 6, fontSize: 12, color: "var(--status-danger)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            {compactError}
          </div>
        )}
        {compactResultText && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "color-mix(in srgb, var(--status-success) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--status-success) 28%, transparent)",
            borderRadius: 6, fontSize: 12, color: "var(--status-success)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {compactResultText}
          </div>
        )}
        {/* 图片缩略图 + 已上传文件芯片 */}
        {(attachedImages.length > 0 || pendingAttachments.length > 0 || attachedUploads.length > 0 || imageAttachError) && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap", alignItems: "center" }}>
            {imageAttachError && (
              <div role="alert" style={{ flexBasis: "100%", color: "var(--status-danger)", fontSize: 11 }}>
                {imageAttachError}
              </div>
            )}
            {pendingAttachments.map((item) => (
              <div key={item.id} style={{ position: "relative", flexShrink: 0 }} title={item.error}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={item.previewUrl}
                  alt=""
                  style={{
                    width: 56, height: 56, objectFit: "cover", borderRadius: 6,
                    border: `1px solid ${item.status === "failed" ? "var(--status-danger)" : "var(--border)"}`,
                    display: "block", opacity: item.status === "uploading" ? 0.45 : 1,
                  }}
                />
                {item.status === "failed" ? (
                  <button
                    type="button"
                    onClick={() => retryAttachment(item.id)}
                    style={{
                      position: "absolute", inset: 0, borderRadius: 6, border: "none",
                      background: "color-mix(in srgb, var(--bg-panel) 82%, transparent)",
                      color: "var(--status-danger)", fontSize: 11, cursor: "pointer", padding: 0,
                    }}
                  >
                    {t("input_imageRetry")}
                  </button>
                ) : (
                  <div
                    aria-hidden="true"
                    style={{
                      position: "absolute", inset: 0, borderRadius: 6,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      background: "color-mix(in srgb, var(--bg-panel) 70%, transparent)",
                      color: "var(--text-muted)", fontSize: 10,
                    }}
                  >
                    {t("input_imageUploading")}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removePendingAttachment(item.id)}
                  aria-label={t("input_removeAttachment")}
                  style={{
                    position: "absolute", top: -4, right: -4,
                    width: 16, height: 16, borderRadius: "50%",
                    background: "var(--bg-panel)", border: "1px solid var(--border)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer", padding: 0, color: "var(--text-muted)",
                  }}
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
                  </svg>
                </button>
              </div>
            ))}
            {attachedImages.map((img, i) => (
              <div key={`img-${i}`} style={{ position: "relative", flexShrink: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.previewUrl}
                  alt=""
                  style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
                />
                <button
                  type="button"
                  onClick={() => removeImage(i)}
                  aria-label={t("input_removeAttachment")}
                  style={{
                    position: "absolute", top: -4, right: -4,
                    width: 16, height: 16, borderRadius: "50%",
                    background: "var(--bg-panel)", border: "1px solid var(--border)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer", padding: 0, color: "var(--text-muted)",
                  }}
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
                  </svg>
                </button>
              </div>
            ))}
            {attachedUploads.map((item) => {
              const kind = isVideoPath(item.name) ? "video" : isAudioPath(item.name) ? "audio" : isImagePath(item.name) ? "image" : "file";
              const statusColor =
                item.status === "error" ? "var(--status-danger)"
                  : item.status === "uploading" ? "var(--text-dim)"
                    : "var(--text-muted)";
              return (
                <div
                  key={item.id}
                  title={item.error || item.path || item.name}
                  style={{
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    maxWidth: 220,
                    padding: "6px 10px",
                    borderRadius: 8,
                    border: `1px solid ${item.status === "error" ? "color-mix(in srgb, var(--status-danger) 40%, var(--border))" : "var(--border)"}`,
                    background: "var(--bg-panel)",
                    fontSize: 12,
                    color: statusColor,
                  }}
                >
                  <span style={{ flexShrink: 0, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--text-dim)" }}>
                    {kind}
                  </span>
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.status === "uploading" ? t("input_uploadingAttachment") : item.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeUpload(item.id)}
                    aria-label={t("input_removeAttachment")}
                    style={{
                      flexShrink: 0,
                      width: 16, height: 16, borderRadius: "50%",
                      background: "var(--bg)", border: "1px solid var(--border)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      cursor: "pointer", padding: 0, color: "var(--text-muted)",
                    }}
                  >
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Main input */}
        <div ref={inputContainerRef} style={{ position: "relative" }}>
          {slashMenuVisible && (
            <div
              ref={slashOverlayRef}
              style={{
                ...slashOverlay.style,
                zIndex: 120,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: slashOverlay.placement === "above" ? "0 -6px 20px rgba(0,0,0,0.12)" : "0 6px 20px rgba(0,0,0,0.12)",
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div
                style={{
                  padding: "8px 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  fontSize: 11,
                  color: "var(--text-dim)",
                  flexShrink: 0,
                }}
              >
                <span>{slashCommandsLoading ? t("input_loadingCommands") : `${t("input_slashCommands")} · ${slashCommandCountLabel}`}</span>
                <span style={{ fontFamily: "var(--font-mono)" }}>{t("input_tabEnter")}</span>
              </div>
              <div id={slashListboxId} role="listbox" aria-label={t("input_slashCommands")} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 10 }}>
                {!slashCommandsLoading && filteredSlashCommands.length === 0 ? (
                  <div style={{ padding: "2px 2px 4px", fontSize: 12, color: "var(--text-dim)" }}>
                    {t("input_noCommands")}
                  </div>
                ) : (
                  groupedSlashCommands.map((group) => (
                    <section key={group.source} style={{ marginBottom: 12 }}>
                      <div
                        style={{
                          position: "sticky",
                          top: -10,
                          zIndex: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          padding: "4px 0 6px",
                          background: "var(--bg)",
                          color: "var(--text-dim)",
                          fontSize: 10,
                          fontWeight: 600,
                          textTransform: "uppercase",
                        }}
                      >
                        <span>{t(SLASH_SOURCE_GROUP_LABEL[group.source])}</span>
                        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500 }}>{group.items.length}</span>
                      </div>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                          gap: 8,
                        }}
                      >
                        {group.items.map(({ command, index }) => {
                          const active = index === slashActiveIndex;
                          return (
                            <button
                              key={`${command.source}:${command.name}`}
                              id={`${slashListboxId}-opt-${index}`}
                              role="option"
                              aria-selected={active}
                              ref={(node) => {
                                slashItemRefs.current[index] = node;
                              }}
                              type="button"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                applySlashCommand(command);
                              }}
                              onMouseEnter={() => setSlashActiveIndex(index)}
                              style={{
                                width: "100%",
                                minWidth: 0,
                                minHeight: 58,
                                display: "flex",
                                flexDirection: "column",
                                gap: 4,
                                justifyContent: "center",
                                padding: "9px 10px",
                                border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                                borderRadius: 7,
                                background: active ? "var(--bg-selected)" : "var(--bg-panel)",
                                color: "var(--text)",
                                cursor: "pointer",
                                textAlign: "left",
                                boxShadow: active ? "0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent)" : "none",
                              }}
                            >
                              <span style={{
                                fontSize: 13,
                                fontFamily: "var(--font-mono)",
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                              }}>
                                /{command.name}
                              </span>
                              {command.description && (
                                <span style={{
                                  display: "-webkit-box",
                                  WebkitBoxOrient: "vertical",
                                  WebkitLineClamp: 2,
                                  overflow: "hidden",
                                  fontSize: 11,
                                  lineHeight: 1.35,
                                  color: "var(--text-dim)",
                                }}>
                                  {command.description}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))
                )}
              </div>
            </div>
          )}
          {argMenuOpen && (argItems.length > 0 || argLoading) && (
            <div
              ref={argOverlayRef}
              style={{
                ...argOverlay.style,
                zIndex: 118,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: argOverlay.placement === "above" ? "0 -6px 20px rgba(0,0,0,0.12)" : "0 6px 20px rgba(0,0,0,0.12)",
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div
                style={{
                  padding: "8px 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  fontSize: 11,
                  color: "var(--text-dim)",
                  flexShrink: 0,
                }}
              >
                <span>{argLoading && argItems.length === 0 ? t("input_commandArgsLoading") : t("input_commandArgs", { name: argQuery?.name ?? "" })}</span>
                <span style={{ fontFamily: "var(--font-mono)" }}>{t("input_tabEnter")}</span>
              </div>
              <div role="listbox" aria-label={t("input_commandArgs", { name: argQuery?.name ?? "" })} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 4 }}>
                {argItems.map((item, index) => {
                  const active = index === argActiveIndex;
                  return (
                    <button
                      key={`${item.value}:${index}`}
                      ref={(node) => { argItemRefs.current[index] = node; }}
                      role="option"
                      aria-selected={active}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyArgCompletion(item);
                      }}
                      onMouseEnter={() => setArgActiveIndex(index)}
                      style={{
                        width: "100%",
                        minWidth: 0,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "7px 9px",
                        // 触摸端够大：与 @ 菜单同一口径
                        minHeight: isMobile ? 44 : 32,
                        border: `1px solid ${active ? "var(--accent)" : "transparent"}`,
                        borderRadius: 6,
                        background: active ? "var(--bg-selected)" : "transparent",
                        color: "var(--text)",
                        fontSize: 12,
                        fontFamily: "var(--font-mono)",
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.label}</span>
                      {item.description && (
                        <span style={{ marginLeft: "auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 11 }}>{item.description}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {atMenuVisible && (() => {
            const indexLoading = fileIndexLoading && (!fileIndex || fileIndex.cwd !== cwd);
            const matchCountLabel = atMatches.length === 1
              ? t("input_matchCountOne")
              : t("input_matchCount", { count: atMatches.length });
            // With a truncated index, local results are provisional — the
            // debounced server search over the full listing replaces them.
            const truncatedHint = fileIndex?.truncated && !serverResultInUse
              ? (atQuery!.query ? ` · ${t("input_searchingAllFiles")}` : ` · ${t("input_indexTruncated")}`)
              : "";
            return (
              <div
                ref={atOverlayRef}
                style={{
                  ...atOverlay.style,
                  zIndex: 120,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  boxShadow: atOverlay.placement === "above" ? "0 -6px 20px rgba(0,0,0,0.12)" : "0 6px 20px rgba(0,0,0,0.12)",
                  overflow: "hidden",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <div
                  style={{
                    padding: "8px 10px",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    fontSize: 11,
                    color: "var(--text-dim)",
                    flexShrink: 0,
                  }}
                >
                  <span>
                    {indexLoading
                      ? t("input_loadingFiles")
                      : `${t("input_files")} · ${matchCountLabel}${truncatedHint}`}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)" }}>{t("input_tabEnter")}</span>
                </div>
                <div id={atListboxId} role="listbox" aria-label={t("input_files")} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 4 }}>
                  {!indexLoading && atMatches.length === 0 ? (
                    <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--text-dim)" }}>
                      {needsServerSearch && !serverResultInUse ? t("input_searching") : t("input_noMatchingFiles")}
                    </div>
                  ) : (
                    atMatches.map((entry, index) => {
                      const active = index === atActiveIndex;
                      const name = entry.path.split("/").pop() ?? entry.path;
                      const dirPrefix = entry.path.slice(0, entry.path.length - name.length);
                      return (
                        <button
                          key={`${entry.isDir ? "d" : "f"}:${entry.path}`}
                          id={`${atListboxId}-opt-${index}`}
                          role="option"
                          aria-selected={active}
                          ref={(node) => {
                            atItemRefs.current[index] = node;
                          }}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            applyAtCompletion(entry);
                          }}
                          onMouseEnter={() => setAtActiveIndex(index)}
                          style={{
                            width: "100%",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 8px",
                            minHeight: isMobile ? 44 : undefined,
                            border: "none",
                            borderRadius: 6,
                            background: active ? "var(--bg-selected)" : "none",
                            color: "var(--text)",
                            cursor: "pointer",
                            textAlign: "left",
                            fontSize: 12.5,
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
                            {entry.isDir ? <FolderIcon size={14} /> : getFileIcon(name, 14)}
                          </span>
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {dirPrefix && <span style={{ color: "var(--text-dim)" }}>{dirPrefix}</span>}
                            {name}
                            {entry.isDir && <span style={{ color: "var(--text-dim)" }}>/</span>}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })()}
          <div
            className="chat-input-shell"
            style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-end",
              background: "var(--bg-elevated)",
              border: `1px solid ${bashMode ? "var(--tool-bg)" : isStreaming && (onSteer || onFollowUp)
                ? "color-mix(in srgb, var(--status-warning) 45%, var(--border-strong))"
                : "var(--border-strong)"}`,
              borderRadius: "var(--radius-lg)",
              padding: "10px 10px 10px 10px",
              boxShadow: "var(--shadow-input)",
              transition: "border-color 0.15s, background 0.15s, box-shadow 0.15s",
            } as React.CSSProperties}
          >
          {/* 输入框内左侧：添加附件（回形针，参考 openchamber FileAttachment） */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={blocked}
            data-tooltip={t("input_attachFile")}
            className="instant-tooltip tooltip-up"
            aria-label={t("input_attachFile")}
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 32,
              height: 32,
              padding: 0,
              background: "none",
              border: "none",
              borderRadius: 9,
              color: hasAttachments ? "var(--accent)" : "var(--text-muted)",
              cursor: blocked ? "not-allowed" : "pointer",
              opacity: blocked ? 0.5 : 1,
              transition: "background 0.12s, color 0.12s",
              alignSelf: "flex-end",
            }}
            onMouseEnter={(e) => {
              if (blocked) return;
              e.currentTarget.style.background = "var(--bg-hover)";
              e.currentTarget.style.color = hasAttachments ? "var(--accent)" : "var(--text)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "none";
              e.currentTarget.style.color = hasAttachments ? "var(--accent)" : "var(--text-muted)";
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <textarea
            ref={textareaRef}
            value={value}
            role="combobox"
            aria-expanded={slashMenuVisible || atMenuVisible}
            aria-controls={inputControlsId}
            aria-activedescendant={inputActiveDescendant}
            aria-autocomplete="list"
            onChange={(e) => {
              setValue(e.target.value);
              updateAtQuery(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => {
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
            }}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              isComposingRef.current = false;
              lastCompositionEndAtRef.current = Date.now();
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
            }}
            onInput={handleInput}
            onFocus={() => setComposerFocused(true)}
            onBlur={() => setComposerFocused(false)}
            onPaste={handlePaste}
            placeholder={
              isStreaming && (onSteer || onFollowUp)
                ? t("input_placeholderSteer")
                : isStreaming ? t("input_placeholderRunning")
                : t("input_placeholderMessage")
            }
            rows={1}
            style={{
              flex: 1,
              background: "none",
              border: "none",
              outline: "none",
              resize: "none",
              color: "var(--text)",
              fontSize: 14,
              // 与两侧 32px 控件对齐；收紧行高 + 对称 padding，避免单行文字视觉偏下。
              lineHeight: 1.45,
              fontFamily: "inherit",
              minHeight: 32,
              maxHeight: 200,
              padding: "5px 0",
              boxSizing: "border-box",
              overflow: "auto",
            }}
          />

          {(() => {
            // 流式期：发送按钮默认队列（follow-up）；引导仅通过桌面 Ctrl/Cmd+Enter（若配置默认引导则 Enter 引导）。
            const streamingSend = isStreaming && (onSteer || onFollowUp);
            const canSend = streamingSend
              ? canQueueStreamingMessage
              : Boolean((value.trim() || attachedImages.length || hasReadyUploads) && !hasUploading);
            const sendTooltip = streamingSend ? t("input_sendQueueTooltip") : undefined;
            return (
              <button
                type="button"
                onClick={() => {
                  if (streamingSend) sendQueued("followup");
                  else void handleSend();
                }}
                disabled={!canSend}
                data-tooltip={sendTooltip}
                className={sendTooltip ? "instant-tooltip tooltip-up" : undefined}
                style={{
                  flexShrink: 0,
                  alignSelf: "flex-end",
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "7px 14px",
                  background: canSend ? "var(--accent)" : "var(--bg-panel)",
                  border: "none",
                  borderRadius: 8,
                  color: canSend ? "var(--accent-foreground)" : "var(--text-dim)",
                  cursor: canSend ? "pointer" : "not-allowed",
                  fontSize: 13,
                  fontWeight: 600,
                  letterSpacing: "-0.01em",
                  boxShadow: canSend ? "0 1px 3px color-mix(in srgb, var(--accent) 30%, transparent)" : "none",
                  transition: "background 0.15s, box-shadow 0.15s",
                }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="2" y1="7" x2="11" y2="7" />
                  <polyline points="7.5 3 12 7 7.5 11" />
                </svg>
                {t("input_send")}
              </button>
            );
          })()}
          </div>
        </div>

        {/* Bash mode status label */}
        {bashMode && (
          <div className="text-xs px-2 py-1" style={{ color: bashExcluded ? "var(--text-muted)" : "var(--accent)", marginTop: 4 }}>
            {t("input_shellStatus", { scope: bashExcluded ? t("input_shellLocal") : t("input_shellModel") })}
          </div>
        )}

        {/* Bottom bar: left | center (context) | right */}
        <div style={{
          marginTop: 8,
          display: isMobile ? "grid" : "flex",
          gridTemplateColumns: isMobile ? "minmax(0, 1fr) auto" : undefined,
          alignItems: "center",
          gap: 6,
        }}>

          {/* LEFT: model + thinking（思考紧贴模型；手机端常显） */}
          <div style={{ flex: "0 1 auto", minWidth: 0, display: "flex", alignItems: "center", gap: 2, maxWidth: isMobile ? "100%" : undefined }}>
            {/* Footer 折叠按钮 — 位于模型选择前面，折叠输入框下方状态条 */}
            {onFooterToggle && (
              <button
                type="button"
                onClick={onFooterToggle}
                aria-expanded={!footerCollapsed}
                aria-label={footerCollapsed ? t("footer_expand") : t("footer_collapse")}
                title={footerCollapsed ? t("footer_expand") : t("footer_collapse")}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: isMobile ? 26 : 24,
                  height: isMobile ? 26 : 24,
                  padding: 0,
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  background: "var(--bg-panel)",
                  color: "var(--text-dim)",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                {footerCollapsed ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>
                )}
              </button>
            )}
            {/* Model selector — 运行中也可改，下次发送/引导/队列生效 */}
            {modelOptions.length > 0 && onModelChange && (
                <div ref={dropdownRef} style={{ position: "relative", flex: "0 1 auto", minWidth: isMobile ? 96 : 140 }}>
                  <button
                    ref={modelButtonRef}
                    aria-haspopup="listbox"
                    aria-expanded={modelDropdownOpen}
                    aria-controls={modelMenuId}
                    onClick={() => {
                      const opening = !modelDropdownOpen;
                      setModelDropdownOpen(opening);
                      if (opening) {
                        // 同一时刻只保留一个浮层：关掉其它菜单与输入补全。
                        setToolDropdownOpen(false);
                        setSlashMenuOpen(false);
                        setAtMenuOpen(false);
                      }
                    }}
                    title={
                      isStreaming
                        ? t("input_changeAppliesNextTurn")
                        : (model
                            ? modelInfoTitle({
                                modelId: model.modelId,
                                name: currentName ?? model.modelId,
                                provider: model.provider,
                                contextWindow: modelList?.find(
                                  (m) => m.provider === model?.provider && m.id === model?.modelId,
                                )?.contextWindow,
                                maxTokens: modelList?.find(
                                  (m) => m.provider === model?.provider && m.id === model?.modelId,
                                )?.maxTokens,
                              })
                            : undefined)
                    }
                    style={{
                      display: "flex", alignItems: "center", gap: isMobile ? 4 : 6,
                      justifyContent: "flex-start",
                      padding: isMobile ? "6px 8px" : "8px 12px",
                      height: 32,
                      // 宽度自适应内容，min/max 兜底（手机不占满整行）
                      width: "auto",
                      minWidth: isMobile ? 96 : 140,
                      maxWidth: isMobile ? 220 : 340,
                      overflow: "hidden",
                      background: modelDropdownOpen ? "var(--bg-hover)" : "none",
                      border: "none",
                      borderRadius: 9,
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: isMobile ? 11 : 12,
                      transition: "background 0.12s, color 0.12s",
                      flex: "0 1 auto",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "var(--bg-hover)";
                      e.currentTarget.style.color = "var(--text)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = modelDropdownOpen ? "var(--bg-hover)" : "none";
                      e.currentTarget.style.color = "var(--text-muted)";
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="4" y="4" width="16" height="16" rx="2" />
                      <rect x="9" y="9" width="6" height="6" />
                      <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                      <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                      <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                      <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
                    </svg>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{currentName ?? t("input_modelTitle")}</span>
                    {/* 思考深度并入模型选择按钮显示（外层已保证 onModelChange 存在） */}
                    {thinkingLabel ? (
                      <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginLeft: 2 }}>
                        ·{thinkingLabel}
                      </span>
                    ) : null}
                  </button>
                  {/* Portal 到 body：与思考/工具菜单一致，fixed 坐标免疫任何祖先
                      containing block（transform/filter/backdrop-filter）干扰 */}
                  {modelDropdownOpen && createPortal(
                      <div
                        ref={modelDropdownPanelRef}
                        id={modelMenuId}
                        role="listbox"
                        aria-label={t("input_modelTitle")}
                        onKeyDown={(e) => movePanelOptionFocus(e, '[role="option"]')}
                        style={{
                        ...modelOverlay.style,
                        zIndex: 500, background: "var(--bg)", border: "1px solid var(--border)",
                        borderRadius: 8,
                        boxShadow: modelOverlay.placement === "above" ? "0 -4px 16px rgba(0,0,0,0.10)" : "0 4px 16px rgba(0,0,0,0.10)",
                        overflow: "hidden", overflowY: "auto",
                        }}
                      >
                      {modelsByProvider.map((group, gi) => {
                        const authBlocked = modelAuthConfigured?.[group.provider] === false;
                        return (
                        <div key={group.provider}>
                          {(modelsByProvider.length > 1) && (
                            <div style={{
                              padding: "6px 12px 4px",
                              fontSize: 10, fontWeight: 600, color: "var(--text-dim)",
                              textTransform: "uppercase", letterSpacing: "0.07em",
                              borderTop: gi > 0 ? "1px solid var(--border)" : "none",
                              display: "flex", alignItems: "center", gap: 6,
                            }}>
                              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{group.provider}</span>
                              {authBlocked && (
                                <span
                                  title={t("models_authRequiredToViewModels")}
                                  style={{
                                    flexShrink: 0, fontSize: 9, padding: "1px 6px",
                                    borderRadius: 999, border: "1px solid var(--border)",
                                    color: "var(--text-dim)", textTransform: "none",
                                    letterSpacing: 0, fontWeight: 400,
                                  }}
                                >
                                  {t("models_authRequired")}
                                </span>
                              )}
                            </div>
                          )}
                          {group.options.map((opt) => {
                          const isActive = opt.modelId === model?.modelId && opt.provider === model?.provider;
                          const blocked = authBlocked && !isActive;
                          const infoTitle = blocked ? t("models_authRequiredToViewModels") : modelInfoTitle(opt);
                          const cached = cachedThinkingLevel(opt.provider, opt.modelId);
                          // 当前模型：与按钮同一套会话级（引导页 auto 不被缓存 xhigh 盖住）
                          // 非当前模型：只显示该模型缓存
                          const currentLevel = listThinkingDisplayLevel(cached, isActive, thinkingLevel, thinkingFallback);
                          const levels = levelsForModel(opt.provider, opt.modelId);
                          const depthKey = `${opt.provider}:${opt.modelId}`;
                          const depthOpen = depthMenuFor === depthKey;
                          const selectModel = () => {
                            if (blocked || !onModelChange) return;
                            setModelDropdownOpen(false);
                            closeDepthMenu();
                            modelButtonRef.current?.focus({ preventScroll: true });
                            // 引导页/已有会话一律写入：无缓存 = auto，不把上一模型深度带过去
                            onModelChange(opt.provider, opt.modelId, modelClickThinkingLevel(cached, thinkingFallback));
                          };
                          return (
                            <div
                              key={depthKey}
                              role="option"
                              aria-selected={isActive}
                              aria-disabled={blocked || undefined}
                              title={infoTitle}
                              tabIndex={blocked ? -1 : 0}
                              onClick={selectModel}
                              onKeyDown={(e) => {
                                if (blocked) return;
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  selectModel();
                                }
                              }}
                              style={{
                                display: "flex", alignItems: "center", gap: 8,
                                width: "100%", padding: "7px 12px",
                                minHeight: isMobile ? 44 : undefined,
                                background: isActive ? "var(--bg-selected)" : "none",
                                border: "none",
                                color: blocked ? "var(--text-dim)" : (isActive ? "var(--text)" : "var(--text-muted)"),
                                cursor: blocked ? "not-allowed" : "pointer", fontSize: 12, textAlign: "left",
                                fontWeight: isActive ? 600 : 400,
                                whiteSpace: "nowrap",
                                opacity: blocked ? 0.55 : 1,
                                boxSizing: "border-box",
                              }}
                              onMouseEnter={(e) => { if (!isActive && !blocked) e.currentTarget.style.background = "var(--bg-hover)"; }}
                              onMouseLeave={(e) => { if (!isActive && !blocked) e.currentTarget.style.background = "none"; }}
                            >
                              {isActive
                                ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                                : <span style={{ width: 10, flexShrink: 0 }} />}
                              <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{opt.name}</span>
                              {typeof opt.contextWindow === "number" && (
                                <span style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, color: sessionExceedsModelWindow(sessionTokens, opt.contextWindow) ? "var(--status-warning)" : "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                                  {/* 切换前预警：本会话估算占用已接近/超过该模型声明可用余量 */}
                                  {sessionExceedsModelWindow(sessionTokens, opt.contextWindow) && (
                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                      <path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
                                    </svg>
                                  )}
                                  {formatTokens(opt.contextWindow)}
                                </span>
                              )}
                              {/* 独立按钮：禁止嵌套 interactive，避免吞掉行点击 */}
                              <button
                                type="button"
                                data-depth-trigger={depthKey}
                                aria-label={t("input_modelThinkingLevel")}
                                aria-expanded={depthOpen}
                                disabled={blocked}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  e.preventDefault();
                                  if (blocked) return;
                                  if (depthOpen) closeDepthMenu();
                                  else openDepthMenu(depthKey, e.currentTarget);
                                }}
                                style={{
                                  display: "inline-flex", alignItems: "center", gap: 3,
                                  flexShrink: 0,
                                  minWidth: 44, minHeight: isMobile ? 44 : 32,
                                  justifyContent: "center",
                                  padding: "0 6px",
                                  borderRadius: 6,
                                  border: "none",
                                  background: depthOpen ? "var(--bg-selected)" : "var(--bg-subtle)",
                                  color: "var(--text-muted)",
                                  cursor: blocked ? "not-allowed" : "pointer",
                                  fontSize: 11,
                                  fontFamily: "var(--font-mono)",
                                }}
                              >
                                {currentLevel}
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
                              </button>
                              {depthOpen && depthMenuPos && createPortal(
                                <div
                                  ref={depthMenuRef}
                                  role="listbox"
                                  aria-label={t("input_modelThinkingLevel")}
                                  style={{
                                    position: "fixed",
                                    top: depthMenuPos.top,
                                    left: depthMenuPos.left,
                                    zIndex: 10070,
                                    background: "var(--bg)",
                                    border: "1px solid var(--border)",
                                    borderRadius: 8,
                                    boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
                                    padding: 4,
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: 2,
                                    minWidth: 116,
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                  onPointerDown={(e) => e.stopPropagation()}
                                >
                                  {levels.map((lv) => (
                                    <button
                                      key={lv}
                                      type="button"
                                      role="option"
                                      aria-selected={lv === currentLevel}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        applyModelWithThinking(opt.provider, opt.modelId, lv);
                                      }}
                                      style={{
                                        minHeight: isMobile ? 44 : 30,
                                        padding: "0 10px",
                                        border: "none",
                                        borderRadius: 6,
                                        background: lv === currentLevel ? "var(--bg-selected)" : "none",
                                        color: lv === currentLevel ? "var(--text)" : "var(--text-muted)",
                                        cursor: "pointer",
                                        fontSize: 11,
                                        fontFamily: "var(--font-mono)",
                                        textAlign: "left",
                                      }}
                                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                                      onMouseLeave={(e) => { e.currentTarget.style.background = lv === currentLevel ? "var(--bg-selected)" : "none"; }}
                                    >
                                      {lv}
                                    </button>
                                  ))}
                                </div>,
                                document.body,
                              )}
                            </div>
                          );
                        })}
                        </div>
                        );
                      })}
                    </div>,
                    document.body,
                  )}
                </div>
            )}
          </div>

          {/* spacer */}
          {!isMobile && <div style={{ flex: 1 }} />}

          {/* RIGHT: 仅停止（流式/压缩中）；压缩改走 /compact 命令防误触；提示音改设置页 */}
          <div style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            marginLeft: "auto",
          }}>
            {(isStreaming || isCompacting) && (
              <button
                type="button"
                onClick={() => {
                  if (isCompacting && onAbortCompaction) onAbortCompaction();
                  else onAbort();
                }}
                data-tooltip={isCompacting ? t("input_stopCompaction") : t("chat_cancel")}
                className="instant-tooltip tooltip-up"
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: isMobile ? "6px 10px" : "8px 14px",
                  height: 32,
                  background: "color-mix(in srgb, var(--status-danger) 8%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--status-danger) 30%, transparent)",
                  borderRadius: 9,
                  color: "var(--status-danger)",
                  cursor: "pointer",
                  fontSize: 12, fontWeight: 600,
                  whiteSpace: "nowrap", letterSpacing: "-0.01em",
                  transition: "background 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--status-danger) 16%, transparent)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--status-danger) 8%, transparent)"; }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
                </svg>
                {isCompacting ? t("input_stopCompaction") : t("input_stop")}
              </button>
            )}
          </div>

        </div>
        </fieldset>
      </div>
    </div>
  );
});
