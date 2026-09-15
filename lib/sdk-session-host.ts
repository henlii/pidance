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
import {
  getPidancePref,
  readPidancePrefs,
  updatePidancePref,
} from "./pidance-prefs-file";
import {
  acquireRunningLease,
  refreshWriterLease,
  SESSION_RUNNING_LOCKED_MESSAGE,
} from "./session-running-lease";

/**
 * 命令仍在进行、无法安全交出 writer 时的失败消息。
 * SessionService 把它映射为 409：宁可让离线写 fail closed，也不并发写同一个 JSONL。
 */
export const SESSION_WRITER_BUSY_MESSAGE =
  "Session writer is busy: a command is still in flight";
import {
  clearRunningStartedAt,
  recordRunningStartedAt,
} from "./running-state";
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
import {
  applyPassThroughExtendedThinkingInPlace,
  withPassThroughExtendedThinking,
} from "./thinking-levels";
import { parsePromptCommand, type PromptReceipt } from "./agent-commands";
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
  renderCustomMessageLines,
  renderToolCallLines,
  renderToolResultLines,
  renderWidgetFactoryLines,
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
  /**
   * 本 host 是否已失去 writer 租约（被另一进程接管）。
   * 失去后拒绝新的写命令，避免两个进程同时追加同一 JSONL。
   */
  private leaseLost = false;
  private promptRunning = false;
  /** 最近一次 prompt 结束原因：队列自动投递只认 completed。 */
  private lastStopReason: "completed" | "aborted" | "error" | null = null;
  /** 本地 follow-up 队列执行缓存（持久层仍是 prefs）。 */
  private followUpQueue: string[] = [];
  /**
   * 队列版本：每次内容变更 +1，随 state 投影与 prefs 一起下发。
   * 客户端据此丢弃乱序到达的过期快照（否则「引导整队发送」清队后，
   * 旧快照会把已发送的队列重新写回 UI）。
   */
  private followUpQueueRevision = 0;
  private followUpQueueHydrated = false;
  private flushingFollowUp = false;
  private followUpFlushBatch: string[] = [];
  private followUpFlushCursor = 0;
  private followUpFlushConfirmed = false;
  private followUpFlushAsOne = false;
  private followUpFlushOriginal: string[] = [];
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
  /** toolCallId → 渲染状态（跨 tool_call → update → result 共享）。 */
  private readonly toolRenderStates = new Map<string, ToolRenderStateEntry>();
  /** tool_execution_update 渲染最短间隔（ms），防高频 partial 阻塞事件循环。 */
  private static readonly PARTIAL_RENDER_MIN_INTERVAL_MS = 100;

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

  beginExtensionBinding(): void {
    /* start() 内 bind */
  }

  async waitForExtensionsBound(): Promise<void> {
    /* start 已 await bind */
  }

  private emit(event: SdkAgentEvent): void {
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

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this._alive || !this.runtime || this.startupHold || this.isRunning() || this.flushingFollowUp) return;
    if (this.listeners.length > 0) return; // 仍有活跃端点（SSE 订阅）→ 保活，不释放
    if (this.followUpQueue.length > 0 && !this.isFollowUpHeld()) {
      this.scheduleFollowUpFlush();
      return;
    }
    // Live host 是 JSONL writer。所有端点都关闭且 settled、空队列时才释放：
    // 立即 dispose 会让浏览器侧 contextUsage/extension footer/状态条随 live 投影
    // 消失（用户感知“会话一结束信息就没了”）。30s 兜底窗口给端点重连/重开，
    // 期间 UI 仍可读热 state；窗口内任何命令/事件都会 reset。
    const delay = this.idleTimeoutMs;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.isRunning() || this.flushingFollowUp) return;
      // fire 时又出现订阅者（30s 窗口内端点重开）：取消释放，继续保活。
      if (this.listeners.length > 0) return;
      if (this.followUpQueue.length > 0 && !this.isFollowUpHeld()) {
        this.scheduleFollowUpFlush();
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
      console.error("[pidance] failed to persist follow-up hold:", error);
    }
  }

  private hydrateFollowUpQueue(): void {
    if (this.followUpQueueHydrated) return;
    this.followUpQueueHydrated = true;
    const prefs = readPidancePrefs(this.agentDir);
    const raw = getPidancePref(prefs, `sessionQueue.${this.realSessionId}`);
    const asItems = (value: unknown): string[] => Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    if (Array.isArray(raw)) {
      // 旧格式（纯数组）：无版本号，从 0 起算
      this.followUpQueue = asItems(raw);
      return;
    }
    const stored = raw && typeof raw === "object" ? (raw as { items?: unknown; revision?: unknown }) : null;
    this.followUpQueue = asItems(stored?.items);
    if (typeof stored?.revision === "number") this.followUpQueueRevision = stored.revision;
  }

  /** 队列内容变更唯一入口：同步推进版本号，保证快照可判新旧。 */
  private updateFollowUpQueue(next: string[]): void {
    this.followUpQueue = next;
    this.followUpQueueRevision += 1;
  }

  private persistFollowUpQueue(): void {
    try {
      updatePidancePref(
        `sessionQueue.${this.realSessionId}`,
        { items: this.followUpQueue, revision: this.followUpQueueRevision },
        this.agentDir,
      );
    } catch (error) {
      console.error("[pidance] failed to persist follow-up queue:", error);
    }
  }

  private scheduleFollowUpFlush(): void {
    if (!this._alive || !this.runtime) return;
    if (this.flushingFollowUp) return;
    if (this.followUpQueue.length === 0) return;
    if (this.isFollowUpHeld()) return;
    if (!this.isSettled()) return;
    this.flushingFollowUp = true;
    this.followUpFlushAsOne = readPidancePrefs(this.agentDir).queueFlushAsOne === true;
    this.followUpFlushOriginal = [...this.followUpQueue];
    this.followUpFlushBatch = this.followUpFlushAsOne
      ? [this.followUpFlushOriginal.join("\n\n")]
      : [...this.followUpFlushOriginal];
    this.followUpFlushCursor = 0;
    this.followUpFlushConfirmed = false;
    void this.sendNextFollowUp();
  }

  private async sendNextFollowUp(): Promise<void> {
    if (!this.flushingFollowUp) return;
    if (this.isFollowUpHeld()) {
      this.abortFollowUpFlush();
      return;
    }
    const item = this.followUpFlushBatch[this.followUpFlushCursor];
    if (item === undefined) {
      this.finishFollowUpFlush();
      return;
    }
    if (!this.isSettled()) {
      // 上一轮 run 尚未完全落定（SDK streaming 尾态）。不能静默 return：
      // 等 agent_settled 事件推进；这里兜底一拍后重试，防事件与 streaming
      // 清态错位导致整队卡死或漏发。
      setTimeout(() => {
        if (this.flushingFollowUp && this.followUpFlushCursor < this.followUpFlushBatch.length) {
          void this.sendNextFollowUp();
        }
      }, 80);
      return;
    }
    this.followUpFlushConfirmed = false;
    try {
      await this.send({ type: "prompt", message: item });
      // 投递已受理（preflight 通过）即从队列移除并持久化：只等 message_end/
      // agent_settled 确认会让「已送达」的条目继续留在队列里，下一次 settle 再发
      // 一遍（实测同一文本 07:49 与 09:02 两次落盘）。确认事件仍会推进游标，
      // 此处的移除对它是幂等的。
      if (this.removeDeliveredFollowUp()) {
        this.emit({
          type: "follow_up_flushed",
          sessionId: this.realSessionId,
          item,
          remaining: [...this.followUpQueue],
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emit({ type: "follow_up_flush_error", errorMessage });
      this.abortFollowUpFlush();
    }
  }

  /**
   * 从队列里移除本次已投递的条目并持久化，返回是否有变更。
   *
   * flushAsOne：整组作为一条 prompt 发出 → 只清空本次快照条目；快照之后新入队的
   * 条目保留，避免 set_follow_up_queue 整组替换时丢新消息。
   * 逐条：只移除本次投递的那一条（同文本重复入队时按出现顺序取第一条）。
   */
  private removeDeliveredFollowUp(): boolean {
    if (this.followUpFlushAsOne) {
      const original = new Set(this.followUpFlushOriginal);
      const next = this.followUpQueue.filter((entry) => !original.has(entry));
      if (next.length === this.followUpQueue.length) return false;
      this.updateFollowUpQueue(next);
      this.persistFollowUpQueue();
      return true;
    }
    const item = this.followUpFlushBatch[this.followUpFlushCursor];
    if (item === undefined) return false;
    const idx = this.followUpQueue.indexOf(item);
    if (idx < 0) return false;
    const next = [...this.followUpQueue];
    next.splice(idx, 1);
    this.updateFollowUpQueue(next);
    this.persistFollowUpQueue();
    return true;
  }

  private confirmFollowUpFlush(): void {
    if (!this.flushingFollowUp || this.followUpFlushConfirmed) return;
    const item = this.followUpFlushBatch[this.followUpFlushCursor];
    if (item === undefined) return;
    this.followUpFlushConfirmed = true;
    this.removeDeliveredFollowUp();
    const remaining = [...this.followUpQueue];
    this.persistFollowUpQueue();
    this.emit({
      type: "follow_up_flushed",
      sessionId: this.realSessionId,
      item,
      remaining,
    });
    if (this.followUpFlushAsOne) {
      this.finishFollowUpFlush();
      return;
    }
    this.followUpFlushCursor += 1;
    if (this.followUpFlushCursor >= this.followUpFlushBatch.length) {
      this.finishFollowUpFlush();
    } else {
      void this.sendNextFollowUp();
    }
  }

  private abortFollowUpFlush(): void {
    if (!this.flushingFollowUp) return;
    this.flushingFollowUp = false;
    this.followUpFlushBatch = [];
    this.followUpFlushCursor = 0;
    this.followUpFlushConfirmed = false;
    this.followUpFlushAsOne = false;
    this.followUpFlushOriginal = [];
    // 未确认条目已在 followUpQueue 中保留；persist 确保 prefs 与内存一致。
    this.persistFollowUpQueue();
    this.resetIdleTimer();
  }

  private finishFollowUpFlush(): void {
    this.flushingFollowUp = false;
    this.followUpFlushBatch = [];
    this.followUpFlushCursor = 0;
    this.followUpFlushConfirmed = false;
    this.followUpFlushAsOne = false;
    this.followUpFlushOriginal = [];
    this.persistFollowUpQueue();
    this.resetIdleTimer();
    if (this.followUpQueue.length > 0 && !this.isFollowUpHeld()) {
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
      mode: "rpc",
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
        this.emit({ type: "prompt_done" });
        break;
      case "agent_settled":
        this.promptRunning = false;
        this.notifyRunning();
        // 触发点必须是 agent_settled；agent_end 只记录本轮结果。
        if (this.lastStopReason === "completed") {
          if (this.flushingFollowUp) {
            // message_end 可能缺失：agent_settled 作为兜底确认当前条目并推进。
            if (!this.followUpFlushConfirmed) {
              this.confirmFollowUpFlush();
            } else {
              void this.sendNextFollowUp();
            }
          } else {
            this.scheduleFollowUpFlush();
          }
        } else if (this.flushingFollowUp && (this.lastStopReason === "aborted" || this.lastStopReason === "error")) {
          this.abortFollowUpFlush();
        }
        // agent_settled 表示 SDK 已完成本轮及其内部 continuation。没有未 hold
        // 的产品队列时立即销毁 host，释放跨进程 writer lease；否则继续由队列
        // flush 持有 host，直到最后一轮完成。
        const disposeAfterSettle =
          event.type === "agent_settled"
          && !this.flushingFollowUp
          && (this.followUpQueue.length === 0 || this.isFollowUpHeld());
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
          // follow-up 投递的 user 消息确认：这里才推进队列，不能在 prompt preflight 清队。
          this.confirmFollowUpFlush();
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
    let eventToEmit = event;
    // 吞吐读数：TTFT 首帧 / 每个 step 结束时下发（服务端为唯一权威，客户端只渲染）。
    // 必须挂到 eventToEmit —— 它是 emit 的目标对象，直接改 event 会被下面的浅拷贝丢掉。
    if (metricsChanged) {
      const projected = this.projectTurnMetrics();
      if (projected.ttftMs !== undefined || projected.tokensPerSecond !== undefined) {
        eventToEmit = { ...eventToEmit, turnMetrics: projected };
      }
    }
    // 上下文占用随每条 assistant 消息（每个工具轮次）变化：message_end 时 SDK
    // 权威 messages 已含刚结束的这条，getContextUsage() 即最新值；只在 agent_end
    // 下发会让顶栏在整个 run 期间停在上一轮读数。agent_end 保留同字段，避免
    // settled 后立即 dispose 使浏览器错过最后一次热 state。
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
          const lines = renderCustomMessageLines(renderer, event.message, this.renderBridgeTheme);
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
   * 取自 toolCallId 的稳定入口，跨事件共享；invalidate no-op（web 端无需重渲染）。
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
      invalidate: () => {},
      lastComponent: opts.resultSlot ? entry.lastResultComponent : entry.lastCallComponent,
      state: entry.state,
      cwd: this.realCwd,
      executionStarted: true,
      argsComplete: true,
      isPartial: opts.isPartial,
      expanded: opts.expanded,
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
      if (this.followUpQueue.length > 0 && !this.isFollowUpHeld() && this.isSettled()) {
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
    };
    projected.queuedMessages = {
      steering: this.hasQueueSnapshot ? [...this.localQueue.steering] : [],
      followUp: [...this.followUpQueue],
      followUpRevision: this.followUpQueueRevision,
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

  async send(command: Record<string, unknown>): Promise<unknown> {
    if (!this.runtime) throw new Error("SDK session is not alive");
    const type = command.type as string;
    // 已失去 writer 租约：拒绝写命令（仍允许只读查询，便于浏览器对账）。
    if (
      this.leaseLost
      && type !== "get_state"
      && type !== "ensure_session"
      && type !== "get_session_stats"
      && type !== "get_tools"
      && type !== "get_commands"
      && type !== "get_last_assistant_text"
    ) {
      throw new Error(SESSION_RUNNING_LOCKED_MESSAGE);
    }
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
        if (this.bashRunning) {
          throw new Error("Cannot send a prompt while a shell command is running");
        }
        // AgentSession.prompt() rejects direct prompts while manual compaction is
        // running. Preserve the user's message in the existing Pidance follow-up
        // queue; compaction_end will schedule the normal prompt flush.
        if (session.isCompacting) {
          if (parsed.images?.length || binaryBlocks.length > 0) {
            throw new Error("Media attachments cannot be queued while compaction is in progress");
          }
          const queuedReceipt: PromptReceipt = {
            submissionId: parsed.submissionId,
            sessionId: this.realSessionId,
            status: "accepted",
          };
          this.updateFollowUpQueue([...this.followUpQueue, parsed.message]);
          this.promptReceipts.set(parsed.submissionId, queuedReceipt);
          this.persistFollowUpQueue();
          this.options.onSessionListInvalidate?.();
          return queuedReceipt;
        }
        // 写命令拿到租约后，必须先确认它仍属于本 host：acquireRunningLease 只
        // 拒绝「活持有者的租约」，而本进程可能已经失去过租约（见 leaseLost）。
        if (this.leaseLost) {
          throw new Error(SESSION_RUNNING_LOCKED_MESSAGE);
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
              this.emit({ type: "prompt_done" });
              this.resetIdleTimer();
            };
            void session
              .prompt(parsed.message, {
                images: (parsed.images ?? command.images) as never,
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
          this.promptRunning = false;
          this.lastStopReason = this.lastStopReason === "aborted" ? "aborted" : "error";
          this.setFollowUpHeld(true);
          clearRunningStartedAt(this.realSessionId);
          this.notifyRunning();
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.emit({ type: "prompt_error", errorMessage });
          this.emit({ type: "prompt_done" });
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
        const message = String(command.message ?? "");
        // 浏览器运行态可能因 SSE 收尾/重连竞态落后于 host。Pi SDK 在空闲时
        // steer() 只入 steering queue、不会启动 LLM，消息会静默挂起；由 host
        // 以权威运行态决定：运行中保留原生 steer，空闲时转成下一轮 prompt。
        // flushingFollowUp 也视为 busy：让引导进入即将投递的下一轮，而不是
        // 和 Host 的队列 flush 并发启动两个 prompt。
        if (!this.isRunning() && !this.flushingFollowUp) {
          return this.send({
            type: "prompt",
            message,
            images: command.images,
            streamingBehavior: "steer",
          });
        }
        await session.steer(message, command.images as never);
        return null;
      }

      case "set_follow_up_queue": {
        const items = Array.isArray(command.items)
          ? (command.items as unknown[]).filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          : [];
        // flush 进行中：浏览器整组替换会与 sendNextFollowUp 的 batch 快照并发
        // （清队 → 消息仍被投递但 UI 已空 / 或反被 abort 丢弃）。先中止自动
        // 投递，再按新 items 落地；中止只复位批处理状态，未确认条目仍按新
        // items 语义处理（空 = 用户有意取消）。
        if (this.flushingFollowUp) {
          this.abortFollowUpFlush();
        }
        this.updateFollowUpQueue(items);
        this.persistFollowUpQueue();
        // late-enqueue：如果已经 settled/空闲，立即调度一次投递。
        if (this.isSettled() && items.length > 0) this.scheduleFollowUpFlush();
        this.resetIdleTimer();
        return { ok: true, queued: this.followUpQueue.length };
      }

      case "follow_up": {
        await session.followUp(String(command.message ?? ""), command.images as never);
        return null;
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

  /**
   * 检查本 host 是否仍持有 writer 租约；被接管则标记失权并销毁。
   * 由 registry 心跳周期调用（见 syncOwnedRunningLeases）。
   */
  async checkWriterLease(): Promise<void> {
    if (!this._alive || this.leaseLost) return;
    if (refreshWriterLease(this.realSessionId)) return;
    this.leaseLost = true;
    console.warn(
      `[pidance] session ${this.realSessionId} lost its writer lease to another process; disconnecting`,
    );
    await this.destroyAsync();
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
      this.followUpFlushBatch = [];
      this.followUpFlushCursor = 0;
      this.followUpFlushConfirmed = false;
      this.followUpFlushAsOne = false;
      this.followUpFlushOriginal = [];
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
