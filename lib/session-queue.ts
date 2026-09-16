/**
 * follow-up 队列的持久化格式（唯一解码器）。
 *
 * 为什么单独成模块：写入方（SdkSessionHost）与启动恢复扫描（LiveSessionRegistry）
 * 必须使用同一套判定。之前两边各写一份，写入格式升级成 `{items, revision}` 后
 * 恢复扫描仍只认数组，于是重启后当前格式的队列**不会被恢复投递**（静默失效）。
 * 独立模块同时避免 host 与 registry 互相 import 形成环。
 *
 * 条目身份：每个条目有稳定 id 与状态，id 进入持久化与客户端快照。
 * 正文不能充当身份——同文两条必须是两个条目，投递回执按 id 确认。
 *
 * 状态：
 * - `waiting`：待投递，可被清队/取回/自动 flush 消费；
 * - `claimed`：已提交给 Pi SDK、尚未拿到受理结果。普通清队/取回不得把它当取消成功；
 * - `unknown`：跨越重启或持久化失败后的结果未知项，**绝不自动重投**，由用户显式清队。
 *
 * 格式：
 * - 旧格式（字符串数组或 `{items: string[], revision}`）：条目无 id，按内容确定性
 *   派生 id（同一份内容重复解码得到同一 id，不以每次读取随机生成）；
 * - 当前格式：`{ items: {id,text,state}[], revision: number }`；
 * - 其他/损坏：按空队列处理，不抛错（启动恢复不能因一条坏记录失败）。
 */

export type FollowUpItemState = "waiting" | "claimed" | "unknown";

/**
 * 队列条目携带的图片引用（issue #42 / A11）。
 *
 * 字节落在产品自己的 outbox 目录里（见 lib/chat-attachments.ts），条目只持引用：
 * 偏好文件保持小而可读，且不必把 base64 在 prefs/SSE/回执里反复搬运。path 的
 * 合法性（属于本会话 outbox）由 Host 在受理写入时校验，本模块只做结构解码。
 */
export type QueuedImageRef = {
  /** 稳定身份 = 落盘文件名；客户端回传时按它复现同一份字节。 */
  id: string;
  path: string;
  mimeType: string;
  name: string;
};

/** 解码器容忍上限：超出部分丢弃（防御性边界，写入侧另有拒绝）。 */
export const MAX_QUEUED_ITEM_IMAGES = 16;

export type FollowUpItem = {
  id: string;
  text: string;
  state: FollowUpItemState;
  /** 仅在有图时存在；空数组一律不写（保持回执/持久化形状老实）。 */
  images?: QueuedImageRef[];
};

export function parseQueuedImageRefs(value: unknown): QueuedImageRef[] {
  if (!Array.isArray(value)) return [];
  const refs: QueuedImageRef[] = [];
  for (const entry of value) {
    if (refs.length >= MAX_QUEUED_ITEM_IMAGES) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path.trim() : "";
    const mimeType = typeof record.mimeType === "string" ? record.mimeType.trim() : "";
    if (!path || !mimeType.startsWith("image/")) continue;
    const fallbackId = path.split("/").pop() ?? "";
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : fallbackId;
    if (!id) continue;
    const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : id;
    refs.push({ id, path, mimeType, name });
  }
  return refs;
}

/** 两份引用的身份是否一致（id 即落盘名，不需要比 path）。 */
export function sameQueuedImages(
  a: readonly QueuedImageRef[] | undefined,
  b: readonly QueuedImageRef[] | undefined,
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((ref, index) => ref.id === right[index].id);
}

export type FollowUpQueueState = {
  items: FollowUpItem[];
  revision: number;
};

/**
 * 解码任意条目列表（回执 / state / prefs 共用）：字符串按旧格式派生确定性 id，
 * 对象保留 id 与状态。损坏项丢开。
 */
export function normalizeFollowUpItemList(value: unknown): FollowUpItem[] {
  return parseFollowUpQueue(Array.isArray(value) ? value : []).items;
}

/** 队列条目的唯一清洗入口：只保留非空字符串。 */
export function normalizeFollowUpItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
}

export function normalizeFollowUpItemState(value: unknown): FollowUpItemState {
  return value === "claimed" || value === "unknown" ? value : "waiting";
}

function randomId(): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function newFollowUpItem(
  text: string,
  state: FollowUpItemState = "waiting",
  images?: readonly QueuedImageRef[],
): FollowUpItem {
  const item: FollowUpItem = { id: randomId(), text, state };
  if (images?.length) item.images = [...images];
  return item;
}

/**
 * 旧格式条目的 id：由「序号 + 正文」确定性派生。
 *
 * 旧数据没有 id，随机生成会让每次解码得到不同身份。确定性派生保证同一份旧队列
 * 每次解码出同一个 id，不依赖「解码后立刻持久化」这一额外前提。
 */
function legacyItemId(index: number, text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return `legacy-${index}-${hash.toString(36)}`;
}

function parseItem(value: unknown, index: number): FollowUpItem | null {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? { id: legacyItemId(index, value), text, state: "waiting" } : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { id?: unknown; text?: unknown; state?: unknown; images?: unknown };
  if (typeof record.text !== "string" || !record.text.trim()) return null;
  const images = parseQueuedImageRefs(record.images);
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id : legacyItemId(index, record.text),
    text: record.text,
    state: normalizeFollowUpItemState(record.state),
    ...(images.length ? { images } : {}),
  };
}

export function parseFollowUpQueue(raw: unknown): FollowUpQueueState {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? (raw as { items?: unknown }).items
      : undefined;
  const revision = raw && typeof raw === "object" && !Array.isArray(raw)
    && typeof (raw as { revision?: unknown }).revision === "number"
    && Number.isFinite((raw as { revision: number }).revision)
    ? (raw as { revision: number }).revision
    : 0;
  if (!Array.isArray(list)) return { items: [], revision };
  const items: FollowUpItem[] = [];
  for (let index = 0; index < list.length; index++) {
    const item = parseItem(list[index], index);
    if (item) items.push(item);
  }
  return { items, revision };
}

/** 持久化形状（写入方与恢复扫描共享，避免两边漂移）。 */
export function serializeFollowUpQueue(state: FollowUpQueueState): {
  items: FollowUpItem[];
  revision: number;
} {
  return {
    items: state.items.map((item) => ({
      id: item.id,
      text: item.text,
      state: item.state,
      ...(item.images?.length ? { images: item.images.map((ref) => ({ ...ref })) } : {}),
    })),
    revision: state.revision,
  };
}

/** 是否还有待投递内容（启动恢复据此决定要不要拉起 host）。 */
export function hasQueuedFollowUp(raw: unknown): boolean {
  return parseFollowUpQueue(raw).items.length > 0;
}

export function followUpItemTexts(items: readonly FollowUpItem[]): string[] {
  return items.map((item) => item.text);
}

/**
 * 整包写入（`set_follow_up_queue`）与当前条目的对齐。
 *
 * 客户端传的是「正文 + 该条目的图片引用」（它没有服务端条目身份）；服务端按
 * 「正文 + 出现顺序」与当前条目对齐，保留未变化条目的 id 与状态，新出现的正文
 * 成为新 `waiting` 条目。不能用 `Set(正文)` 之类做集合运算：期间新入队的同文
 * 条目会被误删，同文两条也会塌成一条身份。
 *
 * 图片处置：写载荷没带图的命中原条目→保留原图（旧客户端/旧回执不得静默丢图）；
 * 带了图的以写载荷为准（校验在 Host 侧）。
 */
export function reconcileFollowUpItems(
  current: readonly FollowUpItem[],
  payloads: readonly { text: string; images?: readonly QueuedImageRef[] }[],
): FollowUpItem[] {
  const used = new Array<boolean>(current.length).fill(false);
  const next: FollowUpItem[] = [];
  for (const payload of payloads) {
    let match = -1;
    for (let index = 0; index < current.length; index++) {
      const candidate = current[index];
      if (used[index] || candidate.text !== payload.text) continue;
      // 同文的多个条目：优先命中图片也一致的那个，否则同文两条会互换图片。
      if (sameQueuedImages(candidate.images, payload.images)) {
        match = index;
        break;
      }
      if (match < 0) match = index;
    }
    if (match >= 0) {
      used[match] = true;
      const existing = current[match];
      const images = payload.images?.length ? payload.images : existing.images;
      next.push({
        id: existing.id,
        text: payload.text,
        state: existing.state,
        ...(images?.length ? { images: [...images] } : {}),
      });
      continue;
    }
    next.push(payload.images?.length
      ? newFollowUpItem(payload.text, "waiting", payload.images)
      : newFollowUpItem(payload.text, "waiting"));
  }
  return next;
}

/** 多条条目合并为一条投递载荷（整队转引导/自动投递）：正文与图片都要带上。 */
export function mergeFollowUpPayload(
  items: readonly FollowUpItem[],
  extra?: string,
): { text: string; images: QueuedImageRef[] } {
  const texts = [...followUpItemTexts(items), ...(extra?.trim() ? [extra.trim()] : [])]
    .map((text) => text.trim())
    .filter((text) => text.length > 0);
  return { text: texts.join("\n"), images: followUpItemImages(items) };
}

/** 条目图片按顺序摊平（投递时与正文一同交给 SDK）。 */
export function followUpItemImages(items: readonly FollowUpItem[]): QueuedImageRef[] {
  return items.flatMap((item) => item.images ?? []);
}
