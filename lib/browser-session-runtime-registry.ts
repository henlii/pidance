/**
 * Page-level owner of per-session submit, EventStreamManager, run token, and
 * live timeline. ChatWindow unmount only detaches the view; it cannot cancel POST.
 */

import { setDraft } from "./draft-store";
import { promptImageInputs } from "./attachment-upload";
import {
  createEventStreamManager,
  type AgentStreamEvent,
  type EventSourceLike,
  type EventStreamManager,
  type TimerHandle,
} from "./event-stream-manager";
import { pendingSessionId } from "./new-session-intent";
import type { PromptReceipt } from "./agent-commands";
import { generateSubmissionId } from "./agent-commands";
import type { FollowUpItem } from "./session-queue";
import { attachCustomRenderedLines } from "./custom-rendered-lines";
import { normalizeToolCalls } from "./normalize";
import { PIDANCE_BINARY_CUSTOM_TYPE, parseBinaryMessageData } from "./message-binary";
import { shouldFinishFromReconcile } from "./finish-agent-run";
import {
  appendRecord,
  confirmUserMessage,
  dropAllPendingRecords,
  dropPendingRecord,
  findRecord,
  mergeTailRecords,
  optimisticRecord,
  prependOlderRecords,
  retainPendingRecords,
  submissionKey,
  timelineEntryIds,
  timelineFromDisk,
  timelineMessages,
  type TimelineRecord,
} from "./session-timeline";
import type { AgentMessage, AttachedImage, BinaryMessageData, BinaryMessageInput } from "./types";

export type SubmissionStatus = "submitting" | "accepted" | "persisted" | "rejected" | "unknown";

export type PromptSubmission = {
  submissionId: string;
  sessionId: string;
  draftKey: string;
  message: string;
  images?: AttachedImage[];
  binaryBlocks?: BinaryMessageInput[];
  status: SubmissionStatus;
  /** 是否已观察到服务端对该 user 消息的确认（事件或磁盘对账）。
   *  失败清理、返回结果与草稿恢复都必须受它约束：已投递的消息不得因迟到的
   *  HTTP 错误被抹掉或把文本弹回输入框。 */
  delivered: boolean;
  /** persisted 时对应 Pi JSONL user entry id；未确认前为 null */
  entryId?: string | null;
  error?: string;
};

export type StreamSnapshot = {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
};

export type PendingBash = {
  command: string;
  excludeFromContext: boolean;
  startedAt: number;
};

/**
 * 一轮 run 的延迟与解码吞吐读数。
 *
 * **服务端是唯一计算方**（`lib/sdk-session-host.ts` 的 accumulateTurnMetrics /
 * projectTurnMetrics）：口径与 dsh 的 `turn-metrics`（已核对
 * `@deepseek-ai/dsh-client-ui-conversation@0.0.1-rc.1` 实现）一致 ——
 * 每个 step 的 decodeMs 是「首 token → 消息结束」不含 TTFT；只用 provider 上报的
 * output tokens；只累计两者齐全的 step，按解码时间加权（Σtokens/ΣdecodeMs）。
 *
 * 本模块只**接收与渲染**读数，两条来源：
 * - SSE 事件携带的 `turnMetrics`（host 在 TTFT 首帧与每个 step 结束时下发）；
 * - 冷挂载/重连时 `get_state` 的兜底读数（seedTurnMetrics）。
 * 客户端不再自行累计（此前是双份实现，口径容易漂移）。
 */
export type TurnMetrics = {
  /** 本轮 agent_start → 首个内容帧，毫秒。 */
  ttftMs?: number;
  /** 本轮 provider 上报 output tokens / 解码总耗时。 */
  tokensPerSecond?: number;
};

export type SessionRuntimeSnapshot = {
  sessionId: string;
  messages: AgentMessage[];
  entryIds: string[];
  /** 与 messages 平行的稳定记录 key，供 React 列表用；不随下标平移而变。 */
  messageKeys: string[];
  streamState: StreamSnapshot;
  agentRunning: boolean;
  /** 最近一轮 run 的延迟/吞吐读数；run 结束后保留供展示。 */
  turnMetrics: TurnMetrics;
  /** bash 运行态与 registry 的运行态同一快照发布，避免第三套状态机。 */
  bashRunning: boolean;
  pendingBash: PendingBash | null;
  sendInFlight: boolean;
  submissions: PromptSubmission[];
  promptRunId: number;
  /** 当前 run 的异步 finish claim；由 registry 而非视图 hook 持有。 */
  finishingRunId: number | null;
  /** 最近一个已收到 agent_end/prompt_done 的 run。 */
  completedRunId: number | null;
  /** 服务端在事件上带的本轮 run 序号（见 hosting 侧 handleSessionEvent）：
   * 用来丢弃迟到的上一轮终止事件，避免把新一轮运行中的 UI 判成空闲。 */
  streamRunSeq: number | null;
  attachCount: number;
  /** 消息 timeline 版本：仅当 messages/streaming 内容变化时递增；
   * connected/agent_start 等运行态事件不递增，避免阻塞初始磁盘 hydrate。 */
  timelineSeq: number;
};

/** hydrate 的归并方式：整体替换 / prepend 更旧页 / 同会话尾页重载。 */
export type TimelineHydrateMode = "replace" | "prepend" | "tail";

/** hydrate 结果：见 `hydrate` 的接口注释。 */
export type HydrateOutcome = "applied" | "stale" | "superseded";

export type RuntimeAgentState = {
  live?: boolean;
  running?: boolean;
  activeRun?: boolean;
  lockedByOther?: boolean;
  state?: {
    isStreaming?: boolean;
    isPromptRunning?: boolean;
    isCompacting?: boolean;
    [key: string]: unknown;
  };
};

export type RuntimeReconcileResult = {
  runId: number;
  stale: boolean;
  live: boolean;
  shouldFinish: boolean;
  state?: RuntimeAgentState["state"];
};

export type SubmitPromptTarget =
  | { kind: "persisted"; sessionId: string }
  | { kind: "new"; intentId: string; cwd: string };

export type SubmitPromptInput = {
  target: SubmitPromptTarget;
  submissionId?: string;
  message: string;
  images?: AttachedImage[];
  binaryBlocks?: BinaryMessageInput[];
  draftKey: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
};

export type SubmitPromptResult = {
  submissionId: string;
  sessionId: string;
  status: "accepted" | "rejected" | "unknown" | "queued";
  error?: string;
  /** status = queued：服务端权威队列快照（乐观气泡改为队列面板表现）。 */
  queue?: { items: FollowUpItem[]; revision: number; inFlight: string[] };
};

export type BrowserSessionRuntimeRegistryDeps = {
  postPrompt: (
    sessionId: string,
    input: {
      message: string;
      images?: AttachedImage[];
      binaryBlocks?: BinaryMessageInput[];
      submissionId: string;
      signal?: AbortSignal;
    },
  ) => Promise<PromptReceipt>;
  ensureNewSession?: (
    cwd: string,
    extras?: { provider?: string; modelId?: string },
  ) => Promise<string>;
  /** 一步创建并发送（避免 ensure→wake→prompt 两跳：无文件 404 / 双行 / 闪）。 */
  createAndPrompt?: (cwd: string, input: {
    message: string;
    images?: AttachedImage[];
    binaryBlocks?: BinaryMessageInput[];
    submissionId: string;
    provider?: string;
    modelId?: string;
    thinkingLevel?: string;
    signal?: AbortSignal;
  }) => Promise<{ sessionId: string; receipt: PromptReceipt }>;
  wake?: (sessionId: string, signal?: AbortSignal) => Promise<void>;
  createEventStream?: (sessionId: string, onEvent: (event: AgentStreamEvent) => void) => EventStreamManager;
  getAgentState?: (sessionId: string) => Promise<RuntimeAgentState>;
  /**
   * 按 submissionId 发显式取消（服务端提交事务）。
   * 与本地 AbortSignal 分开：取消 fetch 不等于后端停止。
   */
  cancelSubmission?: (submissionId: string) => Promise<{ status: "pending" | "confirmed" }>;
  restoreDraft?: (draftKey: string, draft: { value: string; images: AttachedImage[] }) => void;
  now?: () => number;
  makeSubmissionId?: () => string;
  /** slot 空闲 SSE 关闭定时器（测试注入；生产 setTimeout/clearTimeout） */
  schedule?: (fn: () => void, ms: number) => TimerHandle;
  clearSchedule?: (id: TimerHandle) => void;
};

export type RegistrySubscription = {
  sessionId: string;
  dispose: () => void;
};

export type SubmitPromptCancellation = {
  submissionId: string;
  cancel: () => void;
  signal: AbortSignal;
};

type RuntimeSlot = {
  sessionId: string;
  snapshot: SessionRuntimeSnapshot;
  submissions: Map<string, PromptSubmission>;
  /** in-flight POST per submissionId（单飞）；结算后从 map 移除 */
  inFlight: Map<string, Promise<SubmitPromptResult>>;
  /** submissionId → AbortController（Stop 用） */
  promptAborts: Map<string, AbortController>;
  eventStream: EventStreamManager | null;
  /**
   * 视图附件。每个 attach 产生一个 token，dispose 只删自己的 token。
   *
   * 用集合而不是计数器：别名/pending id 并存时，计数一旦失配就会永久停在 >0，
   * 于是「无人观看」永远不成立 → 空闲不收流 → 服务端 host 不 dispose →
   * **writer 租约不释放**，另一实例（31415）就打不开这个会话。
   * 集合天然幂等，dispose 重复调用或找不到 slot 都不会漏减。
   */
  attachments: Set<ViewAttachment>;
  /** 由 attachments 派生（见 syncViewDerived）：不是独立状态。 */
  viewHandlers: Set<(event: AgentStreamEvent) => void>;
  snapshotListeners: Set<(snapshot: SessionRuntimeSnapshot) => void>;
  consumedEntryIds: Set<string>;
  /** 消息时间线；`snapshot.messages/entryIds` 是它的只读派生投影。 */
  timeline: TimelineRecord[];
  /** timeline 派生数组缓存：仅在 timeline 引用变化时重建，
   *  避免运行态/流式帧 publish 也换掉 messages 身份（触发多余重渲染与滚动 effects）。 */
  derived: {
    source: TimelineRecord[] | null;
    messages: AgentMessage[];
    entryIds: string[];
    messageKeys: string[];
  };
  /** submissionId → 乐观记录的稳定 key（不存数组下标，避免 hydrate/prepend 后错位）。 */
  submissionKeys: Map<string, string>;
  /** 无 entryId 记录（引导投递、外部追加）的 key 序号。 */
  localKeySeq: number;
  /** slot-owned hydrate 请求（按发起序）的单调号 */
  hydrateSeq: number;
  /** 最近一次已应用 hydrate 的请求号 */
  hydrateAppliedSeq: number;
  /** 无视图且空闲时延迟关闭 SSE 的兜底定时器 */
  idleCloseTimer: TimerHandle | null;
  /** SSE 确连失败后的有限重试：当前定时器与已用次数 */
  sseRetryTimer: TimerHandle | null;
  sseRetryAttempt: number;
  /** 本轮 run 的吞吐累积（见 TurnMetrics 注释）。 */
  /** 服务端下发的当前读数（客户端只渲染，不累计） */
  metrics: TurnMetrics;
};

/** 视图附件 token：dispose 的身份，与 sessionId 解耦。 */
type ViewAttachment = {
  onEvent: ((event: AgentStreamEvent) => void) | undefined;
};

/** slot 空闲 SSE 关闭兜底窗口：切走后留一小段时间给快速切回，随后释放服务端 host。 */
export const IDLE_SSE_CLOSE_DELAY_MS = 5_000;

/** 显式取消请求的上限：Stop 不得被不响应的服务端拖死（超时即未知）。 */
export const CANCEL_SUBMISSION_TIMEOUT_MS = 5_000;

export type BrowserSessionRuntimeRegistry = {
  getSnapshot(sessionId: string): SessionRuntimeSnapshot | null;
  subscribe(sessionId: string, listener: (snapshot: SessionRuntimeSnapshot) => void): () => void;
  attach(sessionId: string, onEvent?: (event: AgentStreamEvent) => void): RegistrySubscription;
  detach(sessionId: string, subscription: RegistrySubscription): void;
  submitPrompt(input: SubmitPromptInput): Promise<SubmitPromptResult>;
  /** 绑定当前 submissions 的取消槽位；cancel 只取消一个 submission */
  cancellationFor(sessionId: string): SubmitPromptCancellation | null;
  /** 显式 Stop：取消唯一在途 submission 的 POST 并等待结算 */
  abortSubmission(sessionId: string, submissionId?: string): Promise<SubmitPromptResult | null>;
  abort(sessionId: string): void;
  /** bash 运行态（含 pending 命令）；与 run 态同一 owner。 */
  setBashRunning(sessionId: string, running: boolean, pending?: PendingBash | null): void;
  /** 当前 per-session run 状态；视图只读此 snapshot，不维护 sendInFlight 单槽。 */
  getRunState(sessionId: string): Pick<SessionRuntimeSnapshot, "promptRunId" | "agentRunning" | "sendInFlight" | "finishingRunId" | "completedRunId"> | null;
  beginRunFinish(sessionId: string, runId: number): boolean;
  releaseRunFinish(sessionId: string, runId: number): void;
  completeRun(sessionId: string, runId: number): boolean;
  reconcile(sessionId: string): Promise<RuntimeReconcileResult | null>;
  /** 在 HTTP context 发起前取得 slot-owned 请求代数。 */
  beginHydrate(sessionId: string): number;
  /**
   * - `superseded`：更新的响应已落地，本次响应整体作废。
   * - `stale`：期间有 live 事件，时间线不得覆盖；但响应仍是最新磁盘读取，
   *   调用方应继续提交 leaf/model/分页等会话级状态。
   * - `applied`：时间线已按本次响应更新。
   */
  hydrate(
    sessionId: string,
    messages: AgentMessage[],
    entryIds?: string[],
    options?: { sinceSeq?: number; hydrateRequestSeq?: number; mode?: TimelineHydrateMode },
  ): HydrateOutcome;
  /**
   * 追加本地乐观消息（引导/合并队列）。返回生成的稳定 key，后续用它原子回滚，
   * 不依赖数组下标，也不依赖正文（同文两条引导必须能各自回滚）。
   */
  appendLocal(sessionId: string, message: AgentMessage): string;
  /** 按 key 移除尚无交付证据的本地记录；返回是否真的移除（已确认的不动）。 */
  dropLocal(sessionId: string, key: string): boolean;
  applyEvent(sessionId: string, event: AgentStreamEvent): void;
  ensureEventsConnected(sessionId: string): void;
  getEventSource(sessionId: string): EventSourceLike | null;
  getSubmission(sessionId: string, submissionId: string): PromptSubmission | undefined;
  /** 冷挂载/刷新时把服务端已在跑的 run 导入 slot（防止 reconcile 误收尾、发送被拒）。 */
  importRunningRun(sessionId: string, startedAt?: number): void;
  /** 冷挂载/刷新时用服务端读数兜底本 run 的吞吐（本地采样后自动失效）。 */
  seedTurnMetrics(sessionId: string, metrics: TurnMetrics | null): void;
  /** 测试用：重置单例 */
  resetForTests(): void;
  /** 测试用：当前 slot 数量与各 slot 的会话 id（验证回收） */
  debugSlotCount(): number;
  debugSlotIds(): string[];
};

function emptyStream(): StreamSnapshot {
  return { isStreaming: false, streamingMessage: null };
}

function createSlot(sessionId: string): RuntimeSlot {
  return {
    sessionId,
    snapshot: {
      sessionId,
      messages: [],
      entryIds: [],
      messageKeys: [],
      streamState: emptyStream(),
      agentRunning: false,
      turnMetrics: {},
      bashRunning: false,
      pendingBash: null,
      sendInFlight: false,
      submissions: [],
      promptRunId: 0,
      finishingRunId: null,
      completedRunId: null,
      streamRunSeq: null,
      attachCount: 0,
      timelineSeq: 0,
    },
    submissions: new Map(),
    inFlight: new Map(),
    promptAborts: new Map(),
    eventStream: null,
    attachments: new Set(),
    viewHandlers: new Set(),
    snapshotListeners: new Set(),
    consumedEntryIds: new Set(),
    timeline: [],
    derived: { source: null, messages: [], entryIds: [], messageKeys: [] },
    submissionKeys: new Map(),
    localKeySeq: 0,
    hydrateSeq: 0,
    hydrateAppliedSeq: 0,
    idleCloseTimer: null,
    sseRetryTimer: null,
    sseRetryAttempt: 0,
    metrics: {},
  };
}

function userMessageFromSubmit(
  message: string,
  images: AttachedImage[] | undefined,
  binaryBlocks: BinaryMessageInput[] | undefined,
  now: number,
): AgentMessage {
  const imageBlocks = images?.map((img) => ({
    type: "image" as const,
    source: { type: "base64" as const, media_type: img.mimeType, data: img.data },
  }));
  const projected: AgentMessage & { binaryBlocks?: BinaryMessageData[] } = {
    role: "user",
    content: imageBlocks?.length
      ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
      : message,
    timestamp: now,
  };
  if (binaryBlocks?.length) {
    projected.binaryBlocks = binaryBlocks.map((block) => ({
      type: "binary",
      version: 1,
      kind: block.mimeType.toLowerCase().startsWith("image/")
        ? "image"
        : block.mimeType.toLowerCase().startsWith("audio/")
          ? "audio"
          : block.mimeType.toLowerCase().startsWith("video/")
            ? "video"
            : "file",
      ...block,
    }));
  }
  return projected;
}

export function hashMessageIdentity(message: string, images: AttachedImage[] | undefined): string {
  const imageSig = (images ?? [])
    .map((img) => `${img.mimeType}:${img.data}`)
    .join("|");
  return `${message}\x1f${imageSig}`;
}

function defaultRestoreDraft(draftKey: string, draft: { value: string; images: AttachedImage[] }): void {
  setDraft(draftKey, { value: draft.value, images: draft.images });
}

export function createBrowserSessionRuntimeRegistry(
  deps: BrowserSessionRuntimeRegistryDeps,
): BrowserSessionRuntimeRegistry {
  const restoreDraft = deps.restoreDraft ?? defaultRestoreDraft;
  const now = deps.now ?? (() => Date.now());
  const makeSubmissionId = deps.makeSubmissionId ?? generateSubmissionId;
  const schedule: (fn: () => void, ms: number) => TimerHandle = deps.schedule
    ?? ((fn, ms) => setTimeout(fn, ms));
  const clearSchedule: (id: TimerHandle) => void = deps.clearSchedule
    ?? ((id) => clearTimeout(id));
  const slots = new Map<string, RuntimeSlot>();
  /**
   * 别名 → 规范 id（new 会话 promote 后，pending id 仍要能命中同一 slot）。
   * 只登记映射、不复制 slots 键：否则同一 slot 会有两个键，两边各自 attach
   * 都会累加，而 dispose 顺序一乱就会漏减。
   */
  const aliases = new Map<string, string>();

  const getSlot = (sessionId: string, create: boolean): RuntimeSlot | null => {
    const existing = slots.get(sessionId);
    if (existing) return existing;
    const canonical = aliases.get(sessionId);
    if (canonical !== undefined) {
      const slot = slots.get(canonical);
      if (slot) return slot;
      // 目标已不在：别名失效，顺手清理，避免长期指向空。
      aliases.delete(sessionId);
    }
    if (!create) return null;
    const slot = createSlot(sessionId);
    slots.set(sessionId, slot);
    return slot;
  };

  /** 附件变化后重算派生值：viewHandlers 与「是否有人观看」都只看 attachments。 */
  const syncViewDerived = (slot: RuntimeSlot): void => {
    const handlers = new Set<(event: AgentStreamEvent) => void>();
    for (const attachment of slot.attachments) {
      if (attachment.onEvent) handlers.add(attachment.onEvent);
    }
    slot.viewHandlers = handlers;
  };

  const hasViewers = (slot: RuntimeSlot): boolean => slot.attachments.size > 0;

  const publish = (slot: RuntimeSlot) => {
    // messages/entryIds/messageKeys 是 timeline 的派生投影：永远平行，且只在这一处产出。
    // timeline 的每次变更都换新数组引用，所以按引用缓存即可。
    if (slot.derived.source !== slot.timeline) {
      slot.derived = {
        source: slot.timeline,
        messages: timelineMessages(slot.timeline),
        entryIds: timelineEntryIds(slot.timeline),
        messageKeys: slot.timeline.map((record) => record.key),
      };
    }
    slot.snapshot = {
      ...slot.snapshot,
      sessionId: slot.sessionId,
      messages: slot.derived.messages,
      entryIds: slot.derived.entryIds,
      messageKeys: slot.derived.messageKeys,
      turnMetrics: { ...slot.metrics },
      submissions: [...slot.submissions.values()],
      attachCount: slot.attachments.size,
    };
    for (const listener of slot.snapshotListeners) listener(slot.snapshot);
  };

  /**
   * SSE 生命周期对齐服务端 host 保活语义：视图挂载或 run 进行中才保持连接；
   * 切走后无人观看且空闲的会话关闭 SSE，让服务端 idle dispose 释放 writer 租约，
   * 另一实例（31415/31416）才能打开同一会话。挂载/新 run 会重连（connectEvents）。
   */
  const closeIdleEventStream = (slot: RuntimeSlot) => {
    if (slot.idleCloseTimer) {
      clearSchedule(slot.idleCloseTimer);
      slot.idleCloseTimer = null;
    }
    if (slot.sseRetryTimer) {
      clearSchedule(slot.sseRetryTimer);
      slot.sseRetryTimer = null;
      slot.sseRetryAttempt = 0;
    }
    if (hasViewers(slot)) return;
    if (
      slot.snapshot.agentRunning
      || slot.snapshot.bashRunning
      || slot.snapshot.sendInFlight
      || slot.inFlight.size > 0
    ) return;
    const manager = slot.eventStream;
    if (!manager) return;
    slot.eventStream = null;
    manager.close();
    publish(slot);
  };

  const scheduleIdleEventStreamClose = (slot: RuntimeSlot) => {
    if (slot.idleCloseTimer) {
      clearSchedule(slot.idleCloseTimer);
      slot.idleCloseTimer = null;
    }
    if (hasViewers(slot)) return;
    if (
      slot.snapshot.agentRunning
      || slot.snapshot.bashRunning
      || slot.snapshot.sendInFlight
      || slot.inFlight.size > 0
    ) return;
    // 不要求 eventStream 存在：流可能在上一个空闲窗口已关闭，但 slot 仍需要
    // 在窗口到期时被回收（#35）。closeIdleEventStream 对空 manager 安全返回。
    slot.idleCloseTimer = schedule(() => {
      slot.idleCloseTimer = null;
      closeIdleEventStream(slot);
      // 同一空闲窗口到期后一并回收可丢弃的 slot（#35）：只在无人看、
      // 无在途提交、无未落盘记录时才删，否则只收流不删数据。
      evictIdleSlots();
    }, IDLE_SSE_CLOSE_DELAY_MS);
  };

  /**
   * slot 是否可以安全丢弃（Issue #35）。
   *
   * 四个条件必须**同时**满足，宁可多留一个 slot，不可丢掉用户消息：
   * 1. 无视图附件（没人看）；
   * 2. 无快照订阅者；
   * 3. 未运行、无在途提交（没有正在发的消息）；
   * 4. timeline 里**没有未确认的本地记录**（乐观气泡、引导投递、外部追加）——
   *    这是最关键的一条：它们还没进磁盘，丢了就真丢。
   * 另外还要确认消息已落盘（entryIds 有内容），否则重建时可能什么都拉不到；
   * 以及无待投递队列（队列本身在 host/prefs，但 UI 基线丢了会显示不一致）。
   */
  const canEvictSlot = (slot: RuntimeSlot): boolean => {
    if (hasViewers(slot)) return false;
    if (slot.snapshotListeners.size > 0) return false;
    if (
      slot.snapshot.agentRunning
      || slot.snapshot.bashRunning
      || slot.snapshot.sendInFlight
      || slot.inFlight.size > 0
      || slot.promptAborts.size > 0
    ) return false;
    // 未确认的本地记录：绝不可回收
    if (slot.timeline.some((record) => record.pending)) return false;
    if (slot.submissionKeys.size > 0) return false;
    // 空 timeline 且无 entryId：可能只是打开但未 hydrate，留给下次
    if (slot.timeline.length === 0) return false;
    return true;
  };

  /**
   * 回收可丢弃的 slot（无视图、无在途、无未落盘记录）。
   *
   * 存在的理由：`dispose()`（切会话/卸载）只退订视图，**不删 slot**；
   * `slots.delete()` 之前只出现在 rekey 里。于是一个页面里打开过的每个会话都会
   * 一直留着完整 timeline 与派生数组，直到刷新页面——长时间使用下无界增长。
   *
   * 为什么不在 dispose 里直接删：立即删掉会让「切走再马上切回」重新走磁盘
   * hydrate（闪一下、丢掉流式尾部），而空闲收流已经是延迟 5s 的语义。
   */
  const evictIdleSlots = () => {
    for (const [sessionId, slot] of [...slots]) {
      if (!canEvictSlot(slot)) continue;
      slot.eventStream?.close();
      slot.eventStream = null;
      slots.delete(sessionId);
      // 别名指向它的一并清理，避免 getSlot 反复回查空槽
      for (const [alias, canonical] of [...aliases]) {
        if (canonical === sessionId || alias === sessionId) aliases.delete(alias);
      }
    }
  };

  const bumpTimeline = (slot: RuntimeSlot) => {
    slot.snapshot.timelineSeq += 1;
  };

  const nextLocalKey = (slot: RuntimeSlot): string => {
    slot.localKeySeq += 1;
    return `local:${slot.localKeySeq}`;
  };

  const appendMessageWithEntry = (
    slot: RuntimeSlot,
    message: AgentMessage,
    entryId: string | null,
  ): void => {
    const resolved = entryId ?? "";
    const withEntry = {
      ...(message as unknown as Record<string, unknown>),
      entryId: resolved,
    } as unknown as AgentMessage;
    slot.timeline = appendRecord(slot.timeline, {
      key: resolved || nextLocalKey(slot),
      message: withEntry,
      entryId: resolved,
      pending: false,
    });
    bumpTimeline(slot);
  };

  /**
   * submission 状态只能单调推进：`persisted` 与失败态均为终态。
   * SSE 确认可能早于 HTTP receipt 到达，迟到的 receipt 不能把已落盘的状态
   * 回退成 accepted，也不能把已确认的提交重新标成失败。
   */
  const advanceSubmissionStatus = (
    current: SubmissionStatus,
    next: SubmissionStatus,
  ): SubmissionStatus => {
    if (current === "persisted") return current;
    return next;
  };

  const settleSubmission = (
    slot: RuntimeSlot,
    submissionId: string,
    status: SubmissionStatus,
    error?: string,
  ) => {
    const submission = slot.submissions.get(submissionId);
    let applied = status;
    if (submission) {
      applied = advanceSubmissionStatus(submission.status, status);
      submission.status = applied;
      submission.error = error;
    }
    slot.snapshot.sendInFlight = slot.inFlight.size > 0;
    // 当前 promise 在 settle 时仍位于 inFlight；size<=1 表示没有其它提交。
    // rejected/unknown 不是正在执行的 Agent run，必须结束本次乐观 running，
    // 否则失败恢复 draft 后会把会话永久留在 Stop/禁止再次发送状态。
    // 例外：已有交付证据（SSE 已确认这条 user 消息）时，本轮 run 可能仍在跑，
    // 不得因一个迟到的 HTTP 错误把它标成结束。
    if (
      slot.inFlight.size <= 1
      && submission?.delivered !== true
      && (applied === "rejected" || applied === "unknown")
    ) {
      slot.snapshot.agentRunning = false;
      slot.snapshot.completedRunId = slot.snapshot.promptRunId;
      slot.snapshot.streamState = emptyStream();
    }
  };

  const restoreDraftFor = (submission: PromptSubmission) => {
    restoreDraft(submission.draftKey, {
      value: submission.message,
      images: submission.images ?? [],
    });
  };

  /**
   * 失败结算：只在**没有任何交付证据**时才回滚乐观气泡与草稿。
   * 服务端已确认过这条 user 消息（哪怕 SSE 未给 entryId）时，失败清理只会
   * 把已显示的聊天内容抹掉并把文本弹回输入框，必须改为按已投递返回。
   */
  const settleFailure = (
    slot: RuntimeSlot,
    submission: PromptSubmission,
    status: "rejected" | "unknown",
    error: string,
  ): SubmitPromptResult => {
    settleSubmission(slot, submission.submissionId, status, error);
    if (submission.delivered) {
      publish(slot);
      return { submissionId: submission.submissionId, sessionId: slot.sessionId, status: "accepted" };
    }
    dropUnconfirmedOptimistic(slot, submission.submissionId);
    restoreDraftFor(submission);
    publish(slot);
    return { submissionId: submission.submissionId, sessionId: slot.sessionId, status, error };
  };

  /**
   * 已入队结算：载荷没丢，但它不是本轮 run。乐观气泡必须撤回（未投递消息只在
   * 队列面板出现），也不恢复草稿（内容已在服务端队列里）；调用方拿到 queue 快照
   * 去更新队列投影。
   */
  const settleQueued = (
    slot: RuntimeSlot,
    submission: PromptSubmission,
    queue: { items: FollowUpItem[]; revision: number; inFlight: string[] },
  ): SubmitPromptResult => {
    settleSubmission(slot, submission.submissionId, "rejected", "queued");
    dropUnconfirmedOptimistic(slot, submission.submissionId);
    publish(slot);
    return {
      submissionId: submission.submissionId,
      sessionId: slot.sessionId,
      status: "queued",
      queue,
    };
  };

  /** 移除尚无交付证据的乐观记录；返回是否真的移除（调用方据此决定恢复 draft）。 */
  const dropUnconfirmedOptimistic = (slot: RuntimeSlot, submissionId: string): boolean => {
    const key = slot.submissionKeys.get(submissionId);
    slot.submissionKeys.delete(submissionId);
    if (key === undefined) return false;
    const result = dropPendingRecord(slot.timeline, key);
    if (!result.dropped) return false;
    slot.timeline = result.timeline;
    bumpTimeline(slot);
    return true;
  };

  const applyEventToSlot = (slot: RuntimeSlot, event: AgentStreamEvent) => {
    const type = event.type;
    // 事件所属的 SDK run 序号（老服务端不带该字段 → null，退化为原行为）。
    const rawStreamRunSeq = (event as { streamRunSeq?: unknown }).streamRunSeq;
    const streamRunSeq = typeof rawStreamRunSeq === "number" ? rawStreamRunSeq : null;
    // 服务端权威读数随事件下发（TTFT 首帧 / 每个 step 结束）：直接落到 slot 投影，
    // 客户端不自行累计（口径只有一处）。
    const eventMetrics = (event as { turnMetrics?: TurnMetrics }).turnMetrics;
    if (eventMetrics && (typeof eventMetrics.tokensPerSecond === "number" || typeof eventMetrics.ttftMs === "number")) {
      slot.metrics = { ...eventMetrics };
    }
    if (type === "agent_start") {
      // 新 run：清掉上一轮读数（服务端会在 TTFT 首帧/每个 step 结束重新下发）
      if (!eventMetrics) slot.metrics = {};
      slot.snapshot.promptRunId += 1;
      slot.snapshot.agentRunning = true;
      if (streamRunSeq !== null) slot.snapshot.streamRunSeq = streamRunSeq;
      slot.snapshot.completedRunId = null;
      // 新 run 到来时，旧 run 的 finish 异步操作失去所有权；其 finally
      // 只能按 runId 条件释放，不能阻塞当前 run。
      slot.snapshot.finishingRunId = null;
      slot.snapshot.streamState = { isStreaming: true, streamingMessage: null };
      slot.metrics = {};
    } else if (type === "agent_end" || type === "prompt_done") {
      // 迟到的上一轮终止事件：新一轮已经 agent_start（序号前移），不能把它的运行态
      // 判成结束（复核 G1）。同一轮的终止事件序号相符，照常收尾。
      if (streamRunSeq !== null && slot.snapshot.streamRunSeq !== null && streamRunSeq !== slot.snapshot.streamRunSeq) {
        return;
      }
      slot.snapshot.agentRunning = false;
      slot.snapshot.completedRunId = slot.snapshot.promptRunId;
      slot.snapshot.streamState = emptyStream();
    } else if (type === "message_start" || type === "message_update") {
      const message = event.message as Partial<AgentMessage> | undefined;
      if (!slot.snapshot.agentRunning) return;
      if (message?.role === "user") return;
      if (message) {
        const rendered = attachCustomRenderedLines(
          message as AgentMessage,
          event.renderedLines,
        );
        slot.snapshot.streamState = {
          isStreaming: true,
          streamingMessage: normalizeToolCalls(rendered),
        };
      }
    } else if (type === "prompt_error") {
      // prompt 异步失败：移除尚无交付证据的乐观记录。
      // 必须在 slot 内执行——由视图 hook 代劳时，会话已切走/组件已卸载
      // 就不会运行，假气泡会永久留在时间线里。
      const dropped = dropAllPendingRecords(slot.timeline);
      if (dropped.dropped) {
        slot.timeline = dropped.timeline;
        for (const [submissionId, key] of slot.submissionKeys) {
          if (!findRecord(slot.timeline, key)) slot.submissionKeys.delete(submissionId);
        }
        bumpTimeline(slot);
      }
    } else if (type === "message_end") {
      const completed = event.message as AgentMessage | undefined;
      const entryId = typeof event.entryId === "string" && event.entryId ? event.entryId : null;
      if (completed?.role === "user") {
        if (entryId && slot.consumedEntryIds.has(entryId)) {
          publish(slot);
          return;
        }
        if (entryId) slot.consumedEntryIds.add(entryId);
        // FIFO：下一个未绑定 entry 且仍有乐观记录的 accepted/submitting submission。
        const match = [...slot.submissions.values()].find((sub) =>
          (sub.status === "accepted" || sub.status === "submitting")
          && !sub.entryId
          && slot.submissionKeys.has(sub.submissionId),
        );
        const key = match ? slot.submissionKeys.get(match.submissionId) ?? null : null;
        // 生产 SSE 不携带 entryId/submissionId（见 session-timeline 注释），
        // 因此按 stable key → 同文本未绑定项 → 追加 的优先级归并。
        const result = confirmUserMessage(slot.timeline, {
          key,
          message: completed,
          entryId: entryId ?? "",
          fallbackKey: entryId ?? nextLocalKey(slot),
        });
        if (result.outcome !== "duplicate") {
          slot.timeline = result.timeline;
          bumpTimeline(slot);
        }
        if (match) {
          slot.submissionKeys.delete(match.submissionId);
          // 交付证据与 entryId 分开记：生产 SSE 无 entryId，但事件本身已证明
          // 服务端观察到了这条消息，后续失败清理不得再把它当「未投递」回滚。
          if (result.outcome !== "duplicate") match.delivered = true;
          // 同一 entryId 不可二次消费，避免 SSE 重放把两条 submission 绑到同一 entry。
          if (entryId !== null) {
            match.status = advanceSubmissionStatus(match.status, "persisted");
            match.entryId = entryId;
          }
        }
      } else if (completed?.role === "custom" && completed.customType === PIDANCE_BINARY_CUSTOM_TYPE) {
        const binary = parseBinaryMessageData(completed.details);
        let targetIndex = binary?.messageEntryId
          ? slot.timeline.findIndex((record) => record.entryId === binary.messageEntryId)
          : -1;
        if (targetIndex < 0 && binary?.messageEntryId) {
          targetIndex = slot.timeline.findLastIndex((record) => record.message.role === "user" && !record.entryId);
        }
        const target = targetIndex >= 0 ? slot.timeline[targetIndex] : undefined;
        if (binary && target?.message.role === "user") {
          const existing = target.message.binaryBlocks ?? [];
          const alreadyAttached = existing.some((block) => (
            block.path === binary.path
            && block.previewPath === binary.previewPath
          ));
          if (!alreadyAttached) {
            const next = [...slot.timeline];
            next[targetIndex] = {
              ...target,
              message: {
                ...target.message,
                binaryBlocks: [...(target.message.binaryBlocks ?? []), binary],
              } as AgentMessage,
            };
            slot.timeline = next;
            bumpTimeline(slot);
          }
        } else if (slot.snapshot.agentRunning) {
          appendMessageWithEntry(slot, completed, entryId);
        }
      } else if (completed && slot.snapshot.agentRunning) {
        const rendered = attachCustomRenderedLines(completed, event.renderedLines);
        appendMessageWithEntry(slot, normalizeToolCalls(rendered), entryId);
      }
      slot.snapshot.streamState = emptyStream();
    }
    publish(slot);
    for (const handler of slot.viewHandlers) {
      try {
        handler(event);
      } catch {
        /* view errors must not break the runtime */
      }
    }
    // 无视图且空闲（run 结束后无人观看）：调度延迟关闭 SSE，释放服务端 idle host。
    scheduleIdleEventStreamClose(slot);
  };

  /**
   * attach 后 SSE 确连失败的重试窗口（host dispose/创建竞态的瞬态 404）。
   * 有限次短重试：期间用户能看到投递/回复事件；全败则放弃，后续写动作
   * （ensureEventsConnected / submitPrompt）仍会重建。
   */
  const SSE_ENSURE_RETRY_DELAYS_MS = [500, 1_500, 3_000];

  const connectEvents = (slot: RuntimeSlot) => {
    // 挂载/新 run 到来：取消待执行的空闲关闭与重试，保持连接。
    if (slot.idleCloseTimer) {
      clearSchedule(slot.idleCloseTimer);
      slot.idleCloseTimer = null;
    }
    if (slot.sseRetryTimer) {
      clearSchedule(slot.sseRetryTimer);
      slot.sseRetryTimer = null;
      slot.sseRetryAttempt = 0;
    }
    const source = slot.eventStream?.getCurrentSource();
    if (slot.eventStream && source && source.readyState !== 2 && slot.eventStream.isCurrent(slot.sessionId)) {
      return;
    }
    // 丢弃前必须 close()：致命断线的 manager 可能已排了重连定时器
    // （此时 getCurrentSource() 为 null），只清引用会让它之后自行 connect
    // 出一条无人跟踪的重复流，同一会话同时收两份事件。
    slot.eventStream?.close();
    slot.eventStream = null;
    const onEvent = (event: AgentStreamEvent) => applyEventToSlot(slot, event);
    const manager = deps.createEventStream
      ? deps.createEventStream(slot.sessionId, onEvent)
      : createEventStreamManager({
        // 弱网自动重连：仅当 slot 认为 agent 仍在跑且页面可见时自动重连；
        // 404/无 host（空闲 dispose 后）不无限重试，避免对空会话反复握手。
        shouldAutoReconnect: () => {
          if (!slot.snapshot.agentRunning) return false;
          if (typeof document === "undefined") return true;
          return document.visibilityState !== "hidden";
        },
      });
    slot.eventStream = manager;
    void manager.ensureConnected(slot.sessionId, onEvent).catch(() => {
      if (slot.eventStream === manager) slot.eventStream = null;
      // 视图仍在且无 run 在途：有限次重试，覆盖 host 瞬态 404（dispose/ensure 竞态）。
      if (!hasViewers(slot)) return;
      const attempt = slot.sseRetryAttempt;
      if (attempt >= SSE_ENSURE_RETRY_DELAYS_MS.length) return;
      const delay = SSE_ENSURE_RETRY_DELAYS_MS[attempt];
      slot.sseRetryAttempt = attempt + 1;
      if (slot.sseRetryTimer) clearSchedule(slot.sseRetryTimer);
      slot.sseRetryTimer = schedule(() => {
        slot.sseRetryTimer = null;
        // 重试前再确认：视图仍挂载、连接未重建、run 未结束。
        if (!hasViewers(slot)) return;
        if (slot.eventStream && slot.eventStream !== manager) return;
        if (slot.snapshot.agentRunning || slot.snapshot.sendInFlight) return;
        connectEvents(slot);
      }, delay);
    });
  };

  /**
   * pending id → 真实 id。把槽位搬到规范键下，并登记别名。
   *
   * 不再用「两个键指向同一 slot」：那样 getSlot 两个键都会返回同一对象，
   * 谁都不知道哪个是权威 id；这里保证 slots 里只有规范 id 这一个键。
   */
  const rekey = (fromId: string, toId: string): RuntimeSlot => {
    const slot = getSlot(fromId, true)!;
    const previousKey = slot.sessionId;
    // 目标 id 上若已存在别的 slot（正常流程不会）：先放掉它的连接，避免
    // 留下一条无人跟踪的流继续收事件。
    const stale = slots.get(toId);
    if (stale && stale !== slot) {
      stale.eventStream?.close();
      stale.eventStream = null;
      slots.delete(toId);
    }
    slots.delete(previousKey);
    if (previousKey !== fromId) aliases.delete(previousKey);
    slot.sessionId = toId;
    slot.snapshot.sessionId = toId;
    slots.set(toId, slot);
    // pending id 继续指向同一 slot，ensure 完成后 Stop 仍能按原 intent 命中。
    if (fromId !== toId) aliases.set(fromId, toId);
    return slot;
  };

  const registry: BrowserSessionRuntimeRegistry = {
    getSnapshot(sessionId) {
      // 走别名解析：pending id 与真实 id 必须看到同一份状态。
      const slot = getSlot(sessionId, false);
      return slot ? slot.snapshot : null;
    },
    subscribe(sessionId, listener) {
      const slot = getSlot(sessionId, true)!;
      slot.snapshotListeners.add(listener);
      listener(slot.snapshot);
      return () => {
        slot.snapshotListeners.delete(listener);
      };
    },
    attach(sessionId, onEvent) {
      const slot = getSlot(sessionId, true)!;
      // 每个附件一个 token：dispose 只删自己那一个，重复 dispose 或 id 解析
      // 变化都不会漏减，因此「无人观看」必然能回到 true。
      const attachment: ViewAttachment = { onEvent };
      slot.attachments.add(attachment);
      syncViewDerived(slot);
      // 打开会话只订阅已有 live；不在 attach 阶段 wake/创建 writer。
      // 首次写操作由 submitPrompt/ensureEventsConnected 明确唤醒，避免 31415/31416
      // 共用 agentDir 时仅浏览会话就抢占另一进程的 writer lease。
      connectEvents(slot);
      publish(slot);
      let disposed = false;
      return {
        sessionId: slot.sessionId,
        dispose: () => {
          if (disposed) return;
          disposed = true;
          // 直接操作 slot 对象，不按 id 回查：rekey / 别名清理都不会让这次
          // 释放落空（落空就等于把这台机器上的 writer 租约永久占住）。
          slot.attachments.delete(attachment);
          syncViewDerived(slot);
          publish(slot);
          // 切走后无人观看：延迟关闭 SSE，释放服务端 idle host 与 writer 租约。
          scheduleIdleEventStreamClose(slot);
        },
      };
    },
    detach(sessionId, subscription) {
      subscription.dispose();
    },
    async submitPrompt(input) {
      const submissionId = input.submissionId?.trim() || makeSubmissionId();
      const initialSessionId = input.target.kind === "persisted"
        ? input.target.sessionId
        : pendingSessionId(input.target.intentId);
      const slot = getSlot(initialSessionId, true)!;
      const existing = slot.submissions.get(submissionId);
      if (existing && (existing.status === "accepted" || existing.status === "persisted" || existing.status === "submitting")) {
        return {
          submissionId,
          sessionId: slot.sessionId,
          status: "accepted",
        };
      }
      const inFlight = slot.inFlight.get(submissionId);
      if (inFlight) return inFlight;

      const submission: PromptSubmission = {
        submissionId,
        sessionId: initialSessionId,
        draftKey: input.draftKey,
        message: input.message,
        images: input.images,
        binaryBlocks: input.binaryBlocks,
        status: "submitting",
        delivered: false,
        entryId: null,
      };
      const controller = new AbortController();
      slot.submissions.set(submissionId, submission);
      slot.promptAborts.set(submissionId, controller);
      slot.snapshot.sendInFlight = true;
      slot.snapshot.agentRunning = true;
      slot.snapshot.promptRunId += 1;
      slot.snapshot.completedRunId = null;
      slot.snapshot.finishingRunId = null;
      slot.snapshot.streamState = { isStreaming: true, streamingMessage: null };
      // 一轮从用户提交那一刻开始计：TTFT 含提交到首字的全部等待。
      // 也保证 agent_start 缺失时 startedAt 不会是 0（那会让 TTFT 变成天文数字）。
      slot.metrics = {};
      const optimisticKey = submissionKey(submissionId);
      slot.timeline = appendRecord(
        slot.timeline,
        optimisticRecord(
          optimisticKey,
          userMessageFromSubmit(input.message, input.images, input.binaryBlocks, now()),
        ),
      );
      slot.submissionKeys.set(submissionId, optimisticKey);
      bumpTimeline(slot);
      publish(slot);

      const promise = (async (): Promise<SubmitPromptResult> => {
        let sessionId = initialSessionId;
        let newSessionJustEnsured = false;
        try {
          if (input.target.kind === "new") {
            if (deps.createAndPrompt) {
              // 一步创建+发送：服务端 POST /api/agent/new {type:"prompt"} 在同一
              // host 启动窗口内完成 ensure+prompt，返回真实 id；无两跳竞态。
              const { sessionId: created, receipt } = await deps.createAndPrompt(
                input.target.cwd,
                {
                  message: input.message,
                  images: input.images,
                  binaryBlocks: input.binaryBlocks,
                  submissionId,
                  ...(input.model?.provider ? { provider: input.model.provider, modelId: input.model.modelId } : {}),
                  ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
                  signal: controller.signal,
                },
              );
              if (controller.signal.aborted) {
                throw new DOMException("aborted", "AbortError");
              }
              sessionId = created;
              submission.sessionId = created;
              rekey(initialSessionId, created);
              newSessionJustEnsured = true;
              if (receipt.status === "rejected") {
                return settleFailure(slot, submission, "rejected", "rejected");
              }
              if (receipt.status === "queued" && receipt.queue) {
                return settleQueued(slot, submission, receipt.queue);
              }
              settleSubmission(slot, submissionId, "accepted");
              publish(slot);
              return { submissionId, sessionId, status: "accepted" };
            }
            if (!deps.ensureNewSession) {
              return settleFailure(slot, submission, "rejected", "no ensure implementation");
            }
            const created = await deps.ensureNewSession(input.target.cwd, input.model);
            if (controller.signal.aborted) {
              throw new DOMException("aborted", "AbortError");
            }
            sessionId = created;
            submission.sessionId = created;
            rekey(initialSessionId, created);
            // 刚 ensure 的新 host 必然 live（startup hold 保活窗口内），无需 wake；
            // wake 走磁盘 resolvePath，新会话文件尚未落盘会 404 → 发送被拒。
            newSessionJustEnsured = true;
          }
          // 先显式唤醒/确保 writer，再建立 SSE；attach 本身不会创建 live。
          // 否则无 live 的 SSE 请求会先被 404，随后真正 prompt 已开始却没有事件订阅。
          // （仅旧会话需要 wake；新会话跳过，见上）
          if (!newSessionJustEnsured && deps.wake) {
            await deps.wake(sessionId, controller.signal);
          }
          connectEvents(slot);
          const receipt = await deps.postPrompt(sessionId, {
            message: input.message,
            images: input.images,
            binaryBlocks: input.binaryBlocks,
            submissionId,
            signal: controller.signal,
          });
          if (receipt.status === "rejected") {
            return settleFailure(slot, submission, "rejected", "rejected");
          }
          if (receipt.status === "queued" && receipt.queue) {
            return settleQueued(slot, submission, receipt.queue);
          }
          settleSubmission(slot, submissionId, "accepted");
          publish(slot);
          return { submissionId, sessionId, status: "accepted" };
        } catch (error) {
          const aborted = error instanceof Error && (error.name === "AbortError" || controller.signal.aborted);
          if (aborted) {
            // 与其它失败共用结算：已观察到投递时按已投递返回（run 可能仍在跑）；
            // 未投递则回滚假气泡并恢复草稿。
            return settleFailure(slot, submission, "unknown", "aborted");
          }
          const message = error instanceof Error ? error.message : String(error);
          return settleFailure(slot, submission, "unknown", message);
        } finally {
          slot.inFlight.delete(submissionId);
          slot.promptAborts.delete(submissionId);
          slot.snapshot.sendInFlight = slot.inFlight.size > 0;
          publish(slot);
          // 提交结算后仍无视图且已空闲（rejected/unknown）：调度延迟关闭 SSE。
          scheduleIdleEventStreamClose(slot);
        }
      })();
      slot.inFlight.set(submissionId, promise);
      return promise;
    },
    cancellationFor(sessionId) {
      const slot = getSlot(sessionId, false);
      if (!slot) return null;
      const first = [...slot.promptAborts.entries()][0];
      if (!first) return null;
      const [submissionId, controller] = first;
      return { submissionId, cancel: () => controller.abort(), signal: controller.signal };
    },
    async abortSubmission(sessionId, submissionId) {
      const slot = getSlot(sessionId, false);
      if (!slot) return null;
      const targetId = submissionId ?? [...slot.promptAborts.keys()][0];
      const controller = targetId ? slot.promptAborts.get(targetId) : undefined;
      const inflight = targetId ? slot.inFlight.get(targetId) : undefined;
      controller?.abort();
      // 显式 Stop：先把取消意图交给服务端提交事务（真实 id 未知也能定位），
      // 再等本地结算。服务端返回 pending/confirmed 均不冒充「已停止」。
      if (targetId && deps.cancelSubmission) {
        try {
          await deps.cancelSubmission(targetId);
        } catch {
          // 取消请求失败：保持未知，不重发、不假装已停止。
        }
      }
      if (inflight) return inflight;
      return Promise.resolve(null);
    },
    abort(sessionId) {
      const slot = getSlot(sessionId, false);
      if (!slot) return;
      for (const controller of slot.promptAborts.values()) controller.abort();
      slot.snapshot.agentRunning = false;
      slot.snapshot.streamState = emptyStream();
      slot.snapshot.sendInFlight = slot.inFlight.size > 0;
      publish(slot);
      scheduleIdleEventStreamClose(slot);
    },
    setBashRunning(sessionId, running, pending) {
      const slot = getSlot(sessionId, true)!;
      slot.snapshot.bashRunning = running;
      slot.snapshot.pendingBash = running ? (pending ?? null) : null;
      publish(slot);
    },
    getRunState(sessionId) {
      const snapshot = getSlot(sessionId, false)?.snapshot;
      if (!snapshot) return null;
      return {
        promptRunId: snapshot.promptRunId,
        agentRunning: snapshot.agentRunning,
        sendInFlight: snapshot.sendInFlight,
        finishingRunId: snapshot.finishingRunId,
        completedRunId: snapshot.completedRunId,
      };
    },
    beginRunFinish(sessionId, runId) {
      const slot = getSlot(sessionId, false);
      if (!slot) return false;
      const snapshot = slot.snapshot;
      if (snapshot.promptRunId !== runId) return false;
      if (snapshot.finishingRunId !== null) return false;
      if (!snapshot.agentRunning && snapshot.completedRunId !== runId) return false;
      snapshot.finishingRunId = runId;
      publish(slot);
      return true;
    },
    releaseRunFinish(sessionId, runId) {
      const slot = getSlot(sessionId, false);
      if (!slot || slot.snapshot.finishingRunId !== runId) return;
      slot.snapshot.finishingRunId = null;
      publish(slot);
    },
    completeRun(sessionId, runId) {
      const slot = getSlot(sessionId, false);
      if (!slot || slot.snapshot.promptRunId !== runId) return false;
      slot.snapshot.agentRunning = false;
      slot.snapshot.completedRunId = runId;
      slot.snapshot.streamState = emptyStream();
      publish(slot);
      return true;
    },
    importRunningRun(sessionId, startedAt) {
      const slot = getSlot(sessionId, true)!;
      const snapshot = slot.snapshot;
      // 只在浏览器侧未感知 run 时导入（刷新/冷挂载后服务端已在跑）。
      // 已 running / 已有在途 send 不得重复导入（run id 会膨胀）。
      if (snapshot.agentRunning || snapshot.sendInFlight) return;
      snapshot.agentRunning = true;
      snapshot.completedRunId = null;
      snapshot.finishingRunId = null;
      snapshot.promptRunId += 1;
      snapshot.streamState = { isStreaming: true, streamingMessage: null };
      // 冷挂载恢复：用服务端记录的启动时刻，避免 startedAt=0 导致 TTFT 荒谬。
      const resumedFrom = typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt > 0
        ? startedAt
        : now();
      // 冷挂载只清空读数：当前 run 的真实读数由服务端随事件/状态下发
      // （客户端不再自行累计，也不存在「本地比服务端新」的取舍）。
      slot.metrics = {};
      publish(slot);
    },
    seedTurnMetrics(sessionId, metrics) {
      const slot = getSlot(sessionId, true)!;
      // 服务端读数的兜底入口（冷挂载/重连）：直接作为当前读数渲染。
      slot.metrics = metrics ? { ...metrics } : {};
      publish(slot);
    },
    async reconcile(sessionId) {
      const slot = getSlot(sessionId, false);
      if (!slot || !deps.getAgentState) return null;
      const runId = slot.snapshot.promptRunId;
      const data = await deps.getAgentState(sessionId);
      const current = getSlot(sessionId, false);
      if (current !== slot || current.snapshot.promptRunId !== runId) {
        return { runId, stale: true, live: false, shouldFinish: false };
      }
      const live = data.live === true || (data.live === undefined && data.running === true);
      const state = data.state;
      const knownIdleWithoutLive = data.activeRun === false && data.lockedByOther !== true;
      return {
        runId,
        stale: false,
        live,
        shouldFinish: shouldFinishFromReconcile({
          sendInFlight: current.snapshot.sendInFlight,
          clientRunning: current.snapshot.agentRunning,
          live,
          knownIdleWithoutLive,
          isStreaming: state?.isStreaming === true,
          isPromptRunning: state?.isPromptRunning === true,
          isCompacting: state?.isCompacting === true,
        }),
        state,
      };
    },
    beginHydrate(sessionId) {
      const slot = getSlot(sessionId, true)!;
      slot.hydrateSeq += 1;
      return slot.hydrateSeq;
    },
    hydrate(sessionId, messages, entryIds = [], options) {
      const slot = getSlot(sessionId, true)!;
      const requestSeq = options?.hydrateRequestSeq ?? ++slot.hydrateSeq;
      // 更新的响应已经落地 → 本次响应整体作废（含会话级状态）。
      if (requestSeq <= slot.hydrateAppliedSeq) return "superseded";
      // 期间已有 live 事件：时间线不得被磁盘快照覆盖，但这份响应仍是**最新的
      // 磁盘读取**，调用方仍应提交 leaf/model 等会话级状态。
      if (options?.sinceSeq !== undefined && slot.snapshot.timelineSeq > options.sinceSeq) {
        return "stale";
      }
      slot.hydrateSeq = Math.max(slot.hydrateSeq, requestSeq);
      slot.hydrateAppliedSeq = requestSeq;
      // 归并一律从 slot 自己的 timeline 计算（调用方不再回传 previous），
      // 杜绝依赖 React updater 同步执行而把空数组写进时间线。
      const mode = options?.mode ?? "replace";
      const previous = slot.timeline;
      const merged = mode === "prepend"
        ? prependOlderRecords(previous, messages, entryIds)
        : mode === "tail"
          ? mergeTailRecords(previous, messages, entryIds)
          : timelineFromDisk(messages, entryIds);
      // 同会话重载不得吞掉磁盘尚未包含的乐观气泡：否则它会先消失、
      // 之后又出现，迟到的 message_end 也再没有记录可绑定。
      slot.timeline = mode === "replace" ? merged : [...retainPendingRecords(previous, merged)];
      for (const entryId of timelineEntryIds(slot.timeline)) {
        if (entryId) slot.consumedEntryIds.add(entryId);
      }
      publish(slot);
      return "applied";
    },
    appendLocal(sessionId, message) {
      const slot = getSlot(sessionId, true)!;
      const key = nextLocalKey(slot);
      slot.timeline = appendRecord(slot.timeline, optimisticRecord(key, message));
      bumpTimeline(slot);
      publish(slot);
      return key;
    },
    dropLocal(sessionId, key) {
      const slot = getSlot(sessionId, false);
      if (!slot) return false;
      const result = dropPendingRecord(slot.timeline, key);
      if (!result.dropped) return false;
      slot.timeline = result.timeline;
      bumpTimeline(slot);
      publish(slot);
      return true;
    },
    applyEvent(sessionId, event) {
      const slot = getSlot(sessionId, true)!;
      applyEventToSlot(slot, event);
    },
    ensureEventsConnected(sessionId) {
      // 重连也只尝试当前 live host；焦点/可见性恢复不得把冷历史会话唤醒。
      const slot = getSlot(sessionId, true)!;
      connectEvents(slot);
    },
    getEventSource(sessionId) {
      return getSlot(sessionId, false)?.eventStream?.getCurrentSource() ?? null;
    },
    getSubmission(sessionId, submissionId) {
      return getSlot(sessionId, false)?.submissions.get(submissionId);
    },
    resetForTests() {
      resetSingleton();
    },
    debugSlotCount() {
      return slots.size;
    },
    debugSlotIds() {
      return [...slots.keys()];
    },
  };

  return registry;
}

let singleton: BrowserSessionRuntimeRegistry | null = null;

export function getBrowserSessionRuntimeRegistry(
  deps?: BrowserSessionRuntimeRegistryDeps,
): BrowserSessionRuntimeRegistry {
  if (!singleton) {
    if (!deps) {
      throw new Error("BrowserSessionRuntimeRegistry requires deps on first initialization");
    }
    singleton = createBrowserSessionRuntimeRegistry(deps);
  }
  return singleton;
}

function resetSingleton(): void {
  singleton = null;
}

export function resetBrowserSessionRuntimeRegistryForTests(): void {
  resetSingleton();
}

function createBrowserFetchDeps(): BrowserSessionRuntimeRegistryDeps {
  return {
    async createAndPrompt(cwd, input) {
      const res = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          type: "prompt",
          message: input.message,
          submissionId: input.submissionId,
          ...(input.images?.length ? { images: promptImageInputs(input.images) } : {}),
          ...(input.binaryBlocks?.length ? { binaryBlocks: input.binaryBlocks } : {}),
          ...(input.provider && input.modelId ? { provider: input.provider, modelId: input.modelId } : {}),
          ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
        }),
        signal: input.signal,
      });
      const body = await res.json().catch(() => ({})) as {
        sessionId?: string;
        data?: PromptReceipt | null;
        error?: string;
      };
      if (!res.ok || body.error || !body.sessionId) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      if (!body.data || typeof body.data !== "object" || !body.data.status) {
        // 没有回执就是没有回执：静默当成 accepted 会把未受理的消息标成已发送。
        throw new Error("Invalid prompt receipt: expected a status");
      }
      return { sessionId: body.sessionId, receipt: body.data };
    },
    async postPrompt(sessionId, input) {
      const { submitAgentPrompt } = await import("./agent-client");
      return submitAgentPrompt(sessionId, input, { signal: input.signal });
    },
    async ensureNewSession(cwd, extras) {
      const res = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          type: "ensure_session",
          ...(extras?.provider && extras.modelId
            ? { provider: extras.provider, modelId: extras.modelId }
            : {}),
        }),
      });
      const body = await res.json().catch(() => ({})) as { sessionId?: string; error?: string };
      if (!res.ok || !body.sessionId) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return body.sessionId;
    },
    async wake(sessionId, signal) {
      const wake = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/state?wake=1`, { signal });
      if (!wake.ok) {
        const wakeBody = await wake.json().catch(() => ({})) as { error?: string };
        throw new Error(typeof wakeBody.error === "string" ? wakeBody.error : `HTTP ${wake.status}`);
      }
    },
    async getAgentState(sessionId) {
      // light=1：这是轮询路径（reconcile/prompt settle），systemPrompt 是最大字段
      // 且几乎不变，由 loadSession 的 includeState 权威提供。
      const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}?light=1`, {
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({})) as RuntimeAgentState & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      return data;
    },
    async cancelSubmission(submissionId) {
      // 有界超时：Stop 不能被一个不响应的取消请求拖死。超时视为未知，
      // 不重发、不假装已停止。
      const response = await fetch(
        `/api/agent/submissions/${encodeURIComponent(submissionId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "cancel" }),
          signal: AbortSignal.timeout(CANCEL_SUBMISSION_TIMEOUT_MS),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json().catch(() => ({})) as { status?: string };
      return { status: body.status === "confirmed" ? "confirmed" : "pending" };
    },
  };
}

export function getOrCreateBrowserSessionRuntimeRegistry(): BrowserSessionRuntimeRegistry {
  if (!singleton) {
    singleton = createBrowserSessionRuntimeRegistry(createBrowserFetchDeps());
  }
  return singleton;
}
