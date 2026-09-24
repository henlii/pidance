/**
 * 同进程 Pi SDK host：拥有 AgentSessionRuntime、事件投影、类型化 send 与 dispose/rebind。
 * 浏览器协议字段与外部 RPC 时代对齐，前端契约不变。
 */
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  type AgentSession,
  type AgentSessionRuntime,
  type AgentSessionServices,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "./pi-paths";
import { hasActiveSubagentRunForSession, listSubagentRuns } from "./subagent-runs";
import { hasActiveExternalWork as hasRegisteredExternalWork } from "./session-liveness";
import { createStreamSnapshotCache, type StreamSnapshot } from "./stream-snapshot";
import {
  getPidancePref,
  readPidancePrefs,
  updatePidancePref,
} from "./pidance-prefs-file";
import {
  acquireRunningLease,
  SESSION_RUNNING_LOCKED_MESSAGE,
} from "./session-running-lease";

/**
 * 命令仍在进行、无法安全交出 writer 时的失败消息。
 * SessionService 把它映射为 409：宁可让离线写 fail closed，也不并发写同一个 JSONL。
 */
/**
 * 队列模型副本的单文件上限。安全尺寸副本远小于此（base64 上限 4MB），留一倍余量
 * 即可，避免客户端拿一个巨大的「模型副本」让 Host 读进内存。
 */
const QUEUE_MODEL_MEDIA_MAX_BYTES = 8 * 1024 * 1024;

export const SESSION_WRITER_BUSY_MESSAGE =
  "Session writer is busy: a command is still in flight";
import {
  clearRunningStartedAt,
  recordRunningStartedAt,
} from "./running-state";
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
  chatAttachmentMediaSize,
  deleteChatAttachmentMedia,
  readChatAttachmentBase64,
  saveChatAttachmentBytes,
  type SavedChatAttachment,
} from "./chat-attachments";
import {
  followUpItemMedia,
  followUpItemTexts,
  mergeFollowUpPayload,
  parseFollowUpQueue,
  newFollowUpItem,
  reconcileFollowUpItems,
  serializeFollowUpQueue,
  withAdmittedAttemptIds,
  MAX_QUEUED_ITEM_MEDIA,
  type FollowUpItem,
  type QueuedMediaRef,
} from "./session-queue";
import {
  normalizeActivityInput,
  parseAppendActivityCommand,
  PIDANCE_ACTIVITY_CUSTOM_TYPE,
} from "./session-activity";
import {
  clearLeafSidecar,
  writeLeafSidecar,
} from "./session-leaf-sidecar";
import {
  materializeSessionFile,
  openSessionManager,
  createSessionManager,
} from "./pi-session-io";
import {
  createWebExtensionUIAdapter,
  type WebExtensionUIAdapter,
} from "./web-extension-ui";
import type { NavigationActions } from "./live-session-registry";
import { resolveSessionModel } from "./resolve-session-model";
import { isImmediateSlashPrompt } from "./slash-prompt";
import {
  applyPassThroughExtendedThinkingInPlace,
  withPassThroughExtendedThinking,
} from "./thinking-levels";
import {
  classifyPromptRejection,
  isQueueablePromptReason,
  parseDispatchFollowUpQueueCommand,
  parseFollowUpCommand,
  parsePromptCommand,
  parseRecallFollowUpQueueCommand,
  parseSetFollowUpQueueCommand,
  parseSteerCommand,
  type DispatchFollowUpQueueCommand,
  type PromptImage,
  type PromptImageInput,
  type PromptReason,
  type PromptReceipt,
  type QueueRecallReceipt,
  type SteerCommand,
  type QueueDispatchReceipt,
  type QueueItemPayload,
  type QueueWriteReceipt,
} from "./agent-commands";
import { mergeFollowUpForSteer } from "./queue-merge";
import {
  PIDANCE_BINARY_CUSTOM_TYPE,
  binaryMessageToUiMessage,
} from "./message-binary";
import { normalizeBinaryMessageInputs } from "./message-binary-store";
import {
  appendPidanceFileDeliveryPrompt,
  createSendFileToUserExecutor,
  SEND_FILE_TO_USER_PARAMETERS,
  SEND_FILE_TO_USER_TOOL_NAME,
  type SendFileToUserParams,
} from "./send-file-to-user";
import type { BinaryMessageData, BinaryMessageInput } from "./types";
import {
  loadPiTheme,
  RENDER_WIDTH,
  renderCustomMessageLines,
  renderToolCallLines,
  renderToolResultLines,
  renderWidgetComponentLines,
  type Theme,
} from "./tui-render-bridge";

export type SdkAgentEvent = {
  type: string;
  [key: string]: unknown;
};

export type SdkEventListener = (event: SdkAgentEvent) => void;

/** 单个 toolCallId 的渲染上下文状态（跨事件保持：call → update → result）。 */
type ToolRenderStateEntry = {
  /** 渲染器共享状态对象（插件读写 subagentResultAnimationTimer 等）。 */
  state: Record<string, unknown>;
  /** renderCall 槽「上一组件」。 */
  lastCallComponent: unknown;
  /** renderResult 槽「上一组件」。 */
  lastResultComponent: unknown;
  /** tool_execution_update 上次渲染时间戳（节流用）。 */
  lastPartialRenderAt: number | undefined;
};

/**
 * 命令仍在进行、无法安全交出 writer 时的失败消息。
 * SessionService 把它映射为 409：宁可让离线写 fail closed，也不并发写同一个 JSONL。
 */
export type SdkSessionHostOptions = {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  toolNames?: string[];
  navigationActions?: NavigationActions;
  /** 兼容旧调用方；当前 settled host 立即 dispose，不再使用分钟级 idle timeout。 */
  idleTimeoutMs?: number;
  /**
   * 命令仍在进行时，destroyAsync 等待交出 writer 的上限；超时抛
   * SESSION_WRITER_BUSY_MESSAGE。测试可注入更短值。
   */
  destroyWaitMs?: number;
  agentDir?: string;
  onRunningChange?: () => void;
  onSessionListInvalidate?: () => void;
  cacheSessionPath?: (sessionId: string, sessionFile: string) => void;
  /** registry rekey：fork/new 替换 session 后更新 key */
  onSessionRekeyed?: (oldId: string, newId: string, host: SdkSessionHost) => void;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** 自动命名用：从消息 content 提取首条用户输入（string 或 text 块），折叠空白并截断。 */
const AUTO_NAME_MAX_LENGTH = 60;
/** 内联图片落盘时的扩展名（只影响文件名，Content-Type 由引用自带）。 */
function imageExtension(mimeType: string): string {
  const normalized = mimeType.split(";")[0]!.trim().toLowerCase();
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/svg+xml") return "svg";
  return normalized.startsWith("image/") ? normalized.slice(6).replace(/[^a-z0-9]/g, "") || "png" : "bin";
}

function firstUserText(content: unknown): string | undefined {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter(
        (block): block is { type?: string; text?: string } =>
          typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("\n");
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > AUTO_NAME_MAX_LENGTH
    ? `${normalized.slice(0, AUTO_NAME_MAX_LENGTH)}…`
    : normalized;
}

/** 打开或创建 SessionManager，并在创建 AgentSession 前应用 leaf sidecar。 */
export function openSessionManagerForHost(
  sessionFile: string,
  cwd: string,
): SessionManager {
  if (sessionFile) return openSessionManager(sessionFile);
  return createSessionManager(cwd);
}

export class SdkSessionHost {
  private listeners: SdkEventListener[] = [];
  private runtime: AgentSessionRuntime | null = null;
  private unsubscribe: (() => void) | null = null;
  private extensionUi: WebExtensionUIAdapter | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** ensureLive/state?wake 与后续首个写命令之间的短暂交接窗口。 */
  private startupHoldTimer: ReturnType<typeof setTimeout> | null = null;
  private startupHold = true;
  private activeCommandCount = 0;
  /** 销毁通知订阅者；多订阅互不覆盖（registry 清理与多条 SSE 共存）。 */
  private destroyCallbacks = new Set<() => void>();
  /**
   * 命令仍在进行时的等待中销毁，按排除数分组。
   * 导航命令交接（排除自己）与外部调用（不排除）判定不同，不能共享同一个等待。
   */
  private pendingDestroys = new Map<number, Promise<void>>();
  private _alive = true;
  private promptRunning = false;
  /** 本轮 SDK run 的本地序号（agent_start 递增；随 SSE 事件下发，见 handleSessionEvent）。 */
  private streamRunSeq = 0;
  /** 最近一次 prompt 结束原因：队列自动投递只认 completed。 */
  private lastStopReason: "completed" | "aborted" | "error" | null = null;
  /**
   * 本地 follow-up 队列执行缓存（持久层仍是 prefs）。
   *
   * 条目带稳定 id 与状态：`waiting` 可被自动 flush/清队消费，`claimed` 已提交给 SDK
   * 尚未拿到受理结果（普通清队不得把它当成取消成功），`unknown` 是跨越重启或持久化
   * 失败后的结果未知项（绝不自动重投）。
   */
  private followUpQueue: FollowUpItem[] = [];
  /**
   * 队列版本：每次内容变更 +1，随 state 投影与 prefs 一起下发。
   * 客户端据此丢弃乱序到达的过期快照（否则「引导整队发送」清队后，
   * 旧快照会把已发送的队列重新写回 UI）。
   */
  private followUpQueueRevision = 0;
  private followUpQueueHydrated = false;
  private flushingFollowUp = false;
  /** 本次 flush 的投递单元（只固定 id；正文在认领时按 id 重取，见 deliverFollowUpUnit）。 */
  private followUpFlushUnits: { ids: string[] }[] = [];
  private followUpFlushCursor = 0;
  /**
   * 投递在途标记（重入保护）。
   * agent_settled 与 80ms 兜底定时器都会调 sendNextFollowUp：没有这个标记时
   * 两个调用会同时通过 settled 检查，同一单元被认领并投递两次（重复消费）。
   */
  private followUpSending = false;
  /**
   * 内部投递票据：只有 flush 自己发起的 prompt 能穿过「投递在途」门禁。
   * 用 symbol 身份而不是布尔标志——布尔会被「恰好在这一刻到达的外部请求」共享，
   * 外部 prompt 于是和 flush 并发写同一个 SessionManager。
   */
  private readonly internalPromptTicket = Symbol("pidance internal follow-up prompt");
  /**
   * 认领落盘失败后的 fail-closed：禁止自动重试。否则 resetIdleTimer →
   * scheduleFollowUpFlush 会立刻重入同一失败，磁盘写不进去时无限循环。
   * 一次成功的队列写入（用户入队/清队/手动转引导）会重新解锁。
   */
  private followUpFlushBlocked = false;
  /** 手动整队转引导在途：阻止并发 dispatch 把同一批内容投递两次。 */
  private dispatchingFollowUpQueue = false;
  /** steer / follow_up / 入队的幂等回执（同 submissionId 不重复作用）。 */
  private commandReceipts = new Map<string, PromptReceipt>();
  private bashRunning = false;
  private bashCommand: {
    command: string;
    excludeFromContext: boolean;
    startedAt: number;
  } | null = null;
  private localQueue: { steering: string[]; followUp: string[] } = {
    steering: [],
    followUp: [],
  };
  /**
   * 本 run 的吞吐读数（与浏览器侧 turn-metrics 同算法：每个 assistant step 的
   * 「首个可见 token → 消息结束」时长 + provider 上报 output tokens，按解码时长加权）。
   * 放在 host 是因为刷新/冷挂载的页面看不到 step 的开始，只有服务端能给出完整读数；
   * 客户端冷挂载时用这份值 seed，自己观察到完整 step 后再以本地为准。
   */
  private turnMetrics: {
    startedAt: number;
    firstTokenAt: number | null;
    ttftMs: number | null;
    decodeMs: number;
    outputTokens: number;
    sampled: boolean;
  } = { startedAt: 0, firstTokenAt: null, ttftMs: null, decodeMs: 0, outputTokens: 0, sampled: false };
  /** Live-host prompt receipts; same submissionId does not call Pi twice. */
  private promptReceipts = new Map<string, PromptReceipt>();
  /** submissionId → in-flight prompt promise（单飞；结算后删除） */
  private promptInFlight = new Map<string, Promise<PromptReceipt>>();
  /**
   * 同一 submissionId 的在途 steer：并发重发（浏览器重试/双标签同 id）时
   * 只能让 SDK 收到一次。命令回执缓存只管已完成的请求，拦不住同一批并发请求。
   */
  private steerFlights = new Map<string, Promise<PromptReceipt>>();
  /** 已接受 prompt 的二进制块；user message 落盘后追加 UI-only custom entry。 */
  private pendingBinaryBatches: Array<{ submissionId: string; blocks: BinaryMessageData[] }> = [];
  /** 共享 destroy 完成信号：destroyAsync 并发重入时 await 同一 dispose */
  private destroyPromise: Promise<void> | null = null;
  private hasQueueSnapshot = false;
  private realSessionId: string;
  private realSessionFile: string;
  private readonly idleTimeoutMs: number;
  private readonly destroyWaitMs: number;
  private readonly agentDir: string;
  private activeToolNames: string[] | undefined;
  /** 渲染桥主题（模块级缓存）；加载失败为 null → 跳过渲染。 */
  private readonly renderBridgeTheme: Theme | null = loadPiTheme();

  /**
   * 当前渲染列数：由前端按可用宽度上报（默认 RENDER_WIDTH）。
   * 插件的组件按这个宽度排版，所以窄视口不应该再按桌面宽度渲染 ——
   * 否则方框/表格会被 CSS 硬断行打乱。
   */
  private renderWidth = RENDER_WIDTH;
  /** toolCallId → 渲染状态（跨 tool_call → update → result 共享）。 */
  private readonly toolRenderStates = new Map<string, ToolRenderStateEntry>();
  /**
   * 连接快照：最近一条流式 message 事件 + 活跃工具的最新 start/update。
   * 中途接入的页面（新标签/重连/冷挂载）靠它立刻看到已生成的内容，
   * 不必等下一个 chunk（见 lib/stream-snapshot.ts）。
   */
  private readonly streamSnapshot = createStreamSnapshotCache();
  /** tool_execution_update 渲染最短间隔（ms），防高频 partial 阻塞事件循环。 */
  private static readonly PARTIAL_RENDER_MIN_INTERVAL_MS = 100;

  /** 渲染列数边界：太窄会把插件界面压烂，太宽没有意义。 */
  private static readonly RENDER_WIDTH_MIN = 40;
  private static readonly RENDER_WIDTH_MAX = 240;

  constructor(private readonly options: SdkSessionHostOptions) {
    this.realSessionId = options.sessionId;
    this.realSessionFile = options.sessionFile;
    // 默认 30s 无端点兜底释放（有活跃 SSE 订阅时保活，不设倒计时）；
    // 测试可注入更短值验证释放路径。
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
    this.destroyWaitMs = options.destroyWaitMs ?? 5_000;
    this.agentDir = options.agentDir ?? getAgentDir();
    this.activeToolNames = options.toolNames;
  }

  get sessionId(): string {
    return this.realSessionId;
  }

  get sessionFile(): string {
    return this.realSessionFile;
  }

  /** 当前未完成的 Extension UI 请求（多客户端恢复弹窗）。 */
  listPendingExtensionRequests(): Record<string, unknown>[] {
    return Array.from(this.extensionUi?.pendingSnapshot.values() ?? []);
  }

  /** 供 SessionService 识别 in-process 写路径 */
  get inner(): { sessionManager: SessionManager } | undefined {
    const session = this.runtime?.session;
    if (!session) return undefined;
    return { sessionManager: session.sessionManager };
  }

  isAlive(): boolean {
    return this._alive && this.runtime !== null;
  }

  isRunning(): boolean {
    if (!this._alive || !this.runtime) return false;
    const s = this.runtime.session;
    return (
      this.promptRunning ||
      this.bashRunning ||
      s.isStreaming ||
      s.isCompacting
    );
  }

  /**
   * steer 命令的实际执行体（从 send() 的 switch 里抽出：同一 submissionId 的
   * 并发请求必须共享同一个在途 promise，不能给 SDK 发两次）。
   */
  private async runSteerCommand(parsed: SteerCommand): Promise<PromptReceipt> {
    const session = this.session;
    if (this.bashRunning) {
      // 结构化回执而非抛异常：客户端要按原因提示并回草稿（R8/A8），
      // 抛异常只会变成无法归类的 HTTP 错误。
      const receipt = this.reject(parsed.submissionId, "bash");
      this.commandReceipts.set(parsed.submissionId, receipt);
      return receipt;
    }
    // 压缩中且没有活跃 agent loop：原生 steer 只进 SDK 的 steering queue，
    // 要等到下一次 prompt 才被消费，UI 上看不到这条消息。放进产品队列，
    // compaction_end 会按正常流程投递。
    if (session.isCompacting && !session.isStreaming && !this.promptRunning) {
      // 压缩中：正文与图片一起入队（条目只持引用），压缩结束自动投递。
      const queuedMedia = this.queueMediaFromPromptImages(parsed.images);
      if (!queuedMedia.ok) {
        const failed = this.reject(parsed.submissionId, "media");
        this.commandReceipts.set(parsed.submissionId, failed);
        return failed;
      }
      const receipt = this.enqueuePayloads(
        parsed.submissionId,
        [{ text: parsed.message, ...(queuedMedia.media?.length ? { media: queuedMedia.media } : {}) }],
        "compacting",
      );
      this.commandReceipts.set(parsed.submissionId, receipt);
      return receipt;
    }
    // 浏览器运行态可能因 SSE 收尾/重连竞态落后于 host。Pi SDK 在空闲时
    // steer() 只入 steering queue、不会启动 LLM，消息会静默挂起；由 host
    // 以权威运行态决定：运行中保留原生 steer，空闲时转成下一轮 prompt。
    // flushingFollowUp 也视为 busy：让引导进入即将投递的下一轮，而不是
    // 和 Host 的队列 flush 并发启动两个 prompt。
    const resolvedSteerImages = this.resolvePromptImages(parsed.images);
    if (resolvedSteerImages.missing.length) {
      console.error("[pidance] steer image missing on disk:", resolvedSteerImages.missing);
      const failed = this.reject(parsed.submissionId, "media");
      this.commandReceipts.set(parsed.submissionId, failed);
      return failed;
    }
    if (!this.isRunning() && !this.flushingFollowUp) {
      const inner = await this.send({
        type: "prompt",
        message: parsed.message,
        images: parsed.images,
        streamingBehavior: "steer",
      }) as PromptReceipt;
      // 空闲引导实际生效动作是 prompt（含压缩中自动入队的情形）：
      // 必须回给客户端，否则 UI 会按「已引导」显示实际已入队/未发出的消息。
      const receipt: PromptReceipt = {
        ...inner,
        submissionId: parsed.submissionId,
        action: inner.status === "accepted" ? "prompt" : "queued",
      };
      this.commandReceipts.set(parsed.submissionId, receipt);
      return receipt;
    }
    // 没有**可消费的活跃 run**（例如 prompt 还在 preflight：promptRunning 为真但
    // SDK 尚未 streaming）时，原生 steer 只写进谁都不会读的 steering queue：
    // 既不落盘也不投递，UI 上这条引导永远等不到。这种情形必须转为持久队列（F7）。
    if (!session.isStreaming) {
      const queuedMedia = this.queueMediaFromPromptImages(parsed.images);
      if (!queuedMedia.ok) {
        const failed = this.reject(parsed.submissionId, "media");
        this.commandReceipts.set(parsed.submissionId, failed);
        return failed;
      }
      const receipt = this.enqueuePayloads(
        parsed.submissionId,
        [{ text: parsed.message, ...(queuedMedia.media?.length ? { media: queuedMedia.media } : {}) }],
        "busy",
      );
      this.commandReceipts.set(parsed.submissionId, receipt);
      return receipt;
    }
    await session.steer(parsed.message, resolvedSteerImages.images as never);
    const receipt: PromptReceipt = {
      submissionId: parsed.submissionId,
      sessionId: this.realSessionId,
      status: "accepted",
      action: "steer",
    };
    this.commandReceipts.set(parsed.submissionId, receipt);
    return receipt;
  }

  /**
   * 注册销毁通知，返回退订函数。
   *
   * 曾经是单槽赋值：registry 的清理回调会被随后连接的 SSE 覆盖，第二条 SSE 又
   * 覆盖第一条 —— 于是死 host 留在 registry、只有最后一条流收到关闭通知。
   */
  onDestroy(cb: () => void): () => void {
    this.destroyCallbacks.add(cb);
    return () => {
      this.destroyCallbacks.delete(cb);
    };
  }

  onEvent(listener: SdkEventListener): () => void {
    const hadNone = this.listeners.length === 0;
    this.listeners.push(listener);
    if (hadNone) this.resetIdleTimer(); // 首个订阅者：取消 dispose 倒计时
    return () => {
      const had = this.listeners.length > 0;
      this.listeners = this.listeners.filter((l) => l !== listener);
      // 最后一个端点关闭：settled 且空队列时开始 30s 兜底释放
      if (had && this.listeners.length === 0) this.resetIdleTimer();
    };
  }

  /**
   * 连接首帧快照：当前流式消息 + 活跃工具的最新 start/update。
   *
   * 回放对象就是原本要 emit 的投影事件（带 streamRunSeq / renderedLines），
   * 所以浏览器侧不需要第二条解释路径。`isStreaming` 告诉连接方要不要先把
   * 运行态对齐——不对齐的话，紧随其后的 message_* 会被当成过期帧丢掉。
   */
  connectionSnapshot(): StreamSnapshot {
    const snapshot = this.streamSnapshot.snapshot();
    // 带上本轮序号：首帧回放不含 `agent_start`（快照缓存会在 agent_start 时清空），
    // 客户端只会在 `agent_start` 里写序号。不带的后果是把本轮终止事件当
    // 「迟到的上一轮」丢掉，运行态落不下来。
    return this.streamRunSeq > 0 ? { ...snapshot, streamRunSeq: this.streamRunSeq } : snapshot;
  }

  beginExtensionBinding(): void {
    /* start() 内 bind */
  }

  async waitForExtensionsBound(): Promise<void> {
    /* start 已 await bind */
  }

  private emit(event: SdkAgentEvent): void {
    // 先更新连接快照，再分发：新连接的首帧回放与这条事件流同形，
    // 不能出现「已经 emit 但快照没记住」的窗口。
    this.streamSnapshot.remember(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[pidance] sdk host listener error:", err);
      }
    }
  }

  private notifyRunning(): void {
    this.options.onRunningChange?.();
  }

  /**
   * 本会话名下是否还有正在跑的子代理 run。
   *
   * 为什么宿主不能在这时候回收：pi-subagents 完成子代理时是在**启动该 run 的扩展实例**里
   * `pi.sendMessage({customType:"subagent-notify"}, {triggerTurn:true})` 唤起父会话。
   * 宿主一旦 dispose，扩展实例就没了——完成事件没有监听者，用户看到的是「子代理跑完了，
   * 主会话没被唤起」，只能等下次打开会话时补投一条不触发 turn 的通知。
   *
   * 代价（有意接受）：正在跑子代理期间本 host 继续持有 writer 租约。读取 run 记录失败
   * 一律按「没有」处理（宁可回收，也不要因为读不到记录而永久占着租约）。
   */
  private hasActiveSubagentRun(): boolean {
    const sessionFile = this.realSessionFile;
    if (!sessionFile) return false;
    try {
      const { runs } = listSubagentRuns({ limit: 50 });
      return hasActiveSubagentRunForSession(runs, sessionFile);
    } catch {
      return false;
    }
  }

  /**
   * 本会话名下是否还有本宿主不能丢的外部工作：子代理 run，或扩展注册的自持活
   * （MCP 子进程/长任务，见 lib/session-liveness.ts）。
   *
   * fail-closed：扩展 provider 抛错按「不活跃」处理，否则一个抛错的扩展能让会话与
   * 跨进程 writer 租约永久不释放（与上面 subagent 判定同一取舍；上游是 fail-open，
   * 这是有意分叉）。
   */
  private hasActiveExternalWork(): boolean {
    if (this.hasActiveSubagentRun()) return true;
    return hasRegisteredExternalWork({
      sessionId: this.realSessionId,
      sessionFile: this.realSessionFile,
    });
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this._alive || !this.runtime || this.startupHold || this.isRunning() || this.flushingFollowUp) return;
    // 自动投递由 Host 拥有，不依赖是否还有浏览器订阅。有人看只是推迟 dispose。
    if (this.hasWaitingFollowUp() && !this.isFollowUpHeld()) {
      this.scheduleFollowUpFlush();
      return;
    }
    if (this.listeners.length > 0) return;
    // Live host 是 JSONL writer。所有端点都关闭且 settled、空队列时才释放：
    // 立即 dispose 会让浏览器侧 contextUsage/extension footer/状态条随 live 投影
    // 消失（用户感知“会话一结束信息就没了”）。30s 兜底窗口给端点重连/重开，
    // 期间 UI 仍可读热 state；窗口内任何命令/事件都会 reset。
    const delay = this.idleTimeoutMs;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.isRunning() || this.flushingFollowUp) return;
      if (this.hasWaitingFollowUp() && !this.isFollowUpHeld()) {
        this.scheduleFollowUpFlush();
        return;
      }
      // fire 时又出现订阅者（30s 窗口内端点重开）：取消释放，继续保活。
      if (this.listeners.length > 0) return;
      // 本会话名下还有子代理/扩展后台工作在跑：保活到它结束，否则完成事件没有
      // owner 宿主可投递，父会话不会被唤起（见 hasActiveSubagentRun 与
      // hasActiveExternalWork 的注释）。每轮空闲窗口复查一次。
      if (this.hasActiveExternalWork()) {
        this.resetIdleTimer();
        return;
      }
      // 有队列且未 hold：由 flush 流程推进，不在这里 dispose。
      void this.destroyAsync().catch(() => {
        /* 命令仍在进行（busy）：命令结束后的 resetIdleTimer 会再次触发回收 */
      });
    }, delay);
  }

  private releaseStartupHold(): void {
    if (!this.startupHold) return;
    this.startupHold = false;
    if (this.startupHoldTimer) clearTimeout(this.startupHoldTimer);
    this.startupHoldTimer = null;
  }

  private isSettled(): boolean {
    if (!this.runtime || !this._alive) return false;
    return !this.isRunning();
  }

  private isFollowUpHeld(): boolean {
    const prefs = readPidancePrefs(this.agentDir);
    return getPidancePref(prefs, `sessionQueueHold.${this.realSessionId}`) === true;
  }

  private setFollowUpHeld(held: boolean): void {
    try {
      updatePidancePref(
        `sessionQueueHold.${this.realSessionId}`,
        held ? true : null,
        this.agentDir,
      );
    } catch (error) {
      // hold 是「队列不许自动投递」的唯一开关：写失败必须让用户看见，
      // 不能只打 console——否则 abort/error 之后队列会静默自动发出。
      console.error("[pidance] failed to persist follow-up hold:", error);
      this.emit({
        type: "follow_up_flush_error",
        errorMessage: held
          ? "failed to persist follow-up hold; the queue may flush automatically"
          : "failed to clear follow-up hold; the queue may stay held",
        ...this.queueReceiptBase(),
      });
    }
  }

  /**
   * 已受理写入的尝试令牌（与队列同进同出，见 session-queue 的 admittedAttemptIds）。
   *
   * 它是客户端判断「我的写入到底进没进队列」的唯一凭据：受理即记录，客户端拿到
   * 快照就能区分「队列持有」与「从未移交」，不再靠请求失败/成功或正文推测。
   */
  private followUpAdmittedAttemptIds: string[] = [];

  private hydrateFollowUpQueue(): void {
    if (this.followUpQueueHydrated) return;
    this.followUpQueueHydrated = true;
    const prefs = readPidancePrefs(this.agentDir);
    const raw = getPidancePref(prefs, `sessionQueue.${this.realSessionId}`);
    // 解码只走共享 decoder：写入方与启动恢复必须同一套判定，
    // 否则格式升级后恢复扫描会静默漏掉当前格式的队列。
    const decoded = parseFollowUpQueue(raw);
    this.followUpQueue = decoded.items.map((item) => (
      // claimed 是「已提交 SDK、未拿到受理结果」。重启后该结果永远无法得知：
      // 当 waiting 会自动重投（重复消费），丢掉又可能从未送达。保留内容但标成
      // unknown，既不自动重投也不静默删除，由用户显式清队决定。
      item.state === "claimed" ? { ...item, state: "unknown" as const } : item
    ));
    this.followUpQueueRevision = decoded.revision;
    this.followUpAdmittedAttemptIds = decoded.admittedAttemptIds;
    // 引用落地校验：文件没了（用户删过、盘被清）就不能再拿它当"完整载荷"。
    // 丢掉缺失的引用并降级为 unknown：不自动重投，由用户显式取消或重新附图。
    this.followUpQueue = this.followUpQueue.map((item) => {
      if (!item.media?.length) return item;
      const alive = item.media.filter((ref) => this.isQueueMediaRefAlive(ref));
      if (alive.length === item.media.length) return item;
      const dropped: FollowUpItem = alive.length ? { ...item, media: alive } : { text: item.text, id: item.id, state: item.state };
      return { ...dropped, state: "unknown" as const };
    });
  }

  /** 等待投递的条目：`unknown` 绝不自动投递，`claimed` 已认领（在途）。 */
  private waitingFollowUp(): FollowUpItem[] {
    return this.followUpQueue.filter((item) => item.state === "waiting");
  }

  private hasWaitingFollowUp(): boolean {
    return this.followUpQueue.some((item) => item.state === "waiting");
  }

  /** 客户端可见的队列快照：waiting + unknown（claimed 在途，不进列表）。 */
  private visibleFollowUp(): FollowUpItem[] {
    return this.followUpQueue.filter((item) => item.state !== "claimed");
  }

  private inFlightFollowUpTexts(): string[] {
    return this.followUpQueue.filter((item) => item.state === "claimed").map((item) => item.text);
  }

  /**
   * 队列唯一提交点：候选状态**先落盘、成功才发布到内存**，返回是否成功。
   *
   * 之前是「先改内存 → persist 内部 try/catch 吞掉错误」，接口无论写盘成败都回 ok；
   * 于是崩溃/重启后要么丢队列，要么让旧队列复活（已确认送达的内容被再投一次）。
   * 调用方必须用返回值判断，失败时不得声称已受理。
   */
  private commitFollowUpQueue(
    items: FollowUpItem[],
    reason: string,
    admittedAttempts: readonly (string | undefined)[] = [],
  ): boolean {
    // 写出的东西必须满足自身 decoder 的 round-trip：单条目媒体引用超过上限时
    // 解码会整条丢弃（重启后 claimed 条目连同它的图一起消失）。这里 fail-closed
    // 而不是写出自己读不懂的数据（F10）。
    for (const item of items) {
      if ((item.media?.length ?? 0) > MAX_QUEUED_ITEM_MEDIA) {
        console.error(
          `[pidance] refusing to persist follow-up queue (${reason}): item media exceeds ${MAX_QUEUED_ITEM_MEDIA}`,
        );
        return false;
      }
    }
    const nextRevision = this.followUpQueueRevision + 1;
    // 令牌与队列在同一次写盘里落地：不能出现「队列受理了、令牌没记住」的窗口。
    const admittedAttemptIds = withAdmittedAttemptIds(this.followUpAdmittedAttemptIds, admittedAttempts);
    try {
      updatePidancePref(
        `sessionQueue.${this.realSessionId}`,
        serializeFollowUpQueue({ items, revision: nextRevision, admittedAttemptIds }),
        this.agentDir,
      );
    } catch (error) {
      console.error(`[pidance] failed to persist follow-up queue (${reason}):`, error);
      return false;
    }
    this.followUpQueue = items;
    this.followUpQueueRevision = nextRevision;
    this.followUpAdmittedAttemptIds = admittedAttemptIds;
    // 落盘成功即重新解锁：一次成功的写入就是对 fail-closed 状态的显式重试。
    this.followUpFlushBlocked = false;
    return true;
  }

  /**
   * 投递完成后回收本次的模型副本。
   *
   * 模型副本的用途是「投递时回读成内联图片」；已受理后内联字节在会话 JSONL 里，
   * 文件不再被任何人引用。原图/预览**不删**：二进制消息卡片指向它们，删了下载
   * 就 404。仍在队列里的引用（如另一次投递失败）同样不动。
   */
  private discardDeliveredModelMedia(media: readonly QueuedMediaRef[]): void {
    const stillReferenced = new Set(followUpItemMedia(this.followUpQueue).map((ref) => ref.path));
    for (const ref of media) {
      if (ref.role !== "model" || stillReferenced.has(ref.path)) continue;
      deleteChatAttachmentMedia(ref.path, this.agentDir);
    }
  }

  /** 把指定 id 的条目改成给定状态；返回新数组（不改内存）。 */
  private withFollowUpState(ids: readonly string[], state: FollowUpItem["state"]): FollowUpItem[] {
    const wanted = new Set(ids);
    return this.followUpQueue.map((item) => (wanted.has(item.id) ? { ...item, state } : item));
  }

  private queueReceiptBase() {
    return {
      revision: this.followUpQueueRevision,
      items: this.visibleFollowUp(),
      inFlight: this.inFlightFollowUpTexts(),
      admittedAttemptIds: [...this.followUpAdmittedAttemptIds],
    };
  }

  private reject(submissionId: string, reason: PromptReason): PromptReceipt {
    return { submissionId, sessionId: this.realSessionId, status: "rejected", reason };
  }

  /**
   * 媒体引用是否可用且可信（附件目录内的可读常规文件 + 尺寸限额）。
   *
   * 路径校验是信任边界：客户端不能拿任意路径让 Host 读来发给模型。引用必须先
   * 过这里才允许入队——入队后再发现读不出来，整批投递就被阻塞了。
   */
  private isQueueMediaRefAlive(ref: QueuedMediaRef): boolean {
    const max = ref.role === "model" ? QUEUE_MODEL_MEDIA_MAX_BYTES : CHAT_ATTACHMENT_MAX_BYTES;
    const size = chatAttachmentMediaSize(ref.path, this.agentDir);
    return size !== null && size <= max;
  }

  private validateQueueMedia(media: readonly QueuedMediaRef[] | undefined): boolean {
    if (!media?.length) return true;
    if (media.length > MAX_QUEUED_ITEM_MEDIA) return false;
    let total = 0;
    for (const ref of media) {
      const size = chatAttachmentMediaSize(ref.path, this.agentDir);
      if (size === null) return false;
      const max = ref.role === "model" ? QUEUE_MODEL_MEDIA_MAX_BYTES : CHAT_ATTACHMENT_MAX_BYTES;
      if (size > max) return false;
      total += size;
      if (ref.previewPath && chatAttachmentMediaSize(ref.previewPath, this.agentDir) === null) return false;
    }
    return total <= CHAT_ATTACHMENT_MAX_TOTAL_BYTES;
  }

  /**
   * 从附件目录回读整批模型副本（内联给 SDK 的图片）。
   *
   * 返回缺失列表而不是「静默降级成纯文本」：图片读不出来意味着这段内容没被
   * 完整保存，调用方必须 fail-closed（不投递、条目留在队列），否则用户的消息
   * 会在无人知觉的情况下少了一半。
   */
  private readQueueModelImages(items: readonly FollowUpItem[]): { images: PromptImage[]; missing: string[] } {
    const images: PromptImage[] = [];
    const missing: string[] = [];
    for (const ref of followUpItemMedia(items)) {
      if (ref.role !== "model") continue;
      const data = readChatAttachmentBase64(ref.path, this.agentDir, QUEUE_MODEL_MEDIA_MAX_BYTES);
      if (!data) {
        missing.push(ref.path);
        continue;
      }
      images.push({ type: "image", data, mimeType: ref.mimeType });
    }
    return { images, missing };
  }

  /** 原图引用 → 二进制消息卡片（与直接发送的 binaryBlocks 同一形状）。 */
  private queueBinaryBlocks(items: readonly FollowUpItem[]): BinaryMessageInput[] {
    return followUpItemMedia(items)
      .filter((ref) => ref.role === "original")
      .map((ref) => ({
        path: ref.path,
        name: ref.name,
        mimeType: ref.mimeType,
        size: ref.size,
        ...(ref.previewPath ? { previewPath: ref.previewPath } : {}),
      }));
  }

  /**
   * 整包写入等待队列（CAS + 落盘）。
   *
   * 在途条目（claimed）不参与对齐也不被移除：“取消”不能把已提交给 Pi 的一批
   * 当成取消成功（旧实现的取消回执是假的）；清队只影响尚未投递的内容。
   */
  private writeFollowUpQueue(
    payloads: readonly QueueItemPayload[],
    expectedRevision: number | null,
  ): QueueWriteReceipt {
    if (expectedRevision !== null && expectedRevision !== this.followUpQueueRevision) {
      return { ok: false, conflict: true, reason: "revision", ...this.queueReceiptBase() };
    }
    // 引用先校验再入队：条目一旦可见，它的文件就必须可读且可信（路径在附件目录
    // 内、尺寸在限额内）。入队后再发现读不出来，会让整批投递被阻塞。
    for (const payload of payloads) {
      if (!this.validateQueueMedia(payload.media)) {
        return { ok: false, persist: true, ...this.queueReceiptBase() };
      }
    }
    const claimed = this.followUpQueue.filter((item) => item.state === "claimed");
    const pool = this.followUpQueue.filter((item) => item.state !== "claimed");
    // 写入载荷里若带着「已经在途（claimed）」的条目身份，说明客户端看到的还是它
    // 入队前的那份快照：把它当新条目加回等待队列会被投递第二次。身份在途即忽略
    // （它仍在 inFlight 里如实显示）。
    const next = [
      ...claimed,
      ...reconcileFollowUpItems(pool, payloads, {
        inFlightIds: claimed.map((item) => item.id),
      }),
    ];
    if (!this.commitFollowUpQueue(
      next,
      "set",
      payloads.map((payload) => payload.attemptId),
    )) {
      // 落盘失败：内存保持原状，不得声称已入队（否则 UI 认为已保存，重启后不存在）。
      return { ok: false, persist: true, ...this.queueReceiptBase() };
    }
    return { ok: true, ...this.queueReceiptBase() };
  }

  /**
   * 条目级召回：把指定条目原子地从等待队列移除并交还给调用方（H2）。
   *
   * 为什么不是「清空整队」：清队无法证明「调用方捕获的那几条已移交」——期间被
   * 别的视图整队投递（claimed）或落盘失败的条目根本不可撤回。这里按 id 取，
   * 只移除 really 可移交的条目，回执如实回报 recalled / skipped。
   *
   * `unknown` 允许取回：它本来就永不自动重投，交回草稿 = 用户显式重新决定；
   * `claimed` 拒绝：已提交给 Pi，把「撤回」当取消成功是谎话。
   */
  private recallFollowUpQueue(itemIds: readonly string[]): QueueRecallReceipt {
    const recalled: FollowUpItem[] = [];
    const skipped: { id: string; reason: "claimed" | "missing" }[] = [];
    for (const id of itemIds) {
      const item = this.followUpQueue.find((candidate) => candidate.id === id);
      if (!item) {
        skipped.push({ id, reason: "missing" });
        continue;
      }
      if (item.state === "claimed") {
        skipped.push({ id, reason: "claimed" });
        continue;
      }
      recalled.push(item);
    }
    if (!recalled.length) {
      // 没有任何条目可移交：不写盘、不动 revision，如实回报（调用方不得把
      // 「队列还在」当成取回成功）。
      return { ok: true, ...this.queueReceiptBase(), recalled: [], skipped };
    }
    const recallIds = new Set(recalled.map((item) => item.id));
    const next = this.followUpQueue.filter((item) => !recallIds.has(item.id));
    if (!this.commitFollowUpQueue(next, "recall")) {
      // 落盘失败：内存未变，撤回不得算成功。
      return { ok: false, persist: true, ...this.queueReceiptBase(), recalled: [], skipped };
    }
    this.emitQueueChanged();
    this.resetIdleTimer();
    return { ok: true, ...this.queueReceiptBase(), recalled, skipped };
  }

  /**
   * 入队唯一入口（内部）：文本可靠落盘才算受理。
   *
   * `queued` 回执的含义是「已持久化到产品队列」；落盘失败必须回 rejected，
   * 客户端才会把内容留在输入框而不是当成已保存。
   */
  private enqueuePayloads(
    submissionId: string,
    payloads: readonly QueueItemPayload[],
    reason?: PromptReason,
  ): PromptReceipt {
    // 现有条目只回正文：reconcile 会保留它们原本的图片引用（不能因为一次
    // 「只传正文」的写入而把已有队列的图删掉）。
    const write = this.writeFollowUpQueue(
      [
        ...this.visibleFollowUp().map((item) => ({ text: item.text })),
        ...payloads,
      ],
      null,
    );
    if (!write.ok) return this.reject(submissionId, "error");
    this.emitQueueChanged();
    if (this.isSettled() && this.hasWaitingFollowUp()) this.scheduleFollowUpFlush();
    this.resetIdleTimer();
    return {
      submissionId,
      sessionId: this.realSessionId,
      status: "queued",
      action: "queued",
      ...(reason ? { reason } : {}),
      queue: {
        items: write.items,
        inFlight: write.inFlight,
        revision: write.revision,
        admittedAttemptIds: [...this.followUpAdmittedAttemptIds],
      },
    };
  }

  /**
   * 客户端提交的图片输入（内联 base64 或附件引用）→ 队列媒体引用。
   *
   * 引用直接透传（字节已在盘上）；内联 base64 只可能来自旧客户端或扩展直调，
   * 此时落盘成模型副本，队列条目同样只持引用。`ok: false` = 有条目没能落盘/
   * 不可读，调用方必须回绝而不是入队：入队一个读不出图的条目，投递时只能
   * 静默丢图。
   */
  private queueMediaFromPromptImages(
    images: readonly PromptImageInput[] | undefined,
  ): { media: QueuedMediaRef[] | undefined; ok: boolean } {
    if (!images?.length) return { media: undefined, ok: true };
    const media: QueuedMediaRef[] = [];
    for (const [index, image] of images.entries()) {
      if (image.type === "ref") {
        const size = chatAttachmentMediaSize(image.path, this.agentDir);
        if (size === null || size > QUEUE_MODEL_MEDIA_MAX_BYTES) return { media: undefined, ok: false };
        media.push({
          role: "model",
          path: image.path,
          name: image.path.split(/[\\/]/).pop() ?? `image-${index}`,
          mimeType: image.mimeType,
          size,
        });
        continue;
      }
      let saved: SavedChatAttachment;
      try {
        saved = saveChatAttachmentBytes(
          `prompt-image-${index}.${imageExtension(image.mimeType)}`,
          Buffer.from(image.data, "base64"),
          this.agentDir,
        );
      } catch (error) {
        console.error("[pidance] inline prompt image could not be stored:", error);
        return { media: undefined, ok: false };
      }
      media.push({
        role: "model",
        path: saved.path,
        name: saved.name,
        mimeType: image.mimeType,
        size: saved.size,
      });
    }
    return { media, ok: true };
  }

  /**
   * 提交给 SDK 的内联图片：引用从附件目录回读为 base64。
   *
   * 读不出来就报 missing（调用方按结构化回绝处理）——静默降级成纯文本会让用户
   * 以为图发出去了。
   */
  private resolvePromptImages(
    images: readonly PromptImageInput[] | undefined,
  ): { images: PromptImage[] | undefined; missing: string[] } {
    if (!images?.length) return { images: undefined, missing: [] };
    const resolved: PromptImage[] = [];
    const missing: string[] = [];
    for (const image of images) {
      if (image.type !== "ref") {
        resolved.push(image);
        continue;
      }
      const data = readChatAttachmentBase64(image.path, this.agentDir, QUEUE_MODEL_MEDIA_MAX_BYTES);
      if (!data) {
        missing.push(image.path);
        continue;
      }
      resolved.push({ type: "image", data, mimeType: image.mimeType });
    }
    return { images: resolved.length ? resolved : undefined, missing };
  }

  /**
   * 整队转引导（原子：清队与投递是同一个服务端用例）。
   *
   * 旧实现是浏览器上的补偿 saga（清队 → 发 steer → 失败回填）：它会把 A 会话的
   * 队列写回到切换后的 B，也无法判断清队之后是否已有在途批次被投递。
   * 这里先按 id 认领并落盘，再投递；投递未被受理则把认领还回等待队列。
   */
  private async dispatchFollowUpQueue(
    command: DispatchFollowUpQueueCommand,
  ): Promise<QueueDispatchReceipt> {
    if (this.bashRunning) {
      return { ok: false, status: "rejected", reason: "bash", ...this.queueReceiptBase() };
    }
    if (this.session.isCompacting) {
      // 压缩中不能起 run（服务端 prompt 也只会重新入队）：明确回绝并告知原因，
      // 载荷留在队列里由压缩结束后的自动投递处理——不能谎报成「已派发」。
      return { ok: false, status: "rejected", reason: "compacting", ...this.queueReceiptBase() };
    }
    if (this.flushingFollowUp || this.dispatchingFollowUpQueue) {
      // 自动投递或另一次手动派发正在消费队列：再派发会让同一批内容投递两次。
      return { ok: false, conflict: true, reason: "in-flight", ...this.queueReceiptBase() };
    }
    if (command.expectedRevision !== null && command.expectedRevision !== this.followUpQueueRevision) {
      return { ok: false, conflict: true, reason: "revision", ...this.queueReceiptBase() };
    }
    const queued = this.waitingFollowUp();
    const extra = command.extra?.trim();
    if (queued.length === 0 && !extra) {
      return { ok: false, status: "rejected", reason: "error", ...this.queueReceiptBase() };
    }
    // 整批合并为唯一副本：正文与媒体一起带上（少一张就是静默丢内容，
    // 多一张就是投递了用户已经取回的内容）。
    const { text } = mergeFollowUpPayload(queued, extra);
    // 认领之前先验证媒体可读：认领之后才发现图丢了，就只能要么丢图、要么留下一个
    // 永远发不出去的 claimed 条目。
    const precheck = this.readQueueModelImages(queued);
    if (precheck.missing.length) {
      console.error("[pidance] queued media missing, dispatch rejected:", precheck.missing);
      return { ok: false, status: "rejected", reason: "media", ...this.queueReceiptBase() };
    }
    const dispatchBinaryBlocks = this.queueBinaryBlocks(queued);
    // 认领：把本批 waiting 换成**逐条的 claimed 副本**（正文/媒体都是原条目自己的）。
    // 不合并成一条：合并后的媒体引用数可以超过 decoder 的单条上限，于是认领写下的
    // 东西自己读不回来——重启时那条 durable claim 整个消失（F10）。逐条认领同时
    // 保留条目边界，投递失败归还时不会把多张图挤进同一条。
    const claims = queued.map((item) => (item.media?.length
      ? newFollowUpItem(item.text, "claimed", item.media)
      : newFollowUpItem(item.text, "claimed")));
    // extra（输入框并入队尾的那段）也单独成条，同属本次投递。
    if (extra) claims.push(newFollowUpItem(extra, "claimed"));
    const claimIds = claims.map((item) => item.id);
    const claimIdSet = new Set(claimIds);
    // 只把本批 waiting 换成副本：**未参与派发的条目（claimed / unknown）必须原样保留**。
    // 旧实现只保留 claimed，会把 unknown（上次崩溃前已发出、结果未知）连同它的图一起删掉。
    const next = [...this.followUpQueue.filter((item) => item.state !== "waiting"), ...claims];
    // extra 此时被正式受理（已进队列，接下来才是投递）：记下令牌，客户端不得再
    // 把它当「未入队」恢复成草稿。
    if (!this.commitFollowUpQueue(next, "dispatch-claim", [command.extraAttemptId])) {
      return { ok: false, status: "rejected", reason: "error", ...this.queueReceiptBase() };
    }
    this.dispatchingFollowUpQueue = true;
    this.emitQueueChanged();
    // 认领条目已带上合并后的图片引用：从文件回读为 SDK 载荷（整队转引导也不能丢图）。
    const dispatchImages = precheck.images.length ? precheck.images : undefined;
    let action: "prompt" | "steer" | "queued" = "prompt";    try {
      // 可消费 steer 的判据是 SDK 的活跃 run（session.isStreaming），不是 isSettled()：
      // promptRunning 还包含 preflight，compact-only 也不是可消费 run（旧实现会在
      // 这两种情况下把消息发成只入内存的 SDK steer，UI 上永远等不到它）。
      if (this.session.isStreaming) {
        action = "steer";
        await this.session.steer(text, dispatchImages as never);
      } else {
        // streamingBehavior：投递瞬间若恰有新 run 起步，SDK 入引导而不是报错。
        const receipt = await this.send(
          {
            type: "prompt",
            message: text,
            ...(dispatchImages?.length ? { images: dispatchImages } : {}),
            ...(dispatchBinaryBlocks.length ? { binaryBlocks: dispatchBinaryBlocks } : {}),
            streamingBehavior: "steer",
          },
          this.internalPromptTicket,
        ) as PromptReceipt;
        if (receipt?.status === "queued") {
          // 服务端把载荷可靠放进了产品队列（compacting 等）：删除本次认领，
          // 由队列里的新副本负责投递。不能既算已派发又留在队列（重复投递）。
          action = "queued";
          this.commitFollowUpQueue(
            this.followUpQueue.filter((item) => !claimIdSet.has(item.id)),
            "dispatch-queued",
          );
          this.emitQueueChanged();
          this.resetIdleTimer();
          return { ok: true, status: "accepted", action, ...this.queueReceiptBase() };
        }
        if (receipt?.status !== "accepted") {
          // 结构化拒绝：认领回队列（内容不消失），由用户重试。
          this.commitFollowUpQueue(this.withFollowUpState(claimIds, "waiting"), "dispatch-release");
          this.emitQueueChanged();
          return {
            ok: false,
            status: "rejected",
            reason: receipt?.reason ?? "error",
            ...this.queueReceiptBase(),
          };
        }
      }
    } catch (error) {
      // 未被受理 / 网络失败：归还认领（内容不得消失）。归还落盘失败时条目留 claimed：
      // 它不会被自动重投，重启后转 unknown 由用户处置。
      const released = this.commitFollowUpQueue(this.withFollowUpState(claimIds, "waiting"), "dispatch-release");
      this.emitQueueChanged();
      if (!released) {
        this.emit({
          type: "follow_up_flush_error",
          errorMessage: "dispatch rejected and the claim could not be released; it stays claimed for the user to inspect",
          ...this.queueReceiptBase(),
        });
      }
      return {
        ok: false,
        status: "rejected",
        reason: classifyPromptRejection(error),
        ...this.queueReceiptBase(),
      };
    } finally {
      this.dispatchingFollowUpQueue = false;
    }
    // 已受理：删除认领条目并落盘。
    const dispatchedMedia = followUpItemMedia(claims);
    const removed = this.commitFollowUpQueue(
      this.followUpQueue.filter((item) => !claimIdSet.has(item.id)),
      "dispatch-deliver",
    );
    if (removed) this.discardDeliveredModelMedia(dispatchedMedia);
    this.emitQueueChanged();
    this.resetIdleTimer();
    return { ok: true, status: "accepted", action, ...this.queueReceiptBase() };
  }

  private scheduleFollowUpFlush(): void {
    if (!this._alive || !this.runtime) return;
    if (this.flushingFollowUp) return;
    // 认领落盘失败后 fail-closed：不自动重试（否则 resetIdleTimer → 本函数
    // 会立刻重入同一失败，磁盘写不进去时无限循环）。
    if (this.followUpFlushBlocked) return;
    if (this.isFollowUpHeld()) return;
    if (this.dispatchingFollowUpQueue) return;
    if (!this.isSettled()) return;
    const waiting = this.waitingFollowUp();
    if (waiting.length === 0) return;
    const asOne = readPidancePrefs(this.agentDir).queueFlushAsOne === true;
    this.flushingFollowUp = true;
    // 投递单元只固定**身份**（之后按 id 认领）：正文在认领时从存活条目重新取，
    // 否则用户清掉的条目会跟着旧批次发出去（也避免同文本条目被误删）。
    this.followUpFlushUnits = asOne
      ? [{ ids: waiting.map((item) => item.id) }]
      : waiting.map((item) => ({ ids: [item.id] }));
    this.followUpFlushCursor = 0;
    const unit0 = this.followUpFlushUnits[0];
    setTimeout(() => {
      if (this.flushingFollowUp && this.followUpFlushUnits[this.followUpFlushCursor] === unit0) {
        void this.sendNextFollowUp();
      }
    }, 0);
  }

  /** 队列权威快照下发给其它标签页/端点（跨 tab 同一会话）。 */
  private emitQueueChanged(): void {
    const base = this.queueReceiptBase();
    this.emit({
      type: "follow_up_queue_changed",
      sessionId: this.realSessionId,
      items: base.items,
      revision: base.revision,
      inFlight: base.inFlight,
      admittedAttemptIds: base.admittedAttemptIds,
    });
  }

  private async sendNextFollowUp(): Promise<void> {
    if (this.followUpSending) return;
    if (!this.flushingFollowUp) return;
    if (this.isFollowUpHeld()) {
      this.abortFollowUpFlush();
      return;
    }
    const unit = this.followUpFlushUnits[this.followUpFlushCursor];
    if (unit === undefined) {
      this.finishFollowUpFlush();
      return;
    }
    if (!this.isSettled()) {
      // 上一轮 run 尚未完全落定（SDK streaming 尾态）。不能静默 return：
      // 等 agent_settled 事件推进；这里兜底一拍后重试，防事件与 streaming
      // 清态错位导致整队卡死或漏发。此时**尚未认领**，条目仍在队列里。
      setTimeout(() => {
        if (this.flushingFollowUp && this.followUpFlushUnits[this.followUpFlushCursor] === unit) {
          void this.sendNextFollowUp();
        }
      }, 80);
      return;
    }
    this.followUpSending = true;
    try {
      await this.deliverFollowUpUnit(unit);
    } finally {
      this.followUpSending = false;
    }
    if (!this.flushingFollowUp) return;
    this.followUpFlushCursor += 1;
    if (this.followUpFlushCursor >= this.followUpFlushUnits.length) {
      this.finishFollowUpFlush();
    } else {
      void this.sendNextFollowUp();
    }
  }

  /** 单个投递单元：按 id 重取存活条目 → 认领 → 投递 → 按回执出队。 */
  private async deliverFollowUpUnit(unit: { ids: string[] }): Promise<void> {
    // 0) 按 id 重取正文：预检/派发期间被用户清掉的条目不得再发出去
    //    （旧实现用开始时固定的 unit.text，清队后旧批次仍会投递）。
    const wanted = new Set(unit.ids);
    const live = this.followUpQueue.filter(
      (item) => wanted.has(item.id) && item.state === "waiting",
    );
    if (live.length === 0) {
      this.emitQueueChanged();
      return;
    }
    const ids = live.map((item) => item.id);
    // 正文与媒体一同取出：队列条目可以带图（A11），逐条投递时也不能丢图。
    const payload = mergeFollowUpPayload(live);
    const text = payload.text;
    const { images, missing } = this.readQueueModelImages(live);
    const binaryBlocks = this.queueBinaryBlocks(live);
    if (missing.length) {
      // 图片读不出来 = 载荷不完整：不得只发正文把用户的图静静丢掉。
      // 条目保持 waiting，用户可在 UI 里看到它仍排队并自行处置（召回/清队）。
      console.error("[pidance] queued image missing, delivery blocked:", missing);
      this.followUpFlushBlocked = true;
      this.emit({
        type: "follow_up_flush_error",
        errorMessage: "queued image is missing; delivery blocked",
        ...this.queueReceiptBase(),
      });
      this.abortFollowUpFlush();
      return;
    }
    const promptImages = images.length ? images : undefined;
    if (this.session.isCompacting || this.bashRunning) {
      // 此刻不能起 run（手动压缩/shell 占用）：条目仍是 waiting，等结束后再投。
      this.emit({
        type: "follow_up_flush_error",
        errorMessage: this.session.isCompacting
          ? "follow-up delivery deferred while compaction is running"
          : "follow-up delivery deferred while a shell command is running",
        ...this.queueReceiptBase(),
      });
      this.abortFollowUpFlush();
      return;
    }
    // 1) 认领：先落盘 claimed 再投递。崩溃/重启时条目以 claimed 留在磁盘上，
    //    恢复时只能变成 unknown（不自动重投），不会重复消费。
    if (!this.commitFollowUpQueue(this.withFollowUpState(ids, "claimed"), "claim")) {
      // 认领落盘失败：不能投递（投了就是「发出去但没记录」的重复风险）。
      // fail-closed：禁止自动重试，等一次成功的队列写入解锁。
      this.followUpFlushBlocked = true;
      this.emit({
        type: "follow_up_flush_error",
        errorMessage: "failed to persist follow-up queue before delivery",
        ...this.queueReceiptBase(),
      });
      this.abortFollowUpFlush();
      return;
    }
    this.emitQueueChanged();
    let receipt: PromptReceipt | null = null;
    try {
      // 内部票据：只有 flush 自己发起的 prompt 能穿过「投递在途」门禁。
      receipt = await this.send(
        {
          type: "prompt",
          message: text,
          ...(promptImages ? { images: promptImages } : {}),
          // 原图随载荷带上：投递后的消息才有「下载原图」卡片（与直接发送一致）。
          ...(binaryBlocks.length ? { binaryBlocks } : {}),
        },
        this.internalPromptTicket,
      ) as PromptReceipt;
    } catch (error) {
      // 未被受理（preflight 拒绝 / 网络失败）：把认领还回 waiting，内容不得消失。
      const errorMessage = error instanceof Error ? error.message : String(error);
      const released = this.commitFollowUpQueue(this.withFollowUpState(ids, "waiting"), "release");
      this.emit({ type: "follow_up_flush_error", errorMessage, ...this.queueReceiptBase() });
      // 归还落盘失败时条目留在 claimed：它不会被自动重投，重启后转 unknown 由用户处置。
      this.abortFollowUpFlush();
      if (released) this.emitQueueChanged();
      return;
    }
    if (receipt?.status === "queued") {
      // 没有被立即接受，但载荷已被可靠写进产品队列（compacting 等）：删除本次认领，
      // 由队列里的新副本负责投递。不能既算已投递又留在队列（重复投递）。
      this.commitFollowUpQueue(
        this.followUpQueue.filter((item) => !new Set(ids).has(item.id)),
        "deliver-queued",
      );
      // 不发 follow_up_flushed：这条并没有被投递，内容以队列条目形式存在，
      // follow_up_queue_changed 已经是权威快照。
      this.emitQueueChanged();
      this.abortFollowUpFlush();
      return;
    }
    if (receipt && receipt.status !== "accepted") {
      // 结构化拒绝（如另一个 prompt 在途）：认领还回 waiting，不得当成已送达。
      const released = this.commitFollowUpQueue(this.withFollowUpState(ids, "waiting"), "release");
      this.emit({
        type: "follow_up_flush_error",
        errorMessage: `follow-up prompt rejected: ${receipt.reason ?? "unknown"}`,
        ...this.queueReceiptBase(),
      });
      this.abortFollowUpFlush();
      if (released) this.emitQueueChanged();
      return;
    }
    // 2) 已受理：删除本次单元（按 id）并落盘。
    // 2) 已受理：删除本次单元（按 id）并落盘。
    const delivered = new Set(ids);
    const deliveredMedia = followUpItemMedia(live);
    const removed = this.commitFollowUpQueue(
      this.followUpQueue.filter((item) => !delivered.has(item.id)),
      "deliver",
    );
    // 已受理就回收模型副本（内联字节已在 JSONL 里）；队列删除未落盘时条目仍是
    // claimed，discardDeliveredModelMedia 的「仍被引用」判定会放过这批文件。
    if (removed) this.discardDeliveredModelMedia(deliveredMedia);
    this.emit({
      type: "follow_up_flushed",
      sessionId: this.realSessionId,
      item: text,
      ...this.queueReceiptBase(),
    });
    if (!removed) {
      // 已送达但删除没落盘：条目保持 claimed（不会自动重投），重启后转 unknown。
      // 绝不标成 waiting——那会把已送达的内容再投一次。
      this.emit({
        type: "follow_up_flush_error",
        errorMessage: "follow-up delivered but queue removal was not persisted",
        ...this.queueReceiptBase(),
      });
    }
    this.emitQueueChanged();
  }

  private abortFollowUpFlush(): void {
    if (!this.flushingFollowUp) return;
    this.flushingFollowUp = false;
    this.followUpFlushUnits = [];
    this.followUpFlushCursor = 0;
    // 未确认条目仍在 followUpQueue 中（waiting 或 claimed），不需要写盘。
    this.resetIdleTimer();
  }

  private finishFollowUpFlush(): void {
    this.flushingFollowUp = false;
    this.followUpFlushUnits = [];
    this.followUpFlushCursor = 0;
    this.resetIdleTimer();
    if (this.hasWaitingFollowUp() && !this.isFollowUpHeld()) {
      this.scheduleFollowUpFlush();
    }
  }

  private get session(): AgentSession {
    if (!this.runtime) throw new Error("SDK session is not alive");
    return this.runtime.session;
  }

  private get services(): AgentSessionServices {
    if (!this.runtime) throw new Error("SDK session is not alive");
    return this.runtime.services;
  }

  private syncIdentityFromSession(): void {
    const session = this.session;
    const id = session.sessionId || this.realSessionId;
    const file = session.sessionFile || this.realSessionFile;
    const oldId = this.realSessionId;
    this.realSessionId = id;
    this.realSessionFile = file;
    if (file) this.options.cacheSessionPath?.(id, file);
    if (oldId !== id) {
      this.options.onSessionRekeyed?.(oldId, id, this);
    }
  }

  private async rebindSession(): Promise<void> {
    const session = this.session;
    this.extensionUi?.dispose();
    this.extensionUi = createWebExtensionUIAdapter((event) => {
      this.trackExtensionSideEffects(event);
      this.emit(event as SdkAgentEvent);
    });

    await session.bindExtensions({
      uiContext: this.extensionUi.uiContext,
      // "tui"：宿主能渲染扩展自绘的 TUI 组件（custom / overlay / widget 组件工厂）。
      // 插件据此在富路径与降级之间选：pi-subagents 在 rpc 下只发一行 JSON 快照、
      // pi-mcp-adapter 禁用 /mcp 的 overlay、pi-advisor-flow 不进 custom。
      // Pidance 用 headless 渲染桥把组件 render 结果投影成 Web 面板，所以声明 tui。
      mode: "tui",
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: async (opts) => {
          const result = await this.runtime!.newSession(opts);
          if (!result.cancelled) await this.rebindSession();
          return result;
        },
        fork: async (entryId, forkOptions) => {
          const result = await this.runtime!.fork(entryId, forkOptions);
          if (!result.cancelled) await this.rebindSession();
          return { cancelled: result.cancelled };
        },
        navigateTree: async (targetId, options) => {
          const result = await session.navigateTree(targetId, {
            summarize: options?.summarize,
            customInstructions: options?.customInstructions,
            replaceInstructions: options?.replaceInstructions,
            label: options?.label,
          });
          return { cancelled: result.cancelled };
        },
        switchSession: async (sessionPath, options) => {
          const result = await this.runtime!.switchSession(sessionPath, options);
          if (!result.cancelled) await this.rebindSession();
          return result;
        },
        reload: async () => {
          await session.reload();
        },
      },
      onError: (err) => {
        this.setFollowUpHeld(true);
        this.emit({
          type: "extension_error",
          extensionPath: err.extensionPath,
          event: err.event,
          error: err.error,
        });
      },
    });

    this.unsubscribe?.();
    this.unsubscribe = session.subscribe((event) => {
      this.resetIdleTimer();
      this.handleSessionEvent(event as SdkAgentEvent);
    });
    this.syncIdentityFromSession();
  }

  private trackExtensionSideEffects(event: Record<string, unknown>): void {
    if (event.type !== "extension_ui_request") return;
    const method = asString(event.method);
    if (method === "setStatus") {
      const key = asString(event.statusKey) ?? asString(event.key) ?? "default";
      const text = asString(event.statusText) ?? asString(event.text) ?? "";
      if (text) this.extensionUi?.statuses.set(key, text);
      else this.extensionUi?.statuses.delete(key);
    }
    if (method === "setWidget") {
      const key = asString(event.widgetKey) ?? asString(event.key) ?? "default";
      const lines = event.widgetLines ?? event.content;
      if (lines == null) this.extensionUi?.widgets.delete(key);
      else {
        this.extensionUi?.widgets.set(key, {
          lines,
          placement: event.widgetPlacement,
        });
      }
    }
    this.notifyRunning();
  }

  /**
   * 自动命名：会话尚无名字（session_info）时，用第一条用户输入作为会话名。
   * 思维锚（flash-anchor 等 custom 预热条目）不进入 buildSessionContext 的
   * messages（role 非 user），天然被跳过，不会被当成用户输入。
   * 仅在 agent_end 时对无名会话执行一次；命名失败不阻断运行。
   */
  private maybeAutoNameSession(): void {
    try {
      const manager = this.session?.sessionManager;
      if (!manager) return;
      if (manager.getSessionName()) return;
      const context = manager.buildSessionContext() as {
        messages?: Array<{ role?: string; content?: unknown }>;
      };
      const firstUser = (context.messages ?? []).find((message) => message.role === "user");
      const text = firstUserText(firstUser?.content);
      if (text) manager.appendSessionInfo(text);
    } catch {
      /* 自动命名失败不阻断 */
    }
  }

  /**
   * 从 SDK agent_end.messages 最后一条 assistant 消息读取 stopReason。
   * 兼容 messages 为 [{message:{stopReason}}] 与 [{stopReason}] 两种形状。
   */
  private readStopReasonFromAgentEnd(event: SdkAgentEvent): "completed" | "aborted" | "error" | null {
    const messages = (event as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const entry = messages[i] as
        | { message?: { stopReason?: unknown }; stopReason?: unknown }
        | undefined;
      const stop = entry?.message?.stopReason ?? entry?.stopReason;
      if (typeof stop === "string") {
        if (stop === "aborted") return "aborted";
        if (stop === "error" || stop === "prompt_error") return "error";
        return "completed";
      }
    }
    return null;
  }

  private removePendingBinaryBatch(submissionId: string): void {
    this.pendingBinaryBatches = this.pendingBinaryBatches.filter((batch) => batch.submissionId !== submissionId);
  }

  private persistPendingBinaryBlocks(blocks: BinaryMessageData[]): void {
    if (blocks.length === 0) return;
    try {
      const manager = this.session.sessionManager;
      materializeSessionFile(manager);
      const entries = manager.getEntries() as Array<{ id?: string; type?: string; message?: { role?: string } }>;
      const messageEntryId = [...entries].reverse().find(
        (entry) => entry.type === "message" && entry.message?.role === "user" && typeof entry.id === "string",
      )?.id || manager.getLeafId() || undefined;
      for (const block of blocks) {
        const data = messageEntryId ? { ...block, messageEntryId } : block;
        const entryId = manager.appendCustomEntry(PIDANCE_BINARY_CUSTOM_TYPE, data);
        this.emit({
          type: "message_end",
          entryId,
          message: binaryMessageToUiMessage(data, Date.now()),
        });
      }
      materializeSessionFile(manager);
      this.options.onSessionListInvalidate?.();
    } catch (error) {
      console.error("[pidance] persist binary message failed:", error);
    }
  }

  /** 首个可见内容（空壳帧不算）。 */
  private static hasRenderableContent(message: { content?: unknown } | undefined): boolean {
    if (!message) return false;
    const content = message.content;
    if (typeof content === "string") return content.length > 0;
    return Array.isArray(content) && content.length > 0;
  }

  /** provider 上报的 output tokens（不做字符估算）。 */
  private static outputTokensOf(message: { usage?: { output?: unknown } } | undefined): number | null {
    const value = message?.usage?.output;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  }

  /**
   * 吞吐累加（服务端为唯一权威）。
   *
   * 与 dsh 的 turn-metrics 同口径：每个 step 的 decodeMs 是「首 token → 消息结束」
   * 不含 TTFT；只用 provider 上报的 output tokens；只累计两者齐全的 step，
   * 按解码时间加权（Σtokens / ΣdecodeMs），不是各 step 速率的算术平均。
   *
   * @returns 读数是否发生变化（调用方据此决定要不要随事件下发）
   */
  private accumulateTurnMetrics(event: SdkAgentEvent): boolean {
    const now = Date.now();
    if (event.type === "agent_start") {
      this.turnMetrics = { startedAt: now, firstTokenAt: null, ttftMs: null, decodeMs: 0, outputTokens: 0, sampled: false };
      return true;
    }
    if (event.type === "message_start" || event.type === "message_update") {
      const message = event.message as { role?: string; content?: unknown } | undefined;
      if (message?.role === "user") return false;
      if (this.turnMetrics.firstTokenAt === null && SdkSessionHost.hasRenderableContent(message)) {
        this.turnMetrics.firstTokenAt = now;
        const isFirstStep = this.turnMetrics.ttftMs === null;
        if (isFirstStep && this.turnMetrics.startedAt > 0 && now >= this.turnMetrics.startedAt) {
          this.turnMetrics.ttftMs = now - this.turnMetrics.startedAt;
        }
        // TTFT 首帧即下发：顶栏能立刻显示延迟读数
        return isFirstStep;
      }
      return false;
    }
    if (event.type === "message_end") {
      const message = event.message as { role?: string; usage?: { output?: unknown } } | undefined;
      if (message?.role !== "assistant") return false;
      const decodeMs = this.turnMetrics.firstTokenAt === null ? null : Math.max(0, now - this.turnMetrics.firstTokenAt);
      this.turnMetrics.firstTokenAt = null;
      const outputTokens = SdkSessionHost.outputTokensOf(message);
      if (decodeMs !== null && outputTokens !== null) {
        this.turnMetrics.decodeMs += decodeMs;
        this.turnMetrics.outputTokens += outputTokens;
        this.turnMetrics.sampled = true;
        // step 结束：本 step 已计入，下发最新读数（客户端不再自行累计）
        return true;
      }
    }
    return false;
  }

  /** 投影给客户端的读数；起点未知时不编造 TTFT。 */
  private projectTurnMetrics(): { tokensPerSecond?: number; ttftMs?: number } {
    const metrics: { tokensPerSecond?: number; ttftMs?: number } = {};
    if (this.turnMetrics.ttftMs !== null && this.turnMetrics.startedAt > 0) metrics.ttftMs = this.turnMetrics.ttftMs;
    if (this.turnMetrics.sampled && this.turnMetrics.decodeMs > 0) {
      metrics.tokensPerSecond = this.turnMetrics.outputTokens / (this.turnMetrics.decodeMs / 1e3);
    }
    return metrics;
  }

  private handleSessionEvent(event: SdkAgentEvent): void {
    // 吞吐读数是否变化（真值附加到真正 emit 的对象上，见下方 eventToEmit）
    const metricsChanged = this.accumulateTurnMetrics(event);
    // 本轮 SDK run 的本地序号：agent_start 开新一轮，同一轮的所有事件（含收尾的
    // agent_end/prompt_done）带同一个值。客户端据此丢弃迟到的上一轮终止事件——
    // 没有它的话，上一轮的 agent_end 落在新一轮 agent_start 之后会把运行中的 UI
    // 判成空闲（复核 G1）。
    const streamRunSeq = event.type === "agent_start" ? ++this.streamRunSeq : this.streamRunSeq;
    switch (event.type) {
      case "agent_start":
        this.promptRunning = true;
        recordRunningStartedAt(this.realSessionId, Date.now());
        this.notifyRunning();
        break;
      case "agent_end":
        this.promptRunning = false;
        this.lastStopReason = this.readStopReasonFromAgentEnd(event) ?? this.lastStopReason ?? "completed";
        if (this.lastStopReason === "aborted" || this.lastStopReason === "error") {
          this.setFollowUpHeld(true);
        }
        clearRunningStartedAt(this.realSessionId);
        this.options.onSessionListInvalidate?.();
        if (this.realSessionFile) clearLeafSidecar(this.realSessionFile);
        this.maybeAutoNameSession();
        this.notifyRunning();
        this.emit({ type: "prompt_done", streamRunSeq: this.streamRunSeq });
        break;
      case "agent_settled":
        this.promptRunning = false;
        this.notifyRunning();
        // 触发点必须是 agent_settled；agent_end 只记录本轮结果。
        if (this.lastStopReason === "completed") {
          if (this.flushingFollowUp) {
            // 本次投递已在受理后按 id 出队，这里只需推进下一单元。
            void this.sendNextFollowUp();
          } else {
            this.scheduleFollowUpFlush();
          }
        } else if (this.flushingFollowUp && (this.lastStopReason === "aborted" || this.lastStopReason === "error")) {
          this.abortFollowUpFlush();
        }
        // agent_settled 表示 SDK 已完成本轮及其内部 continuation。没有未 hold
        // 的产品队列时立即销毁 host，释放跨进程 writer lease；否则继续由队列
        // flush 持有 host，直到最后一轮完成。
        // 本会话名下还有子代理/扩展后台工作在跑时不销毁：完成事件要靠这个 live host
        // 里的扩展实例投递（pi-subagents 的 notify 带 triggerTurn 才能唤起父会话）；
        // 宿主一没，用户只会看到「子代理/后台任务跑完了但主会话没被唤起」。
        // 那类工作结束后那一轮 settle 会正常销毁；run 记录陈旧/消失则由空闲定时器的
        // 复查兜底。
        const disposeAfterSettle =
          event.type === "agent_settled"
          && !this.flushingFollowUp
          && (!this.hasWaitingFollowUp() || this.isFollowUpHeld())
          && !this.hasActiveExternalWork();
        this.resetIdleTimer();
        if (disposeAfterSettle) {
          void this.destroyAsync().catch(() => {
            /* 命令仍在进行（busy）：命令结束后的 resetIdleTimer 会再次触发回收 */
          });
        }
        break;
      case "compaction_start":
      case "auto_compaction_start":
        this.notifyRunning();
        break;
      case "compaction_end":
      case "auto_compaction_end":
        this.notifyRunning();
        // Manual compaction has no agent_settled event of its own. Once it
        // succeeds, flush messages queued during the compaction immediately;
        // auto compaction still relies on agent_settled while its run is active.
        if (event.aborted !== true && !event.errorMessage && this.isSettled()) {
          this.scheduleFollowUpFlush();
        }
        this.resetIdleTimer();
        break;
      case "message_end": {
        // user 消息确认：SDK 在订阅者回调返回后才执行 sessionManager.appendMessage，
        // 延后一帧再 materialize，确保 header+user 一同落盘（避免列表只见空会话/消失）。
        const msg = (event as { message?: { role?: string } }).message;
        if (msg?.role === "user") {
          // 注意：队列推进**不在这里**。
          // 旧实现的删除动作本就在 prompt 受理时就完成了，message_end 的「确认」
          // 反而靠游标推进误删下一条（同文本两条时更糟）；紧跟在受理后的再次
          // 删除只能引入竞态，不提供额外保证。
          const binaryBatch = this.pendingBinaryBatches.shift();
          setImmediate(() => {
            try {
              materializeSessionFile(this.session.sessionManager);
              this.syncIdentityFromSession();
              this.persistPendingBinaryBlocks(binaryBatch?.blocks ?? []);
              this.options.onSessionListInvalidate?.();
            } catch (err) {
              console.error("[pidance] materialize after user message failed:", err);
            }
          });
        }
        break;
      }
      case "queue_update": {
        const steering = Array.isArray(event.steering)
          ? (event.steering as unknown[]).filter((t): t is string => typeof t === "string")
          : [];
        const followUp = Array.isArray(event.followUp)
          ? (event.followUp as unknown[]).filter((t): t is string => typeof t === "string")
          : [];
        this.localQueue = { steering, followUp };
        this.hasQueueSnapshot = true;
        break;
      }
      default:
        break;
    }
    let eventToEmit: SdkAgentEvent = streamRunSeq > 0 ? { ...event, streamRunSeq } : event;
    // 吞吐读数：TTFT 首帧 / 每个 step 结束时下发（服务端为唯一权威，客户端只渲染）。
    // 必须挂到 eventToEmit —— 它是 emit 的目标对象，直接改 event 会被下面的浅拷贝丢掉。
    if (metricsChanged) {
      const projected = this.projectTurnMetrics();
      if (projected.ttftMs !== undefined || projected.tokensPerSecond !== undefined) {
        eventToEmit = { ...eventToEmit, turnMetrics: projected };
      }
    }
    // 上下文占用随每条 assistant 消息（每个工具轮次）变化：只在 agent_end 下发会让
    // 顶栏在整个 run 期间停在上一轮读数，所以 message_end 也要给一次读数。
    // 0.87.0 起 getContextUsage() 基于 SessionManager 投影（buildSessionProjection），
    // 而 message_end 事件先于本轮 assistant 入库，此刻读数比 agent_end 少这一轮回复的
    // 估算（约本轮输出 chars/4）；agent_end 的读数为权威值，顶栏在 run 结束时补上这部分。
    // agent_end 保留同字段，避免 settled 后立即 dispose 使浏览器错过最后一次热 state。
    const isAssistantMessageEnd =
      event.type === "message_end"
      && (event as { message?: { role?: string } }).message?.role === "assistant";
    if (event.type === "agent_end" || isAssistantMessageEnd) {
      const usage = this.contextUsageSnapshot();
      // 基于 eventToEmit 而不是 event：否则会丢掉上面刚挂上的 turnMetrics
      // （同一帧既要带上下文占用、也要带吞吐读数）。
      if (usage) eventToEmit = { ...eventToEmit, contextUsage: usage };
    }
    this.emit(this.withRenderedToolLines(eventToEmit));
  }

  /**
   * 上下文占用快照：SDK `getContextUsage()` 是唯一来源（无模型/无窗口时 undefined）。
   * 压缩后未重新生成 usage 时 SDK 返回 `{ tokens: null, percent: null }`，原样透传。
   */
  private contextUsageSnapshot():
    { contextWindow: number; percent: number | null; tokens: number | null } | undefined {
    try {
      const usage = this.session.getContextUsage();
      if (usage && typeof usage.contextWindow === "number" && usage.contextWindow > 0) {
        return {
          contextWindow: usage.contextWindow,
          percent: typeof usage.percent === "number" ? usage.percent : null,
          tokens: typeof usage.tokens === "number" ? usage.tokens : null,
        };
      }
    } catch {
      /* stats 可选；不阻断事件 */
    }
    return undefined;
  }

  /**
   * 渲染桥（SDK 切换后接回）：headless 调用插件工具 renderCall/renderResult 与
   * 自定义消息渲染器，产出 ANSI 行附加到事件；任何异常/缺失一律回退原事件，
   * 绝不阻断事件流。
   */
  private withRenderedToolLines(event: SdkAgentEvent): SdkAgentEvent {
    try {
      if (!this.renderBridgeTheme) return event;
      switch (event.type) {
        case "tool_execution_update": {
          // 高频 partial：按 toolCallId 节流，防事件循环阻塞。
          if (!this.shouldRenderPartialUpdate(event.toolCallId)) return event;
          const def = this.getToolRenderDefinition(event.toolName);
          if (!def) return event;
          const context = this.buildToolRenderContext(
            event.toolCallId,
            event.args ?? event.input,
            { isPartial: true, expanded: true, isError: event.isError === true, resultSlot: true },
          );
          if (!context) return event;
          const lines = renderToolResultLines(
            def,
            event.partialResult,
            { expanded: true, isPartial: true },
            context,
            (component) => this.updateToolRenderLastComponent(event.toolCallId, true, component),
            this.renderWidth,
          );
          return lines ? { ...event, renderedLines: lines } : event;
        }
        case "tool_call": {
          const def = this.getToolRenderDefinition(event.toolName);
          if (!def) return event;
          const context = this.buildToolRenderContext(
            event.toolCallId,
            event.input,
            { isPartial: false, expanded: true, isError: false, resultSlot: false },
          );
          if (!context) return event;
          const lines = renderToolCallLines(
            def,
            event.input,
            context,
            (component) => this.updateToolRenderLastComponent(event.toolCallId, false, component),
            this.renderWidth,
          );
          return lines ? { ...event, renderedCallLines: lines } : event;
        }
        case "tool_result": {
          const def = this.getToolRenderDefinition(event.toolName);
          if (!def) return event;
          const context = this.buildToolRenderContext(
            event.toolCallId,
            event.args ?? event.input,
            { isPartial: false, expanded: true, isError: event.isError === true, resultSlot: true },
          );
          if (!context) return event;
          // 结果对象补 isError（AgentToolResult 契约）。
          const lines = renderToolResultLines(
            def,
            {
              content: event.content,
              details: event.details,
              isError: event.isError === true,
              ...(event.usage !== undefined ? { usage: event.usage } : {}),
            },
            { expanded: true, isPartial: false },
            context,
            (component) => this.updateToolRenderLastComponent(event.toolCallId, true, component),
            this.renderWidth,
          );
          return lines ? { ...event, renderedResultLines: lines } : event;
        }
        case "message_start":
        case "message_end": {
          // 自定义消息渲染器（如 pi-subagents 的 subagent-notify）：role=custom 且
          // 带 customType 时取注册的 MessageRenderer headless 渲染；失败回退原文。
          const msg = event.message as { role?: string; customType?: string } | undefined;
          if (msg?.role !== "custom" || typeof msg.customType !== "string" || msg.customType === "") {
            return event;
          }
          const runner = this.session.extensionRunner as
            | { getMessageRenderer?: (customType: string) => unknown }
            | undefined;
          const renderer =
            typeof runner?.getMessageRenderer === "function"
              ? runner.getMessageRenderer(msg.customType)
              : undefined;
          const lines = renderCustomMessageLines(
            renderer,
            event.message,
            this.renderBridgeTheme,
            this.renderWidth,
          );
          return lines ? { ...event, renderedLines: lines } : event;
        }
        default:
          return event;
      }
    } catch {
      // 渲染桥绝不允许阻断事件流：任何异常回退原事件。
      return event;
    }
  }

  /** 取原始 ToolDefinition（绕过 wrapToolDefinition 的渲染器剥离）。 */
  private getToolRenderDefinition(toolName: unknown): unknown {
    if (typeof toolName !== "string" || toolName === "") return undefined;
    try {
      return this.session.getToolDefinition(toolName);
    } catch {
      return undefined;
    }
  }

  /**
   * 构造 ToolRenderContext 兼容对象（对齐 pi tool-renderer）：state/lastComponent
   * 取自 toolCallId 的稳定入口，跨事件共享；invalidate 重渲这一块并推给前端。
   */
  private buildToolRenderContext(
    toolCallId: unknown,
    args: unknown,
    opts: { isPartial: boolean; expanded: boolean; isError: boolean; resultSlot: boolean },
  ): Record<string, unknown> | null {
    const entry = this.getOrCreateToolRenderState(toolCallId);
    if (!entry) return null;
    return {
      args,
      toolCallId,
      // 渲染器靠它做异步刷新（SDK 内置 edit 预览、pi-subagents 的 widget 都调）：
      // 重渲这一块并推 rendered_lines_update，与宽度变化同一条通路。
      invalidate: () => {
        this.rerenderToolLine(toolCallId);
      },
      lastComponent: opts.resultSlot ? entry.lastResultComponent : entry.lastCallComponent,
      state: entry.state,
      cwd: this.realCwd,
      executionStarted: true,
      argsComplete: true,
      isPartial: opts.isPartial,
      expanded: opts.expanded,
      // 如实声明宿主能力：headless 终端不支持 Kitty/iTerm2 图片协议，
      // 插件据此走文字降级（不是缺口）。
      showImages: false,
      isError: opts.isError,
    };
  }

  /** 取（或懒创建）toolCallId 的渲染状态入口；非法 toolCallId → null。 */
  private getOrCreateToolRenderState(toolCallId: unknown): ToolRenderStateEntry | null {
    if (typeof toolCallId !== "string" || toolCallId === "") return null;
    let entry = this.toolRenderStates.get(toolCallId);
    if (!entry) {
      entry = {
        state: {},
        lastCallComponent: undefined,
        lastResultComponent: undefined,
        lastPartialRenderAt: undefined,
      };
      this.toolRenderStates.set(toolCallId, entry);
    }
    return entry;
  }

  /** 渲染后记录「上一组件」：resultSlot=true → renderResult 槽，否则 renderCall 槽。 */
  private updateToolRenderLastComponent(toolCallId: unknown, resultSlot: boolean, component: unknown): void {
    if (typeof toolCallId !== "string" || toolCallId === "") return;
    const entry = this.toolRenderStates.get(toolCallId);
    if (!entry) return;
    if (resultSlot) entry.lastResultComponent = component;
    else entry.lastCallComponent = component;
  }

  /**
   * 宽度变化后重渲已经渲染过的工具块：组件实例还在 toolRenderStates 里，
   * 直接用新宽度 render 一次，把新行推给前端按 toolCallId 替换。
   * 没有组件的（渲染桥未命中）跳过，不推空帧。
   */
  private rerenderToolLines(): void {
    for (const toolCallId of this.toolRenderStates.keys()) this.rerenderToolLine(toolCallId);
  }

  /** 重渲中的 toolCallId：插件可能在 render() 里同步调 invalidate()，不防会递归。 */
  private readonly toolRerendering = new Set<string>();

  /** 重渲单个工具块：宽度变化与渲染器的 `invalidate()` 共用这一条通路。 */
  private rerenderToolLine(toolCallId: unknown): void {
    if (typeof toolCallId !== "string" || toolCallId === "") return;
    // 重入：渲染过程中又调了一次 invalidate（插件把重渲写进 render 里），忽略这一次，
    // 否则「渲染→invalidate→重渲→渲染」会变成无限递归。
    if (this.toolRerendering.has(toolCallId)) return;
    const entry = this.toolRenderStates.get(toolCallId);
    if (!entry) return;
    this.toolRerendering.add(toolCallId);
    try {
      const renderedCallLines = entry.lastCallComponent
        ? renderWidgetComponentLines(entry.lastCallComponent, this.renderWidth)
        : null;
      const renderedResultLines = entry.lastResultComponent
        ? renderWidgetComponentLines(entry.lastResultComponent, this.renderWidth)
        : null;
      if (!renderedCallLines && !renderedResultLines) return;
      this.emit({
        type: "rendered_lines_update",
        toolCallId,
        ...(renderedCallLines ? { renderedCallLines } : {}),
        ...(renderedResultLines ? { renderedResultLines } : {}),
      } as SdkAgentEvent);
    } finally {
      this.toolRerendering.delete(toolCallId);
    }
  }

  /** tool_execution_update 节流：同一 toolCallId 最短间隔内跳过渲染。 */
  private shouldRenderPartialUpdate(toolCallId: unknown): boolean {
    if (typeof toolCallId !== "string" || toolCallId === "") return true;
    const now = Date.now();
    const entry = this.getOrCreateToolRenderState(toolCallId);
    if (!entry) return true;
    if (
      entry.lastPartialRenderAt !== undefined
      && now - entry.lastPartialRenderAt < SdkSessionHost.PARTIAL_RENDER_MIN_INTERVAL_MS
    ) {
      return false;
    }
    entry.lastPartialRenderAt = now;
    return true;
  }

  /** 会话真实项目 cwd（header.cwd 是项目目录）。 */
  private get realCwd(): string {
    try {
      return this.session.sessionManager.getHeader()?.cwd || this.options.cwd;
    } catch {
      return this.options.cwd;
    }
  }

  async start(): Promise<void> {
    try {
      const sessionManager = openSessionManagerForHost(
        this.realSessionFile,
        this.options.cwd,
      );
      const cwd = sessionManager.getCwd() || this.options.cwd;
      const agentDir = this.agentDir;
      const toolNames = this.activeToolNames;

      const createRuntime = async ({
        cwd: runtimeCwd,
        agentDir: runtimeAgentDir,
        sessionManager: sm,
        sessionStartEvent,
      }: {
        cwd: string;
        agentDir: string;
        sessionManager: SessionManager;
        sessionStartEvent?: unknown;
      }) => {
        const sendFileExecutor = createSendFileToUserExecutor({
          cwd: runtimeCwd,
          agentDir: runtimeAgentDir,
          appendBinary: (input) => this.appendBinary(input, sm),
        });
        const sendFileTool: ToolDefinition = {
          name: SEND_FILE_TO_USER_TOOL_NAME,
          label: "Send file to user",
          description: "Publish an agent-created project file as a user-visible attachment with preview/download support.",
          promptSnippet: "deliver a generated file to the user as a downloadable attachment",
          promptGuidelines: [
            "When the user needs a generated file, call send_file_to_user; do not only print a local path or paste Base64.",
            "Only report a file as delivered after send_file_to_user returns successfully.",
          ],
          parameters: SEND_FILE_TO_USER_PARAMETERS as unknown as ToolDefinition["parameters"],
          async execute(_toolCallId, params, signal) {
            const result = await sendFileExecutor(params as SendFileToUserParams, signal);
            return {
              content: [{ type: "text", text: `Delivered ${result.name} to the user (entry ${result.entryId}).` }],
              details: result,
            };
          },
        };
        const services = await createAgentSessionServices({
          cwd: runtimeCwd,
          agentDir: runtimeAgentDir,
          resourceLoaderOptions: {
            // 说明固定写入并声明“工具可用时”；工具是否启用交给 SDK 的
            // tools/noTools/set_tools 语义，避免 allow-list 会话无法后续启用。
            appendSystemPromptOverride: appendPidanceFileDeliveryPrompt,
            extensionFactories: [(pi) => pi.registerTool(sendFileTool)],
          },
        });
        // 省略的 xhigh/max 补恒等，让 settings 默认 xhigh 在建 session 时不被 Pi 钳成 high
        for (const m of services.modelRuntime.getModels()) {
          applyPassThroughExtendedThinkingInPlace(m);
        }
        const created = await createAgentSessionFromServices({
          services,
          sessionManager: sm,
          sessionStartEvent: sessionStartEvent as never,
          tools: toolNames && toolNames.length > 0 ? toolNames : undefined,
          noTools: toolNames && toolNames.length === 0 ? "all" : undefined,
        });
        return {
          ...created,
          services,
          diagnostics: services.diagnostics,
        };
      };

      this.runtime = await createAgentSessionRuntime(createRuntime, {
        cwd,
        agentDir,
        sessionManager,
      });
      this.runtime.setRebindSession(async () => {
        await this.rebindSession();
      });
      this.runtime.setBeforeSessionInvalidate(() => {
        this.extensionUi?.dispose();
        this.unsubscribe?.();
        this.unsubscribe = null;
      });

      await this.rebindSession();
      this.syncIdentityFromSession();
      this.hydrateFollowUpQueue();
      this.startupHoldTimer = setTimeout(() => {
        this.startupHoldTimer = null;
        this.startupHold = false;
        this.resetIdleTimer();
      // 15s：新会话 ensure→首个 prompt 需经浏览器多步（SSE attach、submission
      // 乐观写、模型选择等），5s 在网络慢/复杂引导下不够，过早 dispose 会让
      // 随后的 wake/prompt 因文件未落盘而 404。首写命令到达即释放该窗口。
      }, 15_000);
      this.startupHoldTimer.unref?.();
      this.resetIdleTimer();
      // 服务端重启/热重载后从 prefs 水合：空闲且未被 hold 时立即投递。
      if (this.hasWaitingFollowUp() && !this.isFollowUpHeld() && this.isSettled()) {
        this.scheduleFollowUpFlush();
      }
    } catch (error) {
      await this.destroyAsync();
      throw error;
    }
  }

  private projectState(): Record<string, unknown> {
    const session = this.session;
    const model = session.model;
    const projected: Record<string, unknown> = {
      stateSources: {
        rpcGetState: false,
        sdkSession: true,
        sessionStats: true,
        localQueue: true,
        localExtensionUi: true,
      },
      sessionId: this.realSessionId,
      sessionFile: this.realSessionFile,
      sessionName: session.sessionName,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      isPromptRunning: this.promptRunning,
      lastStopReason: this.lastStopReason,
      isBashRunning: this.bashRunning,
      turnMetrics: this.projectTurnMetrics(),
      pendingBash: this.bashCommand,
      autoCompactionEnabled: session.autoCompactionEnabled,
      steeringMode: session.steeringMode,
      followUpMode: session.followUpMode,
      thinkingLevel: session.thinkingLevel,
      // SDK 同进程可直接投影完整 system prompt（RPC 时代协议不含该字段）
      systemPrompt: session.systemPrompt ?? "",
      model: model
        ? { id: model.id, provider: model.provider, modelId: model.id }
        : undefined,
      messageCount: session.messages.length,
      pendingMessageCount: session.pendingMessageCount,
      extensionStatuses: Array.from(
        this.extensionUi?.statuses.entries() ?? [],
        ([key, text]) => ({ key, text }),
      ),
      extensionWidgets: Array.from(
        this.extensionUi?.widgets.entries() ?? [],
        ([key, content]) => {
          // 热 state 投影与 SSE setWidget 事件对齐（{key, lines, placement}）；
          // adapter 内部 Map value 为 {lines, placement}，含未知类型，逐字段窄化。
          const widget = content as { lines?: unknown; placement?: string } | null;
          return {
            key,
            lines: Array.isArray(widget?.lines) ? (widget.lines as string[]) : [],
            placement: widget?.placement === "belowEditor" ? "belowEditor" : "aboveEditor",
          };
        },
      ),
      pendingExtensionRequests: Array.from(
        this.extensionUi?.pendingSnapshot.values() ?? [],
      ),
      // 活动 custom 面板快照：普通阻塞请求走 pendingExtensionRequests，
      // 但 custom 没有快照的话，刷新/切回后面板内容与输入入口都会丢。
      activeCustomUi: this.extensionUi?.customSnapshot ?? null,
    };
    projected.queuedMessages = {
      steering: this.hasQueueSnapshot ? [...this.localQueue.steering] : [],
      // followUp 保留正文数组（旧客户端的读取路径）；followUpItems 带条目身份
      // 与状态（claimed 在途、unknown 结果未知），客户端按它建账本。
      followUp: followUpItemTexts(this.visibleFollowUp()),
      followUpItems: this.visibleFollowUp(),
      followUpRevision: this.followUpQueueRevision,
      inFlight: this.inFlightFollowUpTexts(),
      // 已受理的写入令牌：热投影必须与 SSE / 写入回执带同一份凭据。少了它，
      // 「回执丢失但服务端已受理」的那次写入会被客户端当成新增内容再列一遍，
      // 下一次整包写入就多出一条同文条目（K2）。
      admittedAttemptIds: [...this.followUpAdmittedAttemptIds],
    };
    try {
      const usage = session.getContextUsage();
      if (usage && typeof usage.contextWindow === "number" && usage.contextWindow > 0) {
        projected.contextUsage = {
          contextWindow: usage.contextWindow,
          percent: typeof usage.percent === "number" ? usage.percent : null,
          tokens: typeof usage.tokens === "number" ? usage.tokens : null,
        };
      }
    } catch {
      /* stats 可选 */
    }
    return projected;
  }

  appendActivity(input: Record<string, unknown> | unknown): {
    entryId: string;
    activity: unknown;
  } {
    if (!this.runtime) throw new Error("Cannot append activity: session not alive");
    const activity =
      input &&
      typeof input === "object" &&
      "type" in (input as object) &&
      (input as { type?: string }).type === "append_activity"
        ? parseAppendActivityCommand(input as Record<string, unknown>)
        : normalizeActivityInput(input);
    const entryId = this.session.sessionManager.appendCustomEntry(
      PIDANCE_ACTIVITY_CUSTOM_TYPE,
      activity,
    );
    this.options.onSessionListInvalidate?.();
    return { entryId, activity };
  }

  appendBinary(
    input: Record<string, unknown> | unknown,
    expectedSessionManager?: SessionManager,
  ): {
    entryId: string;
    binary: BinaryMessageData;
  } {
    if (!this._alive || !this.runtime || this.destroyPromise) {
      throw new Error("Cannot append binary message: session not alive");
    }
    const session = this.session;
    const manager = session.sessionManager;
    if (expectedSessionManager && manager !== expectedSessionManager) {
      throw new Error("Cannot publish file after the session changed");
    }
    const record = input && typeof input === "object" && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {};
    const raw = record.type === "append_binary" ? record.binaryBlock : input;
    const binary = normalizeBinaryMessageInputs(
      raw ? [raw as BinaryMessageInput] : undefined,
      this.agentDir,
    )[0];
    if (!binary) throw new Error("binaryBlock is required");
    const entryId = manager.appendCustomEntry(PIDANCE_BINARY_CUSTOM_TYPE, binary);
    // The entry is already durable before notifications. A listener failure must
    // not make the tool delete the published attachment.
    try {
      this.options.onSessionListInvalidate?.();
    } catch (error) {
      console.error("[pidance] binary message list notification failed:", error);
    }
    try {
      this.emit({
        type: "message_end",
        entryId,
        message: binaryMessageToUiMessage(binary, Date.now()),
      });
    } catch (error) {
      console.error("[pidance] binary message event notification failed:", error);
    }
    return { entryId, binary };
  }

  async send(command: Record<string, unknown>, ticket?: symbol): Promise<unknown> {
    if (!this.runtime) throw new Error("SDK session is not alive");
    const type = command.type as string;
    // get_state / ensure_session 都是只读预检（浏览器「新建会话占位」会先 ensure
    // 再 prompt）：保留 startup hold，避免 host 在首个真实写命令前被 0ms dispose，
    // 导致随后 wake/prompt 时文件未落盘而 404/被拒。真正的写命令才释放窗口。
    if (type !== "get_state" && type !== "ensure_session") this.releaseStartupHold();
    // 命令计数：dispose 定时器在命令活跃期间延后，防命令持有
    // SessionManager 时被释放（compact/steer 的微任务窗口）。
    this.activeCommandCount += 1;
    this.resetIdleTimer();
    const session = this.session;
    try {

    switch (type) {
      case "prompt": {
        const parsed = parsePromptCommand(command);
        const cached = this.promptReceipts.get(parsed.submissionId);
        if (cached) return cached;
        const key = parsed.submissionId;
        const inFlight = this.promptInFlight.get(key);
        if (inFlight) return inFlight;
        const binaryBlocks = normalizeBinaryMessageInputs(parsed.binaryBlocks, this.agentDir);
        // 图片输入只在这里解析一次：下面每条路径（直接 prompt、压缩中入队、空闲
        // 引导）都拿同一份结果，避免某一分支忘了回读而静默丢图。
        const promptImagesInput = parsed.images ?? command.images as PromptImageInput[] | undefined;
        const resolvedImages = this.resolvePromptImages(promptImagesInput);
        if (resolvedImages.missing.length) {
          console.error("[pidance] prompt image missing on disk:", resolvedImages.missing);
          const failed = this.reject(parsed.submissionId, "media");
          this.promptReceipts.set(parsed.submissionId, failed);
          return failed;
        }
        if (this.bashRunning && !isImmediateSlashPrompt(parsed.message)) {
          // 结构化回绝：客户端按 reason=shell 提示并回草稿，不能靠 HTTP 错误猜。
          const busy = this.reject(parsed.submissionId, "bash");
          this.promptReceipts.set(parsed.submissionId, busy);
          return busy;
        }
        // AgentSession.prompt() rejects direct prompts while manual compaction is
        // running. Preserve the user's message in the existing Pidance follow-up
        // queue; compaction_end will schedule the normal prompt flush.
        // 扩展斜杠（/btw 等）除外：SDK 在压缩检查之前就执行 registerCommand。
        if (session.isCompacting && !isImmediateSlashPrompt(parsed.message)) {
          // 压缩中不能起 run：正文与图片一起进产品队列（条目只持引用），
          // compaction_end 会按正常流程投递。旧实现把带图消息整条回绝，用户只能
          // 等压缩结束再手动重发。
          const queuedMedia = this.queueMediaFromPromptImages(promptImagesInput);
          if (!queuedMedia.ok) {
            const failed = this.reject(parsed.submissionId, "media");
            this.promptReceipts.set(parsed.submissionId, failed);
            return failed;
          }
          const queuedReceipt = this.enqueuePayloads(
            parsed.submissionId,
            [{ text: parsed.message, ...(queuedMedia.media?.length ? { media: queuedMedia.media } : {}) }],
            "compacting",
          );
          this.promptReceipts.set(parsed.submissionId, queuedReceipt);
          this.options.onSessionListInvalidate?.();
          return queuedReceipt;
        }
        // 自动投递在途：外部 prompt 不能并发起 run（两个 prompt 抢同一个
        // SessionManager）。只有 flush 自己的内部票据能穿过——用布尔标志的话，
        // 恰好在这一刻到达的外部请求会共享它，等于门禁不存在。
        if (this.flushingFollowUp && ticket !== this.internalPromptTicket && !isImmediateSlashPrompt(parsed.message)) {
          const busy = this.reject(parsed.submissionId, "busy");
          this.promptReceipts.set(parsed.submissionId, busy);
          return busy;
        }
        // 已有活跃 run（或我们自己有 prompt 在途）：再起一个 prompt 会抢同一个
        // SessionManager，SDK 也会抛「already processing」。必须在**任何运行态变更之前**
        // 结构化回绝：旧实现把它当普通异常走到 catch，那里会把**别人的** run 状态回滚
        // （promptRunning=false、lastStopReason="error"、emit prompt_done、setFollowUpHeld），
        // UI 上本轮运行被误判为已结束（F8）。
        // streamingBehavior="steer" 是投递路径自己用的（SDK 会转向而不是报错），放行。
        // 斜杠命令：Pi TUI 走 AgentSession.prompt()，扩展命令即使 streaming 也立刻执行，
        // 不得在这里 busy 掉。未注册的斜杠仍会由 SDK 抛错，下面按 busy 回执，不另起一轮。
        if ((this.promptRunning || session.isStreaming) && command.streamingBehavior !== "steer") {
          if (!isImmediateSlashPrompt(parsed.message)) {
            const busy = this.reject(parsed.submissionId, "busy");
            this.promptReceipts.set(parsed.submissionId, busy);
            return busy;
          }
          try {
            await session.prompt(parsed.message, {
              images: resolvedImages.images as never,
              source: "rpc",
            });
            const receipt: PromptReceipt = {
              submissionId: parsed.submissionId,
              sessionId: this.realSessionId,
              status: "accepted",
            };
            this.promptReceipts.set(parsed.submissionId, receipt);
            return receipt;
          } catch {
            const busy = this.reject(parsed.submissionId, "busy");
            this.promptReceipts.set(parsed.submissionId, busy);
            return busy;
          }
        }
        if (!acquireRunningLease(this.realSessionId)) {
          throw new Error(SESSION_RUNNING_LOCKED_MESSAGE);
        }
        this.promptRunning = true;
        this.lastStopReason = null;
        recordRunningStartedAt(this.realSessionId, Date.now());
        this.notifyRunning();
        const flight = (async (): Promise<PromptReceipt> => {
          try {
          await new Promise<void>((resolve, reject) => {
            let settled = false;
            const clearIdlePrompt = () => {
              // 配置类 slash（如 multimodal-proxy）预检后 HTTP 已返回，prompt() 结束时
              // 可能没有 agent_start/agent_end：必须在这里清 running，否则会话页一直
              // 「正在运行命令」。真正的模型回合由 agent_end 清；此处仅在已空闲时补清。
              if (session.isStreaming || session.isCompacting || this.bashRunning) return;
              if (!this.promptRunning) return;
              this.promptRunning = false;
              if (this.lastStopReason !== "aborted" && this.lastStopReason !== "error") {
                this.lastStopReason = "completed";
              }
              clearRunningStartedAt(this.realSessionId);
              this.notifyRunning();
              this.emit({ type: "prompt_done", streamRunSeq: this.streamRunSeq });
              this.resetIdleTimer();
            };
            void session
              .prompt(parsed.message, {
                images: resolvedImages.images as never,
                streamingBehavior: command.streamingBehavior as never,
                source: "rpc",
                preflightResult: (ok) => {
                  if (!ok) return;
                  settled = true;
                  if (binaryBlocks.length > 0) {
                    this.pendingBinaryBatches.push({ submissionId: key, blocks: binaryBlocks });
                  }
                  // 注意：此时 user 消息尚未 append 到 sessionManager（SDK 在预检后
                  // 才把消息交给 agent 事件流），materialize 只会写出 header-only；
                  // 真正的落盘在 message_end(user) 处理后的 setImmediate 中完成。
                  this.syncIdentityFromSession();
                  // 新一轮 prompt 已被 Pi 接受：同步解除旧 abort/error 留下的 hold。
                  // 不能依赖浏览器防抖写，否则快速结束或切换会话会错过 settled flush。
                  this.setFollowUpHeld(false);
                  this.options.onSessionListInvalidate?.();
                  resolve();
                },
              })
              .then(() => {
                if (!settled) {
                  settled = true;
                  try {
                    materializeSessionFile(session.sessionManager);
                  } catch (err) {
                    console.error("[pidance] materialize after prompt failed:", err);
                  }
                  this.syncIdentityFromSession();
                  this.options.onSessionListInvalidate?.();
                  resolve();
                }
                clearIdlePrompt();
              })
              .catch((error) => {
                if (this.lastStopReason !== "aborted") this.lastStopReason = "error";
                this.setFollowUpHeld(true);
                clearIdlePrompt();
                if (!settled) {
                  settled = true;
                  reject(error);
                }
              });
          });
          const receipt: PromptReceipt = {
            submissionId: parsed.submissionId,
            sessionId: this.realSessionId,
            status: "accepted",
          };
          this.promptReceipts.set(key, receipt);
          return receipt;
          } catch (error) {
          this.removePendingBinaryBatch(key);
          // 别人的 run 还在跑（SDK 报 already processing 等入队语义的原因）：
          // 这个 prompt 从未拥有运行态，**不得**回滚它——只回结构化拒绝，
          // 由客户端按 reason 入队。（上面已有前置门禁，此处是兜底。）
          const reason = classifyPromptRejection(error);
          if (session.isStreaming && isQueueablePromptReason(reason)) {
            const busy: PromptReceipt = {
              submissionId: parsed.submissionId,
              sessionId: this.realSessionId,
              status: "rejected",
              reason,
            };
            this.promptReceipts.set(key, busy);
            return busy;
          }
          this.promptRunning = false;
          this.lastStopReason = this.lastStopReason === "aborted" ? "aborted" : "error";
          this.setFollowUpHeld(true);
          clearRunningStartedAt(this.realSessionId);
          this.notifyRunning();
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.emit({ type: "prompt_error", errorMessage });
          this.emit({ type: "prompt_done", streamRunSeq: this.streamRunSeq });
          const receipt: PromptReceipt = {
            submissionId: parsed.submissionId,
            sessionId: this.realSessionId,
            status: "rejected",
          };
          this.promptReceipts.set(key, receipt);
          throw error;
          } finally {
            this.promptInFlight.delete(key);
          }
        })();
        this.promptInFlight.set(key, flight);
        return flight;
      }

      case "abort": {
        this.lastStopReason = "aborted";
        this.setFollowUpHeld(true);
        this.promptRunning = false;
        this.notifyRunning();
        await session.abort();
        this.notifyRunning();
        return null;
      }

      case "get_state":
        return this.projectState();

      case "set_model": {
        const provider = String(command.provider ?? "");
        const modelId = String(command.modelId ?? "");
        // 先查静态目录，避免 getAvailable() 全量刷新偶发失败（旧会话更常见）
        let model = resolveSessionModel(session.modelRuntime, provider, modelId);
        if (!model) {
          try {
            const available = await session.modelRuntime.getAvailable();
            model = available.find((m) => m.provider === provider && m.id === modelId);
          } catch {
            model = undefined;
          }
        }
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await session.setModel(withPassThroughExtendedThinking(model));
        this.options.onSessionListInvalidate?.();
        return model;
      }

      case "set_thinking_level": {
        if (session.model) applyPassThroughExtendedThinkingInPlace(session.model);
        session.setThinkingLevel(command.level as never);
        this.options.onSessionListInvalidate?.();
        return null;
      }

      case "compact": {
        // 手动压缩期间是 run 边界（compact() 先 abort）。compact 未结束时
        // isRunning() 仍为 true，不会触发 idle dispose；但 compaction_end 可能
        // 早于 send 的 promise 结算，需确保结束后再调度 dispose。
        const result = await session.compact(
          typeof command.customInstructions === "string"
            ? command.customInstructions
            : undefined,
        );
        this.options.onSessionListInvalidate?.();
        this.notifyRunning();
        // 压缩已在 send 内完成；直接调度 dispose（若有队列由队列 flush 接管）。
        this.resetIdleTimer();
        return result;
      }

      case "steer": {
        const parsed = parseSteerCommand(command);
        const cached = this.commandReceipts.get(parsed.submissionId);
        if (cached) return cached;
        // 同一 submissionId 的并发 steer 共享同一个在途 promise（F9）。
        const inFlight = this.steerFlights.get(parsed.submissionId);
        if (inFlight) return inFlight;
        const flight = this.runSteerCommand(parsed);
        this.steerFlights.set(parsed.submissionId, flight);
        try {
          return await flight;
        } finally {
          if (this.steerFlights.get(parsed.submissionId) === flight) {
            this.steerFlights.delete(parsed.submissionId);
          }
        }
      }

      case "dispatch_follow_up_queue": {
        const parsed = parseDispatchFollowUpQueueCommand(command);
        const cached = this.commandReceipts.get(parsed.submissionId);
        if (cached) return cached;
        const dispatched = await this.dispatchFollowUpQueue(parsed);
        // 幂等：同一 submissionId 重发不得再清一次队/再投一次。
        this.commandReceipts.set(parsed.submissionId, dispatched as unknown as PromptReceipt);
        return dispatched;
      }

      case "recall_follow_up_queue": {
        const parsed = parseRecallFollowUpQueueCommand(command);
        const cached = this.commandReceipts.get(parsed.submissionId);
        if (cached) return cached;
        const recalled = this.recallFollowUpQueue(parsed.itemIds);
        // 幂等：同一 submissionId 重发不得再取一次（第二次召回同一批只能拿到 missing）。
        this.commandReceipts.set(parsed.submissionId, recalled as unknown as PromptReceipt);
        return recalled;
      }

      case "set_follow_up_queue": {
        const parsed = parseSetFollowUpQueueCommand(command);
        const cached = this.commandReceipts.get(parsed.submissionId);
        if (cached) return cached;
        // 条件写入（CAS）：多标签各自基于同一快照整组替换时，后到的会静默丢掉
        // 先到的入队。客户端带它最后一次见过的服务端 revision；不匹配则拒绝，
        // 并把权威队列回给客户端。
        const write = this.writeFollowUpQueue(parsed.items, parsed.expectedRevision);
        // 幂等：同一 submissionId 的重发只能拿到第一次的结果。不缓存的话，客户端
        // 因为回执丢失而重试同一次写入时，整包会被当新写入再应用一次（revision
        // 已经前进，第二次又生效一次——I1）。成功与冲突都是定论，都要缓存。
        this.commandReceipts.set(parsed.submissionId, write as unknown as PromptReceipt);
        if (write.ok) {
          // 注意：这里**不**中止正在进行的 flush。清队/改队不得取消已提交的一批
          // （旧实现在这里 abortFollowUpFlush，已投递内容于是从 UI 消失或反被漏发）。
          // 已认领条目由 flush 按 id 自行出队，新条目等下一次调度。
          this.emitQueueChanged();
          if (this.isSettled() && this.hasWaitingFollowUp()) this.scheduleFollowUpFlush();
          this.resetIdleTimer();
        }
        return write;
      }

      case "follow_up": {
        const parsed = parseFollowUpCommand(command);
        const cached = this.commandReceipts.get(parsed.submissionId);
        if (cached) return cached;
        // 队列条目能携带媒体引用，因此带图不再回绝：回绝的历史原因是「产品队列
        // 只能存文本」，那正是 A11 要改掉的。
        const queuedMedia = this.queueMediaFromPromptImages(parsed.images);
        const receipt: PromptReceipt = this.bashRunning
          ? this.reject(parsed.submissionId, "bash")
          : !queuedMedia.ok
            ? this.reject(parsed.submissionId, "media")
            : !parsed.message.trim() && !queuedMedia.media?.length
              ? this.reject(parsed.submissionId, "error")
              : this.enqueuePayloads(parsed.submissionId, [
                { text: parsed.message, ...(queuedMedia.media?.length ? { media: queuedMedia.media } : {}) },
              ]);
        this.commandReceipts.set(parsed.submissionId, receipt);
        return receipt;
      }

      case "set_session_name": {
        const name = String(command.name ?? "").trim();
        if (!name) throw new Error("Session name cannot be empty");
        session.setSessionName(name);
        this.options.onSessionListInvalidate?.();
        return null;
      }

      case "set_auto_compaction": {
        session.setAutoCompactionEnabled(Boolean(command.enabled));
        return null;
      }

      case "set_auto_retry": {
        session.setAutoRetryEnabled(Boolean(command.enabled));
        return null;
      }

      case "clear_queue": {
        return session.clearQueue();
      }

      case "get_tools": {
        const tools = session.getAllTools();
        const active = new Set(session.getActiveToolNames());
        return {
          source: "sdk",
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description ?? "",
            active: active.has(t.name),
          })),
        };
      }

      case "set_tools": {
        const names = Array.isArray(command.tools)
          ? (command.tools as unknown[]).filter((n): n is string => typeof n === "string")
          : [];
        session.setActiveToolsByName(names);
        this.activeToolNames = names;
        return null;
      }

      case "get_commands": {
        const commands: Array<Record<string, unknown>> = [];
        for (const cmd of session.extensionRunner.getRegisteredCommands()) {
          commands.push({
            name: cmd.invocationName,
            description: cmd.description,
            source: "extension",
            sourceInfo: cmd.sourceInfo,
          });
        }
        for (const template of session.promptTemplates) {
          commands.push({
            name: template.name,
            description: template.description,
            source: "prompt_template",
          });
        }
        // 与 SDK 会话内语义对齐：skill 以 /skill:<name> 前缀注册，prompt 展开时
        // 读 SKILL.md 注入；沿用 session.resourceLoader 已加载集合（含项目级）。
        try {
          const loaded = session.resourceLoader?.getSkills?.();
          for (const skill of loaded?.skills ?? []) {
            commands.push({
              name: `skill:${skill.name}`,
              description: skill.description,
              source: "skill",
              sourceInfo: skill.sourceInfo,
            });
          }
        } catch {
          // skill 枚举失败不回退整个命令列表
        }
        return { commands };
      }

      case "get_session_stats":
        return session.getSessionStats();

      case "bash": {
        if (session.isStreaming) {
          throw new Error("Cannot run bash while agent is streaming");
        }
        this.bashRunning = true;
        this.bashCommand = {
          command: String(command.command ?? ""),
          excludeFromContext: Boolean(command.excludeFromContext),
          startedAt: Date.now(),
        };
        this.notifyRunning();
        try {
          const result = await session.executeBash(
            String(command.command ?? ""),
            undefined,
            { excludeFromContext: Boolean(command.excludeFromContext) },
          );
          return result;
        } finally {
          this.bashRunning = false;
          this.bashCommand = null;
          this.notifyRunning();
          this.resetIdleTimer();
        }
      }

      case "abort_bash": {
        session.abortBash();
        this.bashRunning = false;
        this.bashCommand = null;
        this.notifyRunning();
        return null;
      }

      case "abort_compaction": {
        session.abortCompaction();
        return null;
      }

      case "extension_ui_response": {
        const id = asString(command.id);
        if (!id) throw new Error("extension_ui_response requires id");
        const response = { ...command };
        delete response.type;
        delete response.id;
        if (!this.extensionUi?.respond(id, response)) {
          // 未知/过期 id：忽略，不抛
        }
        this.notifyRunning();
        return null;
      }

      case "extension_ui_input": {
        const id = asString(command.id);
        const data = typeof command.data === "string" ? command.data : "";
        if (id) this.extensionUi?.inputCustom(id, data);
        return null;
      }

      case "terminal_input": {
        // 面板被插件收起时的白名单按键：交给插件注册的全局监听器
        // （ctx.ui.onTerminalInput；如 rpiv-ask-user 的折叠键用来重新展开面板）。
        const data = typeof command.data === "string" ? command.data : "";
        return this.extensionUi?.dispatchTerminalInput(data) ?? { consumed: false };
      }

      case "editor_focus": {
        // 客户端输入框的焦点状态。插件读 `tui.focusedComponent` 判断「主编辑器有没有
        // 焦点」（pi-subagents 的 fleet widget 靠它决定方向键能不能进选择态），
        // 这个探针只有真的有焦点时才给。
        const focused = command.focused === true;
        return { focused, changed: this.extensionUi?.setEditorFocus(focused) ?? false };
      }

      case "extension_ui_mouse": {
        // 面板内的鼠标事件（当前用于 pi-subagents 的 widget：点标题行折叠）
        const id = asString(command.id);
        const event = command.event;
        if (id && event && typeof event === "object") {
          this.extensionUi?.inputCustomMouse(id, event as Record<string, unknown>);
        }
        return null;
      }

      case "set_render_width": {
        // 前端按可用宽度上报列数：插件组件按这个宽度排版，所以视口变窄时
        // 不应该再按桌面宽度渲染（否则方框/表格会被 CSS 硬断行打乱）。
        const raw = typeof command.width === "number" ? command.width : NaN;
        if (!Number.isFinite(raw)) return null;
        const width = Math.min(
          SdkSessionHost.RENDER_WIDTH_MAX,
          Math.max(SdkSessionHost.RENDER_WIDTH_MIN, Math.round(raw)),
        );
        if (width === this.renderWidth) return null;
        this.renderWidth = width;
        this.extensionUi?.setRenderWidth(width);
        this.rerenderToolLines();
        return null;
      }

      case "append_activity":
        return this.appendActivity(command);

      case "append_binary":
        return this.appendBinary(command);

      case "fork": {
        if (this.bashRunning) throw new Error("Cannot fork while a shell command is running");
        const entryId = String(command.entryId ?? "");
        if (!entryId) throw new Error("entryId is required");
        const result = await this.runtime.fork(entryId);
        if (!result.cancelled) {
          await this.rebindSession();
          this.syncIdentityFromSession();
          this.options.onSessionListInvalidate?.();
        }
        return {
          cancelled: result.cancelled,
          newSessionId: result.cancelled ? undefined : this.realSessionId,
          text: result.selectedText,
        };
      }

      case "navigate_tree": {
        if (this.bashRunning) {
          throw new Error("Cannot navigate while a shell command is running");
        }
        const targetId = asString(command.targetId);
        if (!targetId) throw new Error("targetId is required");
        const result = await session.navigateTree(targetId, {
          summarize: command.summarize as boolean | undefined,
          customInstructions: asString(command.customInstructions),
        });
        if (!result.cancelled && this.realSessionFile) {
          const last = session.sessionManager.getLeafId();
          // 非末尾：写 sidecar 供重启恢复
          if (last && last !== targetId) {
            // navigateTree 后 leaf 应是 target；若在末尾清 sidecar
          }
          const leaf = session.sessionManager.getLeafId();
          const entries = session.sessionManager.getEntries();
          const lastEntry = entries.at(-1)?.id;
          if (leaf && lastEntry && leaf !== lastEntry) {
            writeLeafSidecar(this.realSessionFile, leaf);
          } else if (this.realSessionFile) {
            clearLeafSidecar(this.realSessionFile);
          }
        }
        this.options.onSessionListInvalidate?.();
        return { cancelled: result.cancelled };
      }

      case "select_leaf_exact": {
        const entryId = asString(command.entryId);
        if (!entryId) throw new Error("entryId is required");
        const navigation = this.options.navigationActions;
        if (navigation) {
          // 交出自己的 writer 后由 Service 离线写：本命令排除自己，不自等待。
          const handoff = () => this.destroyExcluding(1);
          return await navigation.selectLeafExact(this.sessionId, entryId, handoff);
        }
        // 无注入时直接 navigate
        const result = await session.navigateTree(entryId, { summarize: false });
        if (!result.cancelled && this.realSessionFile) {
          const leaf = session.sessionManager.getLeafId();
          const lastEntry = session.sessionManager.getEntries().at(-1)?.id;
          if (leaf && lastEntry && leaf !== lastEntry) {
            writeLeafSidecar(this.realSessionFile, leaf);
          } else {
            clearLeafSidecar(this.realSessionFile);
          }
        }
        return { cancelled: result.cancelled };
      }

      case "branch_from_assistant": {
        const assistantEntryId = asString(command.assistantEntryId);
        if (!assistantEntryId) throw new Error("assistantEntryId is required");
        const navigation = this.options.navigationActions;
        if (navigation) {
          const handoff = () => this.destroyExcluding(1);
          return await navigation.branchFromAssistant(this.sessionId, assistantEntryId, handoff);
        }
        throw new Error("branch_from_assistant is unavailable");
      }

      case "create_session_from_leaf": {
        const entryId = asString(command.entryId);
        if (!entryId) throw new Error("entryId is required");
        const navigation = this.options.navigationActions;
        if (navigation) {
          const handoff = () => this.destroyExcluding(1);
          return await navigation.createSessionFromLeaf(this.sessionId, entryId, handoff);
        }
        throw new Error("create_session_from_leaf is unavailable");
      }

      case "set_branch_label": {
        const targetId = asString(command.targetId);
        if (!targetId) throw new Error("targetId is required");
        const label =
          command.label === undefined || command.label === null
            ? undefined
            : String(command.label);
        session.sessionManager.appendLabelChange(targetId, label);
        this.options.onSessionListInvalidate?.();
        return null;
      }

      case "reload": {
        await session.reload();
        await this.rebindSession();
        return null;
      }

      case "get_last_assistant_text":
        return { text: session.getLastAssistantText() };

      case "ensure_session":
        return null;

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
    } finally {
      this.activeCommandCount = Math.max(0, this.activeCommandCount - 1);
      if (this.activeCommandCount === 0) this.resetIdleTimer();
    }
  }

  destroy(): void {
    void this.destroyAsync().catch(() => {
      /* busy（命令仍在进行）：命令结束后的 resetIdleTimer 会再次触发回收 */
    });
  }

  async destroyAsync(): Promise<void> {
    return this.destroyExcluding(0);
  }

  /**
   * 请求销毁，并声明本次调用自己占用的命令数。
   *
   * @param excludeCommands 调用方自身正在执行的命令数。导航命令把 writer 让给
   *   Service 的离线写时传 1：它等的是自己结束，会死锁；而外部调用（其它标签
   *   页改名、删除）传 0，会正常等待导航命令结束。
   */
  private destroyExcluding(excludeCommands: number): Promise<void> {
    // 单飞：并发重入（Service 多条离线写路径 / idle 定时器）共享同一 dispose。
    if (this.destroyPromise) return this.destroyPromise;
    if (!this._alive && !this.runtime) return Promise.resolve();
    if (this.activeCommandCount - excludeCommands > 0) {
      let pending = this.pendingDestroys.get(excludeCommands);
      if (!pending) {
        pending = this.destroyWhenCommandsSettle(excludeCommands);
        this.pendingDestroys.set(excludeCommands, pending);
      }
      return pending;
    }
    return this.beginDispose();
  }

  /**
   * 等正在进行的命令结束后再 dispose。超过 destroyWaitMs 招 busy：宁可让调用方
   * fail closed（Service 映射 409），也不在命令持有 manager 时并发写。
   */
  private destroyWhenCommandsSettle(excludeCommands: number): Promise<void> {
    const promise = (async () => {
      const deadline = Date.now() + this.destroyWaitMs;
      while (this.activeCommandCount - excludeCommands > 0) {
        if (Date.now() >= deadline) throw new Error(SESSION_WRITER_BUSY_MESSAGE);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 25);
          timer.unref?.();
        });
      }
      return this.beginDispose();
    })().finally(() => {
      // 结束/失败后清掉等待，让命令结束后的下一次 destroyAsync 能重新尝试。
      if (this.pendingDestroys.get(excludeCommands) === promise) {
        this.pendingDestroys.delete(excludeCommands);
      }
    });
    return promise;
  }

  private beginDispose(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this._alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.startupHoldTimer) clearTimeout(this.startupHoldTimer);
    this.startupHoldTimer = null;
    this.startupHold = false;
    this.destroyPromise = (async () => {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.extensionUi?.dispose();
      this.extensionUi = null;
      const runtime = this.runtime;
      this.runtime = null;
      if (runtime) {
        try {
          await runtime.dispose();
        } catch (err) {
          console.error("[pidance] sdk runtime dispose error:", err);
        }
      }
      this.promptRunning = false;
      this.bashRunning = false;
      this.bashCommand = null;
      this.flushingFollowUp = false;
      this.followUpFlushUnits = [];
      this.followUpFlushCursor = 0;
      this.followUpSending = false;
      clearRunningStartedAt(this.realSessionId);
      // 多订阅逐一分发：任一订阅者抛错不得阻断其它订阅者（registry 清理必须跑到）。
      for (const callback of [...this.destroyCallbacks]) {
        try {
          callback();
        } catch (err) {
          console.error("[pidance] sdk host destroy listener error:", err);
        }
      }
      this.destroyCallbacks.clear();
      this.notifyRunning();
    })();
    return this.destroyPromise;
  }
}

export async function startSdkSessionHost(
  options: SdkSessionHostOptions,
): Promise<SdkSessionHost> {
  const host = new SdkSessionHost(options);
  await host.start();
  return host;
}
