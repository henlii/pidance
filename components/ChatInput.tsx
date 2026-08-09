"use client";

import React, { useRef, useState, useCallback, useEffect, useId, useImperativeHandle, forwardRef, KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { BuiltinSlashCommandResult, CompactResultInfo, QueuedMessages, SlashCommandInfo } from "@/hooks/useAgentSession";
import { clearDraft, getDraft, setDraft, type ChatDraftImage } from "@/lib/draft-store";
import {
  buildEntriesFromFiles, buildAtInsertText, extractAtQuery, filterFileEntries,
  type AtQueryMatch, type FileIndexEntry,
} from "@/lib/file-fuzzy";
import { FolderIcon, getFileIcon } from "./FileIcons";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useAnchoredOverlay } from "@/hooks/useAnchoredOverlay";
import { useI18n } from "@/lib/i18n";
import type { AttachedImage, ChatInputHandle } from "@/lib/types";
import {
  loadStreamingEnterAction,
  type StreamingEnterAction,
} from "@/lib/ui-preferences";
import { isAudioPath, isImagePath, isVideoPath } from "@/lib/file-types";

export type { AttachedImage, ChatInputHandle } from "@/lib/types";

/** 非图片附件：落到 ~/.pi/agent/pidance-attachments/，发送时把绝对路径注入 prompt。 */
type AttachedUpload = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path?: string;
  status: "uploading" | "ready" | "error";
  error?: string;
};

function isRasterImageFile(file: File): boolean {
  return file.type.startsWith("image/") && file.type !== "image/svg+xml";
}

function makeUploadId(): string {
  return `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 上传到 Pidance 附件目录（不依赖项目 cwd）。 */
async function uploadChatAttachment(file: File): Promise<{ path: string; name: string }> {
  const formData = new FormData();
  formData.append("files", file, file.name);
  const res = await fetch("/api/attachments", { method: "POST", body: formData });
  const data = (await res.json().catch(() => ({}))) as {
    uploaded?: Array<{ path: string; name: string }>;
    errors?: Array<{ name: string; error: string }>;
    error?: string;
  };
  if (!res.ok && res.status !== 207) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  const err = data.errors?.[0];
  if (err && (!data.uploaded || data.uploaded.length === 0)) {
    throw new Error(err.error);
  }
  const uploaded = data.uploaded?.[0];
  if (!uploaded?.path) throw new Error(data.error ?? err?.error ?? "upload failed");
  return { path: uploaded.path, name: uploaded.name || file.name };
}

interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

interface Props {
  /**
   * P0-1：返回发送确认结果——false = 发送失败（draft 由上层恢复，此处不清空）；
   * true/undefined = 已确认或无可确认（清空 draft）。
   */
  onSend: (message: string, images?: AttachedImage[]) => Promise<boolean> | boolean;
  onAbort: () => void;
  onSteer?: (message: string, images?: AttachedImage[]) => void;
  onFollowUp?: (message: string, images?: AttachedImage[]) => void;
  onPromptWithStreamingBehavior?: (message: string, behavior: "steer" | "followUp", images?: AttachedImage[]) => void;
  isStreaming: boolean;
  model?: { provider: string; modelId: string } | null;
  isAutoModelSelection?: boolean;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string }[];
  /** providerId → 是否有可用凭据；未认证且无环境凭据的 provider 模型在列表中灰显禁用。 */
  modelAuthConfigured?: Record<string, boolean>;
  onModelChange?: (provider: string, modelId: string) => void;
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
  compactResult?: CompactResultInfo | null;
  thinkingLevel?: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  onThinkingLevelChange?: (level: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  queuedMessages?: QueuedMessages | null;
  onRecallQueue?: () => void;
  /** 将队列中消息按引导方式重新入队（follow-up → steer）；可选 extraMessage 并入队尾。 */
  onSendQueueAsSteer?: (extraMessage?: string) => void;
  slashCommands?: SlashCommandInfo[];
  slashCommandsLoading?: boolean;
  onLoadSlashCommands?: () => Promise<SlashCommandInfo[]> | SlashCommandInfo[];
  onBuiltinCommand?: (message: string) => Promise<BuiltinSlashCommandResult>;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  onAudioUnlock?: () => void;
  draftKey?: string;
  /** Session working directory — enables the @ file autocomplete menu */
  cwd?: string | null;
}

const COMPOSITION_END_ENTER_GRACE_MS = 100;
const MODEL_OPTION_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareModelOptions(a: ModelOption, b: ModelOption): number {
  return MODEL_OPTION_COLLATOR.compare(a.name || a.modelId, b.name || b.modelId)
    || MODEL_OPTION_COLLATOR.compare(a.provider, b.provider)
    || MODEL_OPTION_COLLATOR.compare(a.modelId, b.modelId);
}

const THINKING_LEVELS = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const THINKING_LEVEL_DESC: Record<typeof THINKING_LEVELS[number], "input_usePiDefault" | "input_thinkingOff" | "input_thinkingMinimal" | "input_thinkingLow" | "input_thinkingMedium" | "input_thinkingHigh" | "input_thinkingXhigh" | "input_thinkingMax"> = {
  auto: "input_usePiDefault",
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
  return { data: image.data, mimeType: image.mimeType };
}

function draftImageToAttachedImage(image: ChatDraftImage): AttachedImage {
  return {
    ...image,
    previewUrl: `data:${image.mimeType};base64,${image.data}`,
  };
}

function revokeImagePreview(image: AttachedImage): void {
  if (image.previewUrl.startsWith("blob:")) {
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

function QueuedMessageRow({ kind, text }: { kind: "steer" | "follow-up"; text: string }) {
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
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
    </div>
  );
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSend, onAbort, onSteer, onFollowUp, isStreaming, model, isAutoModelSelection, modelNames, modelList, modelAuthConfigured, onModelChange,
  onAbortCompaction, isCompacting, compactError, compactResult,
  thinkingLevel, onThinkingLevelChange, availableThinkingLevels, thinkingLevelMap,
  retryInfo, queuedMessages, onRecallQueue, onSendQueueAsSteer,
  slashCommands, slashCommandsLoading, onLoadSlashCommands,
  onBuiltinCommand,
  onAudioUnlock,
  onPromptWithStreamingBehavior,
  draftKey,
  cwd,
}: Props, ref) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  /** 桌面流式期 Enter 默认动作（followUp/steer）；手机端回车仅换行。 */
  const [streamingEnterDefault, setStreamingEnterDefault] = useState<StreamingEnterAction>("followUp");
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
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [toolDropdownOpen, setToolDropdownOpen] = useState(false);
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);

  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>(() => (
    draftKey ? getDraft(draftKey)?.images.map(draftImageToAttachedImage) ?? [] : []
  ));
  const trimmedValue = value.trimStart();
  const bashMode = attachedImages.length === 0 && trimmedValue.startsWith("!");
  const bashExcluded = bashMode && trimmedValue.startsWith("!!");
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [atQuery, setAtQuery] = useState<AtQueryMatch | null>(null);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const [fileIndex, setFileIndex] = useState<{ cwd: string; entries: FileIndexEntry[]; truncated: boolean } | null>(null);
  const [fileIndexLoading, setFileIndexLoading] = useState(false);
  const [atServerResult, setAtServerResult] = useState<{ cwd: string; query: string; matches: FileIndexEntry[] } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const modelDropdownPanelRef = useRef<HTMLDivElement>(null);
  const toolDropdownRef = useRef<HTMLDivElement>(null);
  const toolDropdownPanelRef = useRef<HTMLDivElement>(null);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);
  const thinkingDropdownPanelRef = useRef<HTMLDivElement>(null);

  const inputContainerRef = useRef<HTMLDivElement>(null);
  const slashOverlayRef = useRef<HTMLDivElement>(null);
  const atOverlayRef = useRef<HTMLDivElement>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const slashCommandsRequestedRef = useRef(false);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const atItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fileIndexMetaRef = useRef<{ cwd: string; fetchedAt: number } | null>(null);
  const fileIndexFetchingRef = useRef<string | null>(null);
  const draftKeyRef = useRef(draftKey);
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

  useImperativeHandle(ref, () => ({
    insertIfEmpty: insertIfEmptyLocal,
    prependText(text: string) {
      if (!text.trim()) return;
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      // Mirrors the TUI's queue restore: queued text first, then whatever
      // the user already typed, separated by a blank line.
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
    addImages(files: File[]) {
      void processAttachmentFiles(files);
    },
  }));

  const [attachedUploads, setAttachedUploads] = useState<AttachedUpload[]>([]);
  const attachedUploadsRef = useRef(attachedUploads);
  attachedUploadsRef.current = attachedUploads;

  const processImageFiles = useCallback(async (files: File[]) => {
    if (isStreaming) return;
    const imageFiles = files.filter(isRasterImageFile);
    if (!imageFiles.length) return;
    const newImages = await Promise.all(
      imageFiles.map(
        (file) =>
          new Promise<AttachedImage>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const result = reader.result as string;
              // result is "data:<mime>;base64,<data>"
              const base64 = result.split(",")[1];
              resolve({ data: base64, mimeType: file.type, previewUrl: URL.createObjectURL(file) });
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
          })
      )
    );
    setAttachedImages((prev) => [...prev, ...newImages]);
  }, [isStreaming]);

  /**
   * 附件策略：
   * - 位图图片 → 多模态 AttachedImage
   * - 其余 → 上传到 ~/.pi/agent/pidance-attachments/（不限项目），路径注入 prompt 由 agent read
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
          const { path, name } = await uploadChatAttachment(file);
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

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed) revokeImagePreview(removed);
      return next;
    });
  }, []);

  const removeUpload = useCallback((id: string) => {
    setAttachedUploads((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const clearImages = useCallback(() => {
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return [];
    });
  }, []);

  const clearUploads = useCallback(() => {
    setAttachedUploads([]);
  }, []);

  const clearInput = useCallback(() => {
    setValue("");
    setAtQuery(null);
    if (draftKey) clearDraft(draftKey);
    if (draftKeyRef.current && draftKeyRef.current !== draftKey) clearDraft(draftKeyRef.current);
    clearImages();
    clearUploads();
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [clearImages, clearUploads, draftKey]);

  /** 把已就绪上传路径拼进消息正文，供 agent 用工具读取。 */
  const composeMessageWithUploads = useCallback((base: string): string => {
    const ready = attachedUploadsRef.current.filter((u) => u.status === "ready" && u.path);
    if (ready.length === 0) return base;
    const list = ready.map((u) => `- \`${u.path}\``).join("\n");
    const block = `${t("input_attachedFilesPrompt")}\n${list}`;
    return base.trim() ? `${base.trim()}\n\n${block}` : block;
  }, [t]);

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
  const hasUploading = attachedUploads.some((u) => u.status === "uploading");
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
    if (hasUploading) return; // 等上传完成
    // 纯文本/命令：点击即乐观清空（外部 pi 预检/冷启动可能数秒，不必等确认）；
    // 失败路径由 useAgentSession 经 insertIfEmpty 恢复（此处覆盖同步 false 返回）。
    // 有附件时不乐观清空：发送失败恢复图片成本高，保持确认后清空。
    const hasAttachment = attachedImages.length > 0 || hasReadyUploads;
    if (!hasAttachment) clearInput();
    if (!attachedImages.length && !hasReadyUploads && base.startsWith("/") && onBuiltinCommand) {
      const result = await onBuiltinCommand(base);
      if (result.handled) {
        if (result.error) insertIfEmptyLocal(base);
        return;
      }
    }
    const msg = composeMessageWithUploads(base);
    const submitted = await onSend(msg, attachedImages.length ? attachedImages : undefined);
    if (submitted === false) {
      // 发送被拒（branchBusy / 新会话失败等）：恢复草稿（仅纯文本可恢复）
      if (!hasAttachment) insertIfEmptyLocal(base);
      return;
    }
    if (hasAttachment) clearInput();
  }, [value, attachedImages, hasReadyUploads, hasUploading, isStreaming, onBuiltinCommand, onSend, clearInput, insertIfEmptyLocal, onAudioUnlock, composeMessageWithUploads]);

  const slashQuery = value.startsWith("/") && !/\s/.test(value.slice(1))
    ? value.slice(1).toLowerCase()
    : null;

  const filteredSlashCommands = (() => {
    if (slashQuery === null) return [];
    const commands = [...(isStreaming ? [] : BUILTIN_SLASH_COMMANDS), ...(slashCommands ?? [])];
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
  const hasInputText = Boolean(value.trim()) || hasReadyUploads;
  const canQueueStreamingMessage = hasInputText && attachedImages.length === 0 && !hasUploading;

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
    // 流式期：图片仍不可排队；路径附件是文本可排队
    if (!base && !hasReadyUploads) return;
    if (attachedImages.length) return;
    if (hasUploading) return;
    onAudioUnlock?.();
    const msg = composeMessageWithUploads(base);
    const streamingBehavior = mode === "steer" ? "steer" : "followUp";
    if (msg.startsWith("/") && onPromptWithStreamingBehavior) {
      onPromptWithStreamingBehavior(msg, streamingBehavior, undefined);
      clearInput();
      return;
    }
    if (mode === "steer" && onSteer) {
      onSteer(msg, undefined);
    } else if (mode === "followup" && onFollowUp) {
      onFollowUp(msg, undefined);
    } else if (mode === "steer" && onFollowUp) {
      onFollowUp(msg, undefined);
    } else if (mode === "followup" && onSteer) {
      onSteer(msg, undefined);
    }
    clearInput();
  }, [value, attachedImages.length, hasReadyUploads, hasUploading, onPromptWithStreamingBehavior, onSteer, onFollowUp, clearInput, onAudioUnlock, composeMessageWithUploads]);

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
    [isStreaming, isMobile, streamingEnterDefault, onSteer, onFollowUp, onAbort, slashMenuOpen, slashQuery, filteredSlashCommands, slashActiveIndex, applySlashCommand, sendQueued, handleSend, getNextSlashIndex, atMenuOpen, atQuery, atMatches, atActiveIndex, applyAtCompletion, queuedMessages, onSendQueueAsSteer, flushQueueAsSteer]
  );

  const handleInput = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (!imageItems.length) return;
    e.preventDefault();
    const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
    processImageFiles(files);
  }, [processImageFiles]);

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

  // Build model options: prefer modelList (has provider info), fallback to modelNames
  const modelOptions: ModelOption[] = (() => {
    if (modelList && modelList.length > 0) {
      return modelList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name })).sort(compareModelOptions);
    }
    return Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
      provider: model?.provider ?? "unknown",
      modelId,
      name,
    })).sort(compareModelOptions);
  })();

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
  const thinkingDisplayLabel = (() => {
    const lvl = thinkingLevel ?? "auto";
    if (lvl === "auto" || !thinkingLevelMap) return lvl;
    return thinkingLevelMap[lvl] ?? lvl;
  })();

  // ── 视口安全浮层定位 ─────────────────────────────────────────────────────
  // 所有菜单共享 useAnchoredOverlay：visualViewport 感知、上下翻转、边界
  // clamp、maxWidth/maxHeight 写回 style，内容在面板内部滚动。
  const slashListboxId = useId();
  const atListboxId = useId();
  const modelMenuId = useId();
  const thinkingMenuId = useId();
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
  const thinkingOverlay = useAnchoredOverlay({
    open: thinkingDropdownOpen,
    anchorRef: thinkingDropdownRef,
    overlayRef: thinkingDropdownPanelRef,
    preferredPlacement: "above",
    gap: 6,
    margin: 8,
    align: "end",
    minWidth: 180,
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
    const anyOpen = thinkingDropdownOpen || toolDropdownOpen || modelDropdownOpen;
    if (!anyOpen) return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      if (thinkingDropdownOpen) {
        setThinkingDropdownOpen(false);
        focusTriggerButton(thinkingDropdownRef.current);
      } else if (toolDropdownOpen) {
        setToolDropdownOpen(false);
        focusTriggerButton(toolDropdownRef.current);
      } else if (modelDropdownOpen) {
        setModelDropdownOpen(false);
        modelButtonRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [thinkingDropdownOpen, toolDropdownOpen, modelDropdownOpen]);

  // 菜单打开时把焦点送进面板（选中项优先，无则首项），Esc/选择后焦点回 trigger。
  useEffect(() => {
    if (thinkingDropdownOpen) focusPanelOption(thinkingDropdownPanelRef.current, '[role="menuitemradio"]');
  }, [thinkingDropdownOpen]);
  useEffect(() => {
    if (toolDropdownOpen) focusPanelOption(toolDropdownPanelRef.current, '[role="menuitemradio"]');
  }, [toolDropdownOpen]);
  useEffect(() => {
    if (modelDropdownOpen) focusPanelOption(modelDropdownPanelRef.current, '[role="option"]');
  }, [modelDropdownOpen]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        modelDropdownPanelRef.current && !modelDropdownPanelRef.current.contains(e.target as Node)
      ) {
        setModelDropdownOpen(false);
      }
      if (
        toolDropdownRef.current && !toolDropdownRef.current.contains(e.target as Node) &&
        toolDropdownPanelRef.current && !toolDropdownPanelRef.current.contains(e.target as Node)
      ) {
        setToolDropdownOpen(false);
      }
      if (
        thinkingDropdownRef.current && !thinkingDropdownRef.current.contains(e.target as Node) &&
        thinkingDropdownPanelRef.current && !thinkingDropdownPanelRef.current.contains(e.target as Node)
      ) {
        setThinkingDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);



  return (
    <div
      style={{
        flexShrink: 0,
        background: "transparent",
        padding: "0 16px 8px",
        paddingRight: isMobile ? 16 : 52, // desktop: 16px base + 36px for ChatMinimap alignment
      }}
    >
      {/* Hidden file input：图片走多模态附件；文本类写入消息正文 */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        disabled={isStreaming}
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          void processAttachmentFiles(files);
          e.target.value = "";
        }}
      />
      <div style={{ maxWidth: 820, margin: "0 auto" }}>
        {/* Queued follow-up messages（steering 即时投递，不在队列块显示） */}
        {(queuedMessages?.followUp.length ?? 0) > 0 && (
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
                {t("input_queued", { count: queuedMessages?.followUp.length ?? 0 })}
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
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
            {queuedMessages?.followUp.map((text, i) => (
              <QueuedMessageRow key={`followup-${i}`} kind="follow-up" text={text} />
            ))}
            {queuedMessages?.followUp.map((text, i) => (
              <QueuedMessageRow key={`followup-${i}`} kind="follow-up" text={text} />
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
        {(attachedImages.length > 0 || attachedUploads.length > 0) && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap", alignItems: "center" }}>
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
            disabled={isStreaming}
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
              cursor: isStreaming ? "not-allowed" : "pointer",
              opacity: isStreaming ? 0.5 : 1,
              transition: "background 0.12s, color 0.12s",
              alignSelf: "flex-end",
            }}
            onMouseEnter={(e) => {
              if (isStreaming) return;
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
            const sendTooltip = streamingSend
              ? (attachedImages.length
                ? t("input_imageQueueDisabled")
                : t("input_sendQueueTooltip"))
              : undefined;
            return (
              <button
                type="button"
                onClick={() => {
                  if (streamingSend) sendQueued("followup");
                  else void handleSend();
                }}
                disabled={!canSend}
                title={sendTooltip}
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
            {/* Model selector — 运行中也可改，下次发送/引导/队列生效 */}
            {modelOptions.length > 0 && currentName && onModelChange && (
                <div ref={dropdownRef} style={{ position: "relative", flex: "0 1 auto", minWidth: 0 }}>
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
                        setThinkingDropdownOpen(false);
                        setToolDropdownOpen(false);
                        setSlashMenuOpen(false);
                        setAtMenuOpen(false);
                      }
                    }}
                    title={isStreaming ? t("input_changeAppliesNextTurn") : undefined}
                    style={{
                      display: "flex", alignItems: "center", gap: isMobile ? 4 : 6,
                      justifyContent: "flex-start",
                      padding: isMobile ? "6px 8px" : "8px 12px",
                      height: 32,
                      // 手机端不占满整行，避免模型按钮过大挤压思考/停止
                      width: "auto",
                      maxWidth: isMobile ? 132 : 220,
                      overflow: "hidden",
                      background: modelDropdownOpen ? "var(--bg-hover)" : "none",
                      border: "none",
                      borderRadius: 9,
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: isMobile ? 11 : 12,
                      transition: "background 0.12s, color 0.12s",
                      flex: "0 1 auto",
                      minWidth: 0,
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
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{currentName}</span>
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
                            return (
                              <button
                                key={`${opt.provider}:${opt.modelId}`}
                                role="option"
                                aria-selected={isActive}
                                aria-disabled={blocked || undefined}
                                disabled={blocked}
                                title={blocked ? t("models_authRequiredToViewModels") : undefined}
                                onClick={() => {
                                  setModelDropdownOpen(false);
                                  // 键盘选择后焦点回 trigger；指针用户不受程序聚焦影响。
                                  modelButtonRef.current?.focus({ preventScroll: true });
                                  if (!isActive || isAutoModelSelection) onModelChange(opt.provider, opt.modelId);
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
                                }}
                                onMouseEnter={(e) => { if (!isActive && !blocked) e.currentTarget.style.background = "var(--bg-hover)"; }}
                                onMouseLeave={(e) => { if (!isActive && !blocked) e.currentTarget.style.background = "none"; }}
                              >
                                {isActive
                                  ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                                  : <span style={{ width: 10, flexShrink: 0 }} />}
                                {/* 超长模型名省略号收尾，不再被 overflowX:hidden 硬切 */}
                                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{opt.name}</span>
                              </button>
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
            {/* Thinking — 紧贴模型旁，运行中也常显（下次发送生效） */}
            {onThinkingLevelChange && (
              <div ref={thinkingDropdownRef} style={{ position: "relative", flexShrink: 0 }}>
                <button
                  onClick={() => {
                    const opening = !thinkingDropdownOpen;
                    setThinkingDropdownOpen(opening);
                    if (opening) {
                      setToolDropdownOpen(false);
                      setModelDropdownOpen(false);
                      setSlashMenuOpen(false);
                      setAtMenuOpen(false);
                    }
                  }}
                  title={isStreaming ? `${thinkingDisplayLabel} · ${t("input_changeAppliesNextTurn")}` : thinkingDisplayLabel}
                  data-tooltip={isStreaming ? `${thinkingDisplayLabel} · ${t("input_changeAppliesNextTurn")}` : thinkingDisplayLabel}
                  className="instant-tooltip tooltip-up"
                  aria-label={t("input_thinkingTitle")}
                  aria-haspopup="menu"
                  aria-expanded={thinkingDropdownOpen}
                  aria-controls={thinkingMenuId}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                    padding: isMobile ? "0 8px" : "8px 12px",
                    height: 32,
                    background: thinkingDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    borderRadius: 9,
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 12,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = thinkingDropdownOpen ? "var(--bg-hover)" : "none";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9.5 2A5.5 5.5 0 0 0 4 7.5c0 1.7.78 3.21 2 4.21V14a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-2.29c1.22-1 2-2.51 2-4.21A5.5 5.5 0 0 0 9.5 2z" />
                    <line x1="7" y1="18" x2="12" y2="18" />
                    <line x1="8" y1="21" x2="11" y2="21" />
                  </svg>
                  <span style={{ whiteSpace: "nowrap" }}>{thinkingDisplayLabel}</span>
                </button>
                {thinkingDropdownOpen && createPortal(
                  <div
                    ref={thinkingDropdownPanelRef}
                    id={thinkingMenuId}
                    role="menu"
                    onKeyDown={(e) => movePanelOptionFocus(e, '[role="menuitemradio"]')}
                    style={{
                    ...thinkingOverlay.style,
                    zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)",
                    borderRadius: 8,
                    boxShadow: thinkingOverlay.placement === "above" ? "0 -4px 16px rgba(0,0,0,0.10)" : "0 4px 16px rgba(0,0,0,0.10)",
                    overflow: "hidden", overflowY: "auto",
                  }}>
                    {THINKING_LEVELS.filter((lvl) => {
                      if (!availableThinkingLevels) return true;
                      if (lvl === "auto") return true;
                      return availableThinkingLevels.includes(lvl);
                    }).map((lvl) => {
                      const isActive = (thinkingLevel ?? "auto") === lvl;
                      const desc = THINKING_LEVEL_DESC[lvl];
                      const mappedVal = (lvl !== "auto" && thinkingLevelMap) ? thinkingLevelMap[lvl] : undefined;
                      const displayLabel = (mappedVal != null && mappedVal !== lvl) ? mappedVal : lvl;
                      const showOriginal = mappedVal != null && mappedVal !== lvl;
                      return (
                        <button
                          key={lvl}
                          role="menuitemradio"
                          aria-checked={isActive}
                          onClick={() => {
                            setThinkingDropdownOpen(false);
                            focusTriggerButton(thinkingDropdownRef.current);
                            if (!isActive) onThinkingLevelChange(lvl);
                          }}
                          style={{
                            display: "flex", alignItems: "center", gap: 8,
                            width: "100%", padding: "7px 12px",
                            minHeight: isMobile ? 44 : undefined,
                            background: isActive ? "var(--bg-selected)" : "none",
                            border: "none",
                            color: isActive ? "var(--text)" : "var(--text-muted)",
                            cursor: "pointer", fontSize: 12, textAlign: "left",
                            fontWeight: isActive ? 600 : 400,
                            whiteSpace: "nowrap",
                          }}
                          onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                        >
                          {isActive
                            ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                            : <span style={{ width: 10, flexShrink: 0 }} />}
                          <span style={{ flex: 1 }}>
                            {displayLabel}
                            {showOriginal && <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginLeft: 5 }}>({lvl})</span>}
                          </span>
                          <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{t(desc)}</span>
                        </button>
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
      </div>
    </div>
  );
});
