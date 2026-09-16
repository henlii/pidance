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

export type FollowUpItem = {
  id: string;
  text: string;
  state: FollowUpItemState;
};

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

export function newFollowUpItem(text: string, state: FollowUpItemState = "waiting"): FollowUpItem {
  return { id: randomId(), text, state };
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
  const record = value as { id?: unknown; text?: unknown; state?: unknown };
  if (typeof record.text !== "string" || !record.text.trim()) return null;
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id : legacyItemId(index, record.text),
    text: record.text,
    state: normalizeFollowUpItemState(record.state),
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
    items: state.items.map((item) => ({ id: item.id, text: item.text, state: item.state })),
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
 * 客户端只传正文数组（它没有服务端条目身份）；服务端按「正文 + 出现顺序」与当前
 * 条目对齐，保留未变化条目的 id 与状态，新出现的正文成为新 `waiting` 条目。
 * 不能用 `Set(正文)` 之类做集合运算：期间新入队的同文条目会被误删，同文两条也
 * 会塌成一条身份。
 */
export function reconcileFollowUpItems(
  current: readonly FollowUpItem[],
  texts: readonly string[],
): FollowUpItem[] {
  const used = new Array<boolean>(current.length).fill(false);
  const next: FollowUpItem[] = [];
  for (const text of texts) {
    let match = -1;
    for (let index = 0; index < current.length; index++) {
      if (!used[index] && current[index].text === text) {
        match = index;
        break;
      }
    }
    if (match >= 0) {
      used[match] = true;
      next.push(current[match]);
    } else {
      next.push(newFollowUpItem(text, "waiting"));
    }
  }
  return next;
}
