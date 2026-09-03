export interface ChatDraftImage {
  data: string;
  mimeType: string;
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
import { setServerPref, getServerPref } from "./server-preferences";

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
    return;
  }
  drafts.set(key, cloneDraft(draft));
  const remote: ServerChatDraft = { ...cloneDraft(draft), updatedAt: Date.now() };
  setServerPref(draftKeyPath(key), remote);
}

export function clearDraft(key: string): void {
  drafts.delete(key);
  setServerPref(draftKeyPath(key), undefined);
}

/** 从服务端恢复指定 key 的草稿（网页激活/多客户端同步用）。 */
export function hydrateDraftFromServer(key: string): ChatDraft | null {
  const remote = getServerPref<ChatDraft>(draftKeyPath(key));
  if (!remote || typeof remote !== "object" || Array.isArray(remote)) return null;
  if (typeof remote.value !== "string") return null;
  const images = Array.isArray(remote.images)
    ? remote.images.filter(
        (img): img is ChatDraftImage =>
          typeof img === "object" && img !== null && typeof (img as ChatDraftImage).data === "string",
      )
    : [];
  const draft: ChatDraft = { value: remote.value, images };
  if (isEmptyDraft(draft)) return null;
  // 回填内存（覆盖本地较旧值：服务端是跨客户端权威）
  drafts.set(key, cloneDraft(draft));
  return draft;
}
