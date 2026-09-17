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
 * 队列条目的媒体引用（issue #42 / A11）。
 *
 * 字节落在附件目录里（见 lib/chat-attachments.ts），条目只持引用：偏好文件保持
 * 小而可读，且不必把 base64 在 prefs/SSE/回执里反复搬运。path 的合法性（附件
 * 目录内的可读常规文件）由 Host 在受理写入时校验，本模块只做结构解码。
 *
 * 一张图有两份副本，各自独立消费：
 * - `model`：安全尺寸副本，投递时回读为内联图片交给 SDK；
 * - `original`：用户上传的原文件，投递时生成二进制消息卡片（下载/预览）。
 */
export type QueuedMediaRole = "model" | "original";

export type QueuedMediaRef = {
  role: QueuedMediaRole;
  path: string;
  name: string;
  mimeType: string;
  size: number;
  /** 仅 role=original：内联预览文件；与原图同一路径时省略。 */
  previewPath?: string;
};

/** 整包写入（`set_follow_up_queue`）的条目载荷：正文 + 该条目的媒体引用。 */
export type QueueItemPayload = {
  text: string;
  media?: QueuedMediaRef[];
  /**
   * 本次**写入尝试**的身份令牌（客户端生成，不复用）。
   *
   * 为什么需要：客户端必须能无歧义地回答「我刚提交的这次写入到底被受理了没」。
   * 正文相等不能当身份（同文两条是两条），而请求失败/超时本身不提供任何信息。
   * Host 把受理过的令牌记进队列状态（`admittedAttemptIds`，与队列同一条记录、
   * 同一次落盘），快照回传后客户端就能精确判定：受理过 → 队列持有它，不得再有人
   * 把它当可重发副本；没受理过 → 从未移交，必须归还草稿。
   */
  attemptId?: string;
  /**
   * 服务端条目身份（客户端从权威快照里抄回来的）。
   *
   * 为什么必须能传：整包写入是「队列应该就是这几条」，而对齐不能让正文充当身份
   * ——同文无图的两条，省略其中一条时按正文 first-fit 会删掉先匹配到的那条，
   * 而不是用户指定的那条（I4）。
   *
   * 命中规则（J2 澄清，实现与注释按实现为准）：
   * - id 命中当前条目 → 就是这一条（正文可被改写，媒体以写载荷为准）；
   * - id 已在途（claimed）→ 忽略该载荷，不重建（重建就是投递第二次）；
   * - id 命中不了 → 这条身份已不在队列里（被投递/被召回/被别的标签页改过），
   *   但**仍按正文 + 附件退回配对**。正文相同就是同一份内容：当成新条目会立刻
   *   多出一条同文条目、被投递两次。身份优先是为了「省略/换序时删对条目」，
   *   不是为了拿陈旧身份制造重复。
   */
  id?: string;
};

/** 令牌上限（防御性边界；超出丢最旧的）。 */
export const MAX_ATTEMPT_IDS = 128;

/** 写入尝试令牌的结构校验（路由/Host 的信任边界共用）。 */
export function parseAttemptId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(trimmed) ? trimmed : null;
}

/** 服务端条目身份的校验（与 attemptId 同为不透明令牌，校验规则一致）。 */
export function parseFollowUpItemId(value: unknown): string | null {
  return parseAttemptId(value);
}

/** 令牌列表清洗（保持顺序、去重、只留最近 MAX_ATTEMPT_IDS 条）。 */
export function normalizeAttemptIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const entry of value) {
    const id = parseAttemptId(entry);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.length > MAX_ATTEMPT_IDS ? ids.slice(ids.length - MAX_ATTEMPT_IDS) : ids;
}

/** 记录一批新受理的令牌（超出上限时丢最旧的）。 */
export function withAdmittedAttemptIds(
  current: readonly string[],
  accepted: readonly (string | undefined)[],
): string[] {
  const ids = [...current];
  for (const entry of accepted) {
    if (!entry || ids.includes(entry)) continue;
    ids.push(entry);
  }
  return ids.length > MAX_ATTEMPT_IDS ? ids.slice(ids.length - MAX_ATTEMPT_IDS) : ids;
}

/**
 * 解码器容忍上限（防御性边界，写入侧另有更严的限额）。
 *
 * 这里**不能截断**：截掉引用会让被截掉的副本变成无人引用的垃圾（甚至被清扫
 * 当成孤儿删掉）。超出上限的条目整条丢弃，由 Host 在受理时拒绝。
 */
export const MAX_QUEUED_ITEM_MEDIA = 32;

export type FollowUpItem = {
  id: string;
  text: string;
  state: FollowUpItemState;
  /** 仅在有媒体时存在；空数组一律不写（保持回执/持久化形状老实）。 */
  media?: QueuedMediaRef[];
  /** 该条目消费过的客户端身份（合并投递会累积多条）。 */
  clientIds?: string[];
};

export function parseQueuedMediaRefs(value: unknown): QueuedMediaRef[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_QUEUED_ITEM_MEDIA) return null;
  const refs: QueuedMediaRef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const role = record.role === "model" || record.role === "original" ? record.role : null;
    const path = typeof record.path === "string" ? record.path.trim() : "";
    const mimeType = typeof record.mimeType === "string" ? record.mimeType.trim() : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const size = record.size;
    const previewPath = typeof record.previewPath === "string" ? record.previewPath.trim() : undefined;
    if (!role || !path || !mimeType || !name) return null;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return null;
    if (record.previewPath !== undefined && !previewPath) return null;
    refs.push({
      role,
      path,
      name,
      mimeType,
      size,
      ...(previewPath && previewPath !== path ? { previewPath } : {}),
    });
  }
  return refs;
}

/** 两份媒体引用是否同一批文件（按路径列表比较；投递/对齐只看文件。） */
export function sameQueuedMedia(
  a: readonly QueuedMediaRef[] | undefined,
  b: readonly QueuedMediaRef[] | undefined,
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((ref, index) => ref.path === right[index].path);
}

export type FollowUpQueueState = {
  items: FollowUpItem[];
  revision: number;
  /**
   * 已受理的写入尝试令牌（最近的在后，上限 MAX_ATTEMPT_IDS）。
   *
   * 与队列**同一条记录、同一次落盘**：受理写入与记录令牌不得出现一个成功、
   * 另一个丢失的窗口——那正是客户端无法判定「我的写入究竟进没进队列」的根源。
   */
  admittedAttemptIds: string[];
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
  media?: readonly QueuedMediaRef[],
): FollowUpItem {
  const item: FollowUpItem = { id: randomId(), text, state };
  if (media?.length) item.media = [...media];
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
  const record = value as { id?: unknown; text?: unknown; state?: unknown; media?: unknown };
  if (typeof record.text !== "string") return null;
  const media = parseQueuedMediaRefs(record.media);
  if (media === null) return null;
  // 纯图条目（正文为空但有图）必须能恢复：旧实现在这里丢掉它，条目的图
  // 随即被清扫——用户排的纯图消息就在刷新/重启后无声消失。
  if (!record.text.trim() && media.length === 0) return null;
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id : legacyItemId(index, record.text),
    text: record.text,
    state: normalizeFollowUpItemState(record.state),
    ...(media.length ? { media } : {}),
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
  const admittedAttemptIds = normalizeAttemptIds(
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as { admittedAttemptIds?: unknown }).admittedAttemptIds
      : undefined,
  );
  if (!Array.isArray(list)) return { items: [], revision, admittedAttemptIds };
  const items: FollowUpItem[] = [];
  for (let index = 0; index < list.length; index++) {
    const item = parseItem(list[index], index);
    if (item) items.push(item);
  }
  return { items, revision, admittedAttemptIds };
}

/** 持久化形状（写入方与恢复扫描共享，避免两边漂移）。 */
export function serializeFollowUpQueue(state: FollowUpQueueState): {
  items: FollowUpItem[];
  revision: number;
  admittedAttemptIds?: string[];
} {
  const admittedAttemptIds = normalizeAttemptIds(state.admittedAttemptIds);
  return {
    items: state.items.map((item) => ({
      id: item.id,
      text: item.text,
      state: item.state,
      ...(item.media?.length ? { media: item.media.map((ref) => ({ ...ref })) } : {}),
    })),
    revision: state.revision,
    ...(admittedAttemptIds.length ? { admittedAttemptIds } : {}),
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
 * 客户端传的是「正文 + 该条目的图片引用 +（它已知的）服务端条目身份」；服务端
 * 优先按身份对齐，其次才是「正文 + 附件」配对，保留未变化条目的 id 与状态，新
 * 出现的正文成为新 `waiting` 条目。不能用 `Set(正文)` 之类做集合运算：期间新
 * 入队的同文条目会被误删，同文两条也会塌成一条身份。
 *
 * 图片处置：写载荷没带图的命中原条目→保留原图（旧客户端/旧回执不得静默丢图）；
 * 带了图的以写载荷为准（校验在 Host 侧）。
 */
export function reconcileFollowUpItems(
  current: readonly FollowUpItem[],
  payloads: readonly QueueItemPayload[],
  options?: { inFlightIds?: readonly string[] },
): FollowUpItem[] {
  const inFlight = new Set(options?.inFlightIds ?? []);
  const used = new Array<boolean>(current.length).fill(false);
  // 第一遍只认身份：客户端指明的那条就是它，哪怕同文还有别的条目。
  const byId = new Map<string, number>();
  current.forEach((item, index) => {
    if (!byId.has(item.id)) byId.set(item.id, index);
  });
  const next: FollowUpItem[] = [];
  for (const payload of payloads) {
    // 身份已在途：忽略而不是重建（重建就是把它投递第二次）。
    if (payload.id !== undefined && inFlight.has(payload.id)) continue;
    const declared = payload.id === undefined ? undefined : byId.get(payload.id);
    if (declared !== undefined && !used[declared]) {
      used[declared] = true;
      const existing = current[declared];
      const media = payload.media?.length ? payload.media : existing.media;
      next.push({
        id: existing.id,
        text: payload.text,
        state: existing.state,
        ...(media?.length ? { media: [...media] } : {}),
      });
      continue;
    }
    let match = -1;
    for (let index = 0; index < current.length; index++) {
      const candidate = current[index];
      if (used[index] || candidate.text !== payload.text) continue;
      // 同文的多个条目：优先命中媒体也一致的那个，否则同文两条会互换附件。
      if (sameQueuedMedia(candidate.media, payload.media)) {
        match = index;
        break;
      }
      if (match < 0) match = index;
    }
    if (match >= 0) {
      used[match] = true;
      const existing = current[match];
      const media = payload.media?.length ? payload.media : existing.media;
      next.push({
        id: existing.id,
        text: payload.text,
        state: existing.state,
        ...(media?.length ? { media: [...media] } : {}),
      });
      continue;
    }
    next.push(payload.media?.length
      ? newFollowUpItem(payload.text, "waiting", payload.media)
      : newFollowUpItem(payload.text, "waiting"));
  }
  return next;
}

/** 多条条目合并为一条投递载荷（整队转引导/自动投递）：正文与媒体都要带上。 */
export function mergeFollowUpPayload(
  items: readonly FollowUpItem[],
  extra?: string,
): { text: string; media: QueuedMediaRef[] } {
  const texts = [...followUpItemTexts(items), ...(extra?.trim() ? [extra.trim()] : [])]
    .map((text) => text.trim())
    .filter((text) => text.length > 0);
  return { text: texts.join("\n"), media: followUpItemMedia(items) };
}

/** 条目媒体按顺序摊平（投递时按 role 分别交给 SDK 与二进制卡片）。 */
export function followUpItemMedia(items: readonly FollowUpItem[]): QueuedMediaRef[] {
  return items.flatMap((item) => item.media ?? []);
}
