/**
 * 外部 Pi RPC 会话：对上提供与 AgentSessionWrapper 兼容的 send/onEvent/destroy。
 *
 * 运行命令走 PiRpcProcess；产品 fork / 树导航走磁盘 SessionFile，并在写树前
 * quiesce（停进程）。扩展 UI / TUI 工具渲染一期透传或降级。
 */

import { dirname } from "node:path";
import { openSessionFile, SessionFile } from "../session-file";
import { clearLeafSidecar, readLeafSidecar } from "../session-leaf-sidecar";
import {
  normalizeActivityInput,
  parseAppendActivityCommand,
  PIDANCE_ACTIVITY_CUSTOM_TYPE,
} from "../session-activity";
import { PiRpcProcess, type RpcCommand } from "./rpc-process";
import { resolveRuntimeBinary } from "./resolve-binary";
import { quiesceRpcProcess } from "./session-quiesce";
import type { AssemblerAgentEvent } from "./message-assembler";
import { unsupportedCommand } from "./rpc-capabilities";
import {
  projectRpcAgentState,
  type QueuedMessagesSnapshot,
} from "./project-rpc-state";
export type ExternalEventListener = (event: AssemblerAgentEvent) => void;

export type NavigationActions = {
  selectLeafExact: (sessionId: string, entryId: string) => Promise<{ cancelled: boolean }>;
  branchFromAssistant: (
    sessionId: string,
    assistantEntryId: string,
  ) => Promise<{ cancelled: boolean }>;
  createSessionFromLeaf: (
    sessionId: string,
    entryId: string,
  ) => Promise<{ cancelled: boolean; newSessionId: string }>;
};

export type ExternalSessionOptions = {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  /** 可在 set_tools 后就地更新，供重启 spawn 使用 */
  toolNames?: string[];
  navigationActions?: NavigationActions;
  /** 空闲超时 ms，默认 10min */
  idleTimeoutMs?: number;
  onRunningChange?: () => void;
  onSessionListInvalidate?: () => void;
  cacheSessionPath?: (sessionId: string, sessionFile: string) => void;
};

/**
 * 与 AgentSessionWrapper 公共面兼容的外部会话。
 * 注意：无 inner AgentSession；get_state 等来自 RPC。
 */
export class ExternalRpcSession {
  private listeners: ExternalEventListener[] = [];
  private process: PiRpcProcess | null = null;
  private unsubscribeProcess: (() => void) | null = null;
  private unsubscribeExit: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private _alive = true;
  private promptRunning = false;
  private streaming = false;
  private compacting = false;
  private bashRunning = false;
  private realSessionId: string;
  private realSessionFile: string;
  private readonly idleTimeoutMs: number;
  /** 阻塞中的扩展 UI 请求（切回会话重建问题块） */
  private pendingUiRequests = new Map<string, AssemblerAgentEvent>();
  private extensionStatuses = new Map<string, string>();
  private extensionWidgets = new Map<string, unknown>();
  /** 仅来自 queue_update 事件；非 get_state 伪造 */
  private localQueue: QueuedMessagesSnapshot = { steering: [], followUp: [] };
  private hasQueueSnapshot = false;
  /**
   * 外部 RPC 无 get_tools/set_tools 协议命令；工具由 spawn 参数控制。
   * undefined = 未收窄（全集）；[] = --no-tools；非空 = 启动 allow-list（配置，非 runtime 探测）。
   */
  private activeToolNames: string[] | undefined;

  constructor(private readonly options: ExternalSessionOptions) {
    this.realSessionId = options.sessionId;
    this.realSessionFile = options.sessionFile;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 10 * 60 * 1000;
    this.activeToolNames = options.toolNames;
  }

  get sessionId(): string {
    return this.realSessionId;
  }

  get sessionFile(): string {
    return this.realSessionFile;
  }

  isAlive(): boolean {
    return this._alive && (this.process?.isAlive() ?? false);
  }

  isRunning(): boolean {
    return this._alive && (this.promptRunning || this.streaming || this.compacting || this.bashRunning);
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  onEvent(listener: ExternalEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** 扩展绑定：外部 pi 进程启动时自行加载扩展；此处 no-op 兼容。 */
  beginExtensionBinding(): void {
    /* RPC 进程内加载扩展，无需 Pidance bind */
  }

  async waitForExtensionsBound(): Promise<void> {
    /* no-op */
  }

  private emit(event: AssemblerAgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[pidance] external session listener error:", err);
      }
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.isRunning()) {
        this.resetIdleTimer();
        return;
      }
      this.destroy();
    }, this.idleTimeoutMs);
  }

  private notifyRunning(): void {
    this.options.onRunningChange?.();
  }

  /**
   * 外部 pi 打开文件时 leaf = 文件末尾；若 sidecar 导航目标不是末尾，
   * 外部 runtime 无法恢复该分支。emit leaf_drift（前端明确提示，不静默挂错分支）。
   */
  private emitLeafDriftIfAny(): void {
    if (!this.realSessionFile) return;
    try {
      const expected = readLeafSidecar(this.realSessionFile);
      if (!expected) return;
      const disk = openSessionFile(this.realSessionFile);
      const actual = disk.getLastEntryId();
      if (actual && actual !== expected) {
        this.emit({
          type: "leaf_drift",
          expectedLeafId: expected,
          actualLeafId: actual,
        });
      }
    } catch {
      /* 检测失败不阻塞启动 */
    }
  }

  private handleProcessEvent(event: AssemblerAgentEvent): void {
    this.resetIdleTimer();
    switch (event.type) {
      case "agent_start":
        this.streaming = true;
        this.notifyRunning();
        break;
      case "agent_end":
        this.streaming = false;
        this.promptRunning = false;
        this.options.onSessionListInvalidate?.();
        // 对话已推进：sidecar 导航意图被实际对话位置取代，清除避免下次 open
        // 回退到过期 leaf（外部 pi append 不写 sidecar）。
        clearLeafSidecar(this.realSessionFile);
        this.notifyRunning();
        // 与 inprocess 对齐：前端靠 prompt_done 收尾 run
        this.emit({ type: "prompt_done" });
        break;
      case "agent_settled":
        this.streaming = false;
        this.promptRunning = false;
        this.notifyRunning();
        break;
      case "compaction_start":
      case "auto_compaction_start":
        this.compacting = true;
        this.notifyRunning();
        break;
      case "compaction_end":
      case "auto_compaction_end":
        this.compacting = false;
        this.options.onSessionListInvalidate?.();
        this.notifyRunning();
        break;
      case "extension_ui_request": {
        this.trackExtensionUiRequest(event);
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
    this.emit(event);
  }

  /**
   * 跟踪阻塞类 extension_ui_request；fire-and-forget（notify/setStatus/setWidget）
   * 更新本地状态快照，供 get_state 重建。
   */
  private trackExtensionUiRequest(event: AssemblerAgentEvent): void {
    const method = event.method as string | undefined;
    const id = typeof event.id === "string" ? event.id : null;
    if (!method) return;

    if (method === "setStatus") {
      // Pi 0.83 字段：statusKey / statusText
      const key =
        typeof event.statusKey === "string"
          ? event.statusKey
          : typeof event.key === "string"
            ? event.key
            : "default";
      const text =
        typeof event.statusText === "string"
          ? event.statusText
          : typeof event.text === "string"
            ? event.text
            : "";
      if (text) this.extensionStatuses.set(key, text);
      else this.extensionStatuses.delete(key);
      return;
    }
    if (method === "setWidget") {
      // Pi 0.83 字段：widgetKey / widgetLines / widgetPlacement
      const key =
        typeof event.widgetKey === "string"
          ? event.widgetKey
          : typeof event.key === "string"
            ? event.key
            : "default";
      const rawLines: unknown = Array.isArray(event.widgetLines)
        ? event.widgetLines
        : event.content;
      if (rawLines == null) this.extensionWidgets.delete(key);
      else {
        this.extensionWidgets.set(key, {
          // setStatus/setWidget 是纯文本 UI；清洗 ANSI 防乱码（mcp/scout 插件带颜色码）
          // 原文存储（含 ANSI 颜色码）；渲染层 parseAnsiLine 解析成彩色 span
          lines: Array.isArray(rawLines)
            ? rawLines.filter((l): l is string => typeof l === "string")
            : [],
          placement:
            event.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor",
        });
      }
      return;
    }
    // select/confirm/input/editor/custom：阻塞，记入 pending
    if (
      method === "select" ||
      method === "confirm" ||
      method === "input" ||
      method === "editor" ||
      method === "custom"
    ) {
      if (id) this.pendingUiRequests.set(id, event);
    }
    // notify / setTitle / set_editor_text：fire-and-forget，仅透传 emit
  }

  async start(): Promise<void> {
    const resolved = resolveRuntimeBinary();
    if (!resolved.path) {
      throw new Error(
        "未找到外部 Pi runtime：请设置 PIDANCE_PI_RUNTIME 或将 pi 加入 PATH" +
          "（调试可设 PIDANCE_PI_RUNTIME_FALLBACK_BUNDLED=1）",
      );
    }

    const sessionDir = this.realSessionFile
      ? dirname(this.realSessionFile)
      : undefined;

    const proc = new PiRpcProcess({
      binaryPath: resolved.path,
      cwd: this.options.cwd,
      sessionFile: this.realSessionFile || undefined,
      sessionDir,
      toolNames: this.options.toolNames,
    });
    await proc.start();
    this.process = proc;
    this.unsubscribeProcess = proc.onEvent((e) => this.handleProcessEvent(e));
    this.unsubscribeExit = proc.onExit((info) => {
      if (info.intentional) return;
      // 异常退出：通知前端/侧栏，清 running，不伪造会话内容
      this.promptRunning = false;
      this.streaming = false;
      this.compacting = false;
      this.bashRunning = false;
      this._alive = false;
      this.process = null;
      this.emit({
        type: "runtime_lost",
        errorMessage: info.error.message,
        code: info.code,
        signal: info.signal,
      });
      this.emit({ type: "prompt_done" });
      this.options.onSessionListInvalidate?.();
      this.notifyRunning();
      this.onDestroyCallback?.();
    });

    // 校验 / 同步 session 身份
    try {
      const state = await proc.request<{
        sessionId?: string;
        sessionFile?: string;
        isStreaming?: boolean;
        isCompacting?: boolean;
      }>({ type: "get_state" });
      if (state.sessionId) this.realSessionId = state.sessionId;
      if (state.sessionFile) {
        this.realSessionFile = state.sessionFile;
        this.options.cacheSessionPath?.(this.realSessionId, this.realSessionFile);
      }
      this.streaming = state.isStreaming === true;
      this.compacting = state.isCompacting === true;
    } catch (err) {
      await proc.stop().catch(() => undefined);
      this.process = null;
      throw err;
    }

    // leaf 恢复校验：外部 pi 打开文件时 leaf = 文件末尾；若 sidecar 记录的
    // 导航目标不是末尾，外部 runtime 无法恢复该分支。emit leaf_drift 让前端
    // 明确提示（不静默把后续消息挂到错误分支）。
    this.emitLeafDriftIfAny();

    // 工具收窄只靠 spawn --tools / --no-tools；不在启动后再发收窄 RPC。

    this.resetIdleTimer();
    this.notifyRunning();
  }

  private requireProcess(): PiRpcProcess {
    if (!this.process?.isAlive()) {
      throw new Error("External RPC session is not alive");
    }
    return this.process;
  }

  /**
   * 树写前 quiesce：abort → 尽量等 settled → 停进程。
   * 调用后 session 标记 dead，调用方需 destroy/清 registry。
   */
  async quiesceForTreeWrite(): Promise<void> {
    const proc = this.process;
    await quiesceRpcProcess(
      proc
        ? {
            isAlive: () => proc.isAlive(),
            abort: async () => {
              await proc.request({ type: "abort" }).catch(() => undefined);
            },
            stop: async () => {
              await proc.stop().catch(() => undefined);
            },
          }
        : null,
    );
    this.process = null;
    this.promptRunning = false;
    this.streaming = false;
    this.compacting = false;
    this.bashRunning = false;
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    this.resetIdleTimer();
    const type = command.type as string;

    switch (type) {
      case "prompt": {
        if (this.bashRunning) {
          throw new Error("Cannot send a prompt while a shell command is running");
        }
        const proc = this.requireProcess();
        this.promptRunning = true;
        this.notifyRunning();
        const payload: RpcCommand = {
          type: "prompt",
          message: command.message as string,
        };
        if (command.images) payload.images = command.images;
        if (command.streamingBehavior) payload.streamingBehavior = command.streamingBehavior;
        try {
          await proc.request(payload);
          // 成功接受后事件异步继续；prompt_done 在 agent_end 侧不强制
          return null;
        } catch (error) {
          this.promptRunning = false;
          this.notifyRunning();
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.emit({ type: "prompt_error", errorMessage });
          this.emit({ type: "prompt_done" });
          throw error;
        }
      }

      case "abort": {
        this.promptRunning = false;
        this.notifyRunning();
        const proc = this.process;
        if (proc?.isAlive()) {
          await proc.request({ type: "abort" }).catch(() => undefined);
        }
        this.streaming = false;
        this.notifyRunning();
        return null;
      }

      case "get_state": {
        const proc = this.requireProcess();
        const data = await proc.request<Record<string, unknown>>({ type: "get_state" });
        // contextUsage 仅来自 get_session_stats；失败则省略（未知，不伪造 0%）
        let sessionStats: Record<string, unknown> | null = null;
        try {
          sessionStats = await proc.request<Record<string, unknown>>({
            type: "get_session_stats",
          });
        } catch {
          sessionStats = null;
        }
        if (typeof data.sessionId === "string" && data.sessionId) {
          this.realSessionId = data.sessionId;
        }
        if (typeof data.sessionFile === "string" && data.sessionFile) {
          this.realSessionFile = data.sessionFile;
          this.options.cacheSessionPath?.(this.realSessionId, this.realSessionFile);
        }
        this.streaming = data.isStreaming === true || this.streaming;
        this.compacting = data.isCompacting === true || this.compacting;
        return projectRpcAgentState({
          rpc: data,
          fallbackSessionId: this.realSessionId,
          fallbackSessionFile: this.realSessionFile,
          isPromptRunning: this.promptRunning,
          isBashRunning: this.bashRunning,
          localStreaming: this.streaming,
          localCompacting: this.compacting,
          localQueue: this.hasQueueSnapshot ? this.localQueue : undefined,
          extensionStatuses: Array.from(this.extensionStatuses, ([key, text]) => ({ key, text })),
          extensionWidgets: Array.from(this.extensionWidgets, ([key, content]) => ({ key, content })),
          pendingExtensionRequests: Array.from(this.pendingUiRequests.values()),
          sessionStats,
        });
      }

      case "set_model": {
        const proc = this.requireProcess();
        const result = await proc.request({
          type: "set_model",
          provider: command.provider,
          modelId: command.modelId,
        });
        this.options.onSessionListInvalidate?.();
        return result;
      }

      case "set_thinking_level": {
        const proc = this.requireProcess();
        await proc.request({ type: "set_thinking_level", level: command.level });
        this.options.onSessionListInvalidate?.();
        return null;
      }

      case "compact": {
        const proc = this.requireProcess();
        this.compacting = true;
        this.notifyRunning();
        try {
          const result = await proc.request({
            type: "compact",
            ...(command.customInstructions
              ? { customInstructions: command.customInstructions }
              : {}),
          });
          return result;
        } finally {
          this.compacting = false;
          this.options.onSessionListInvalidate?.();
          this.notifyRunning();
        }
      }

      case "steer": {
        const proc = this.requireProcess();
        await proc.request({
          type: "steer",
          message: command.message,
          ...(command.images ? { images: command.images } : {}),
        });
        return null;
      }

      case "follow_up": {
        const proc = this.requireProcess();
        await proc.request({
          type: "follow_up",
          message: command.message,
          ...(command.images ? { images: command.images } : {}),
        });
        return null;
      }

      case "set_session_name": {
        const proc = this.requireProcess();
        const name = (command.name as string | undefined)?.trim();
        if (!name) throw new Error("Session name cannot be empty");
        await proc.request({ type: "set_session_name", name });
        this.options.onSessionListInvalidate?.();
        return null;
      }

      case "set_auto_compaction": {
        const proc = this.requireProcess();
        await proc.request({ type: "set_auto_compaction", enabled: command.enabled });
        return null;
      }

      case "set_auto_retry": {
        const proc = this.requireProcess();
        await proc.request({ type: "set_auto_retry", enabled: command.enabled });
        return null;
      }

      case "clear_queue": {
        // 不发未知 RPC，不伪造成功清空远程队列
        return unsupportedCommand(
          "clear_queue",
          "Pi 0.83 RPC 无 clear_queue；队列仅可通过 queue_update 观察",
        );
      }

      case "get_tools": {
        // 产品本地：返回启动 allow-list 配置，非 runtime 权威探测
        return this.listConfiguredTools();
      }

      case "set_tools": {
        // 无运行时 set_tools：记录后 quiesce 并重启进程以应用 spawn 参数
        const toolNames = command.toolNames as string[];
        this.activeToolNames = Array.isArray(toolNames) ? toolNames : undefined;
        this.options.toolNames = this.activeToolNames;
        await this.quiesceForTreeWrite();
        this._alive = true;
        await this.start();
        return null;
      }

      case "get_commands": {
        const proc = this.requireProcess();
        try {
          return await proc.request({ type: "get_commands" });
        } catch {
          return { commands: [] };
        }
      }

      case "get_session_stats": {
        const proc = this.requireProcess();
        return proc.request({ type: "get_session_stats" });
      }

      case "bash": {
        if (this.isRunning()) {
          throw new Error("Cannot run a shell command while the session is busy");
        }
        const proc = this.requireProcess();
        this.bashRunning = true;
        this.notifyRunning();
        try {
          return await proc.request({
            type: "bash",
            command: command.command,
            ...(command.excludeFromContext !== undefined
              ? { excludeFromContext: command.excludeFromContext }
              : {}),
          });
        } finally {
          this.bashRunning = false;
          this.options.onSessionListInvalidate?.();
          this.notifyRunning();
        }
      }

      case "abort_bash": {
        const proc = this.process;
        if (proc?.isAlive()) {
          await proc.request({ type: "abort_bash" }).catch(() => undefined);
        }
        this.bashRunning = false;
        this.notifyRunning();
        return null;
      }

      case "abort_compaction": {
        return unsupportedCommand(
          "abort_compaction",
          "Pi 0.83 RPC 无 abort_compaction",
        );
      }

      case "extension_ui_response": {
        const proc = this.requireProcess();
        const id = command.id as string;
        // 组装 RPC 响应：透传 value/confirmed/cancelled
        const payload: RpcCommand = { type: "extension_ui_response", id };
        if (command.value !== undefined) payload.value = command.value;
        if (command.confirmed !== undefined) payload.confirmed = command.confirmed;
        if (command.cancelled !== undefined) payload.cancelled = command.cancelled;
        // Pi 0.83 对 extension_ui_response 不回响应（fire-and-forget）：
        // 用 notify 不等响应，否则 30s 超时且本地 pending 不消费 →
        // 重载后阻塞请求重现、会话卡在扩展请求上。
        proc.notify(payload);
        if (id) this.pendingUiRequests.delete(id);
        return null;
      }

      case "extension_ui_input": {
        // 0.83 仅有 extension_ui_response，无 progressive input 命令
        return unsupportedCommand(
          "extension_ui_input",
          "Pi 0.83 RPC 仅支持 extension_ui_response，不支持 extension_ui_input",
        );
      }

      case "append_activity": {
        return this.appendActivity(command as Record<string, unknown>);
      }

      // —— 产品树操作：quiesce → SessionFile → destroy —— //
      case "fork": {
        if (this.bashRunning) throw new Error("Cannot fork while a shell command is running");
        const entryId = command.entryId as string;
        const currentSessionFile = this.realSessionFile;
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");

        await this.quiesceForTreeWrite();

        const sessionManager = openSessionFile(currentSessionFile);
        if (!sessionManager.isPersisted()) {
          this.destroy();
          return { cancelled: true };
        }
        const entry = sessionManager.getEntry(entryId);
        if (!entry) {
          this.destroy();
          throw new Error("Invalid entry ID for forking");
        }
        const sessionDir = sessionManager.getSessionDir();
        let newSessionFile: string;
        if (!entry.parentId) {
          const newManager = SessionFile.create(sessionManager.getCwd(), sessionDir);
          newManager.newSession({ parentSession: currentSessionFile });
          newSessionFile = newManager.getSessionFile() as string;
        } else {
          const sourceManager = openSessionFile(currentSessionFile, sessionDir);
          const forkedPath = sourceManager.createBranchedSession(entry.parentId);
          if (!forkedPath) {
            this.destroy();
            throw new Error("Failed to create forked session");
          }
          newSessionFile = forkedPath;
        }
        const forkedManager = openSessionFile(newSessionFile, sessionDir);
        const newSessionId = forkedManager.getSessionId();
        this.options.cacheSessionPath?.(newSessionId, newSessionFile);
        this.options.onSessionListInvalidate?.();
        this.destroy();
        return { cancelled: false, newSessionId };
      }

      case "navigate_tree": {
        if (this.bashRunning) throw new Error("Cannot navigate while a shell command is running");
        // 无公开 navigate_tree RPC：磁盘 branch 后必须停进程（summarize 一期不做）
        const targetId = command.targetId as string;
        if (!targetId) throw new Error("targetId is required");
        await this.quiesceForTreeWrite();
        const sessionManager = openSessionFile(this.realSessionFile);
        try {
          if (!sessionManager.getEntry(targetId)) {
            throw new Error(`Entry ${targetId} not found`);
          }
          if (sessionManager.getLastEntryId() !== targetId) {
            sessionManager.branch(targetId);
          } else {
            // 目标是文件末尾 = 外部 pi 默认 leaf：清除过期 sidecar。
            // 只跳过写入会残留旧分支指针，下次磁盘 open 恢复旧 leaf，
            // 导航到最新分支的意图丢失（UI 弹回旧分支）。
            clearLeafSidecar(this.realSessionFile);
          }
          this.options.onSessionListInvalidate?.();
          return { cancelled: false };
        } finally {
          this.destroy();
        }
      }

      case "select_leaf_exact": {
        const rawEntryId = command.entryId;
        if (typeof rawEntryId !== "string" || rawEntryId.trim() === "") {
          throw new Error("entryId is required");
        }
        if (!this.options.navigationActions) {
          throw new Error("select_leaf_exact is unavailable: navigation actions were not injected");
        }
        await this.quiesceForTreeWrite();
        try {
          return await this.options.navigationActions.selectLeafExact(
            this.sessionId,
            rawEntryId.trim(),
          );
        } finally {
          this.destroy();
        }
      }

      case "branch_from_assistant": {
        const rawEntryId = command.assistantEntryId;
        if (typeof rawEntryId !== "string" || rawEntryId.trim() === "") {
          throw new Error("assistantEntryId is required");
        }
        if (!this.options.navigationActions) {
          throw new Error("branch_from_assistant is unavailable: navigation actions were not injected");
        }
        await this.quiesceForTreeWrite();
        try {
          return await this.options.navigationActions.branchFromAssistant(
            this.sessionId,
            rawEntryId.trim(),
          );
        } finally {
          this.destroy();
        }
      }

      case "create_session_from_leaf": {
        const rawEntryId = command.entryId;
        if (typeof rawEntryId !== "string" || rawEntryId.trim() === "") {
          throw new Error("entryId is required");
        }
        if (!this.options.navigationActions) {
          throw new Error("create_session_from_leaf is unavailable: navigation actions were not injected");
        }
        await this.quiesceForTreeWrite();
        try {
          return await this.options.navigationActions.createSessionFromLeaf(
            this.sessionId,
            rawEntryId.trim(),
          );
        } finally {
          this.destroy();
        }
      }

      case "set_branch_label": {
        await this.quiesceForTreeWrite();
        try {
          const targetId = command.targetId as string;
          const label = command.label as string | undefined;
          const sessionManager = openSessionFile(this.realSessionFile);
          const entryId = sessionManager.appendLabelChange(targetId, label as string);
          this.options.onSessionListInvalidate?.();
          return { targetId, label: label ?? null, entryId };
        } finally {
          this.destroy();
        }
      }

      case "reload": {
        // 重启外部进程
        await this.quiesceForTreeWrite();
        this._alive = true;
        await this.start();
        return { success: true };
      }

      case "flush_queue_as_steer": {
        // 无 clear_queue 时不能安全「清空后重入队」，避免双发
        return unsupportedCommand(
          "flush_queue_as_steer",
          "Pi 0.83 RPC 无 clear_queue，无法安全 flush 队列为 steer",
        );
      }

      case "get_last_assistant_text": {
        const proc = this.requireProcess();
        try {
          return await proc.request({ type: "get_last_assistant_text" });
        } catch {
          return { text: "" };
        }
      }

      default:
        throw new Error(`Unsupported command on external RPC: ${type}`);
    }
  }

  /**
   * 返回启动时配置的工具 allow-list（source=configured）。
   * 不调用未知 get_tools RPC，不把配置冒充 runtime 探测结果。
   */
  private listConfiguredTools(): {
    tools: Array<{ name: string; description: string; active: boolean }>;
    source: "configured";
  } {
    if (this.activeToolNames && this.activeToolNames.length === 0) {
      return { tools: [], source: "configured" };
    }
    const names = this.activeToolNames
      ? [...this.activeToolNames]
      : ["read", "bash", "edit", "write", "grep", "find", "ls"];
    return {
      source: "configured",
      tools: names.map((name) => ({
        name,
        description: "",
        active: true,
      })),
    };
  }

  /**
   * 持久活动写入：磁盘 SessionFile.appendCustomEntry。
   * 外部 RPC 无 inner；与 inprocess wrapper.appendActivity 同语义。
   */
  appendActivity(input: Record<string, unknown> | unknown): {
    entryId: string;
    activity: unknown;
  } {
    if (!this.realSessionFile) {
      throw new Error("Cannot append activity: session file missing");
    }
    const activity =
      input &&
      typeof input === "object" &&
      "type" in (input as object) &&
      (input as { type?: string }).type === "append_activity"
        ? parseAppendActivityCommand(input as Record<string, unknown>)
        : normalizeActivityInput(input);
    const manager = openSessionFile(this.realSessionFile);
    const entryId = manager.appendCustomEntry(PIDANCE_ACTIVITY_CUSTOM_TYPE, activity);
    this.options.onSessionListInvalidate?.();
    return { entryId, activity };
  }

  destroy(): void {
    if (!this._alive && !this.process) return;
    this._alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.unsubscribeProcess?.();
    this.unsubscribeProcess = null;
    this.unsubscribeExit?.();
    this.unsubscribeExit = null;
    const proc = this.process;
    this.process = null;
    if (proc) {
      void proc.stop().catch(() => undefined);
    }
    this.promptRunning = false;
    this.streaming = false;
    this.compacting = false;
    this.bashRunning = false;
    this.pendingUiRequests.clear();
    this.extensionStatuses.clear();
    this.extensionWidgets.clear();
    this.onDestroyCallback?.();
    this.notifyRunning();
  }
}
