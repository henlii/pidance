import type { AttachedImageMedia, BinaryMessageInput } from "./types";

export interface ChatDraftImage {
  /** 兼容旧草稿：安全尺寸 base64（新草稿只存引用，不再写它）。 */
  data?: string;
  mimeType: string;
  /** 已上传附件（原图/预览/模型副本）：草稿只存引用，prefs 保持小。 */
  media?: AttachedImageMedia;
  /** 兼容：历史草稿只带原图元数据。 */
  original?: BinaryMessageInput;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
}

/** 服务端草稿存 updatedAt，便于跨端 GC（30 天无更新自动清除）。 */
export interface ServerChatDraft extends ChatDraft {
  updatedAt?: number;
}

const drafts = new Map<string, ChatDraft>();

// 服务端持久化草稿（跨客户端同步）：存储路径 drafts.<key>
import { setServerPref, getServerPref, flushServerPrefs } from "./server-preferences";

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0;
}

function draftKeyPath(key: string): string {
  return `drafts.${key}`;
}

export function getDraft(key: string): ChatDraft | null {
  const draft = drafts.get(key);
  return draft ? cloneDraft(draft) : null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  if (isEmptyDraft(draft)) {
    drafts.delete(key);
    setServerPref(draftKeyPath(key), undefined);
    // 清空/删除立即同步：防抖 400ms 内切会话 + 页面 sync 会把服务端残留拉回复活
    flushServerPrefs();
    return;
  }
  drafts.set(key, cloneDraft(draft));
  const remote: ServerChatDraft = { ...cloneDraft(draft), updatedAt: Date.now() };
  setServerPref(draftKeyPath(key), remote);
}

export function clearDraft(key: string): void {
  drafts.delete(key);
  setServerPref(draftKeyPath(key), undefined);
  // 发送确认后立即同步删除（同上：避免已发送文本残留在服务端、下次 sync 复活）
  flushServerPrefs();
}

/**
 * 发送已受理后才清草稿：空草稿或仍是发出去的那份才删。
 * 用户在等待回执时改了正文、或清空正文后另贴了图，必须留下。
 */
export function forgetDraftIfUnedited(key: string, sentValue: string, sentImageCount = 0): void {
  const draft = getDraft(key);
  if (!draft) {
    clearDraft(key);
    return;
  }
  const textIsNew = draft.value !== "" && draft.value !== sentValue;
  const extraImages = draft.images.length > sentImageCount;
  const newImagesOnEmpty = draft.value === "" && draft.images.length > 0;
  if (textIsNew || extraImages || newImagesOnEmpty) return;
  clearDraft(key);
}

/** 从服务端恢复指定 key 的草稿（网页激活/多客户端同步用）。 */
export function hydrateDraftFromServer(key: string): ChatDraft | null {
  const remote = getServerPref<ChatDraft>(draftKeyPath(key));
  if (!remote || typeof remote !== "object" || Array.isArray(remote)) return null;
  if (typeof remote.value !== "string") return null;
  const images = Array.isArray(remote.images)
    ? remote.images.filter(
        (img): img is ChatDraftImage =>
          typeof img === "object" &&
          img !== null &&
          typeof (img as ChatDraftImage).mimeType === "string" &&
          // 有引用或有内联字节才算有效图；两者都没有的条目无法发送
          Boolean(
            (img as ChatDraftImage).media ||
            (img as ChatDraftImage).original ||
            typeof (img as ChatDraftImage).data === "string",
          ),
      )
    : [];
  const draft: ChatDraft = { value: remote.value, images };
  if (isEmptyDraft(draft)) return null;
  // 回填内存（覆盖本地较旧值：服务端是跨客户端权威）
  drafts.set(key, cloneDraft(draft));
  return draft;
}
