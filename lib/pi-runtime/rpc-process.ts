/**
 * 单个外部 `pi --mode rpc` 子进程：JSONL 请求/响应 + 事件流。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { attachJsonlLineReader, serializeJsonLine } from "./framing";
import { MessageAssembler, type AssemblerAgentEvent } from "./message-assembler";

export type RpcCommand = Record<string, unknown> & { type: string };

export type RpcResponse = {
  type: "response";
  id?: string;
  command?: string;
  success: boolean;
  data?: unknown;
  error?: string;
};

export type RpcEventListener = (event: AssemblerAgentEvent) => void;

export type RpcProcessExitInfo = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error;
};

export type StartRpcProcessOptions = {
  /** pi 可执行文件或 cli.js 绝对路径 */
  binaryPath: string;
  cwd: string;
  /** 已有会话文件；空则让 pi 新建（或 --no-session） */
  sessionFile?: string;
  /** 会话目录（--session-dir） */
  sessionDir?: string;
  /** 工具名 allow-list；[] 表示 --no-tools */
  toolNames?: string[];
  env?: NodeJS.ProcessEnv;
  /** 请求超时 ms，默认 30s */
  requestTimeoutMs?: number;
  /** 是否组装 message_update 累计 message，默认 true */
  assembleMessages?: boolean;
};

type Pending = {
  resolve: (r: RpcResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class PiRpcProcess {
  private process: ChildProcessWithoutNullStreams | null = null;
  private detachReader: (() => void) | null = null;
  private pending = new Map<string, Pending>();
  private requestId = 0;
  private eventListeners = new Set<RpcEventListener>();
  private exitListeners = new Set<(info: RpcProcessExitInfo) => void>();
  private assembler = new MessageAssembler();
  private stderrBuf = "";
  private exitError: Error | null = null;
  private _alive = false;
  private intentionalStop = false;
  private requestTimeoutMs: number;
  private assembleMessages: boolean;

  readonly binaryPath: string;
  readonly cwd: string;

  constructor(private readonly options: StartRpcProcessOptions) {
    this.binaryPath = options.binaryPath;
    this.cwd = options.cwd;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.assembleMessages = options.assembleMessages !== false;
  }

  isAlive(): boolean {
    return this._alive && this.process != null && this.process.exitCode === null;
  }

  get stderr(): string {
    return this.stderrBuf.slice(-8000);
  }

  onEvent(listener: RpcEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** 进程异常/退出回调（含主动 stop；调用方可据 intentional 区分）。 */
  onExit(listener: (info: RpcProcessExitInfo & { intentional: boolean }) => void): () => void {
    const wrapped = (info: RpcProcessExitInfo) => {
      listener({ ...info, intentional: this.intentionalStop });
    };
    this.exitListeners.add(wrapped);
    return () => this.exitListeners.delete(wrapped);
  }

  async start(): Promise<void> {
    if (this.process) throw new Error("PiRpcProcess already started");

    const args = this.buildArgs();
    const isJs = this.binaryPath.endsWith(".js");
    const command = isJs ? process.execPath : this.binaryPath;
    const argv = isJs ? [this.binaryPath, ...args] : args;

    const child = spawn(command, argv, {
      cwd: this.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;
    this._alive = true;

    this.detachReader = attachJsonlLineReader(child.stdout, (line) => this.handleLine(line));

    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (this.stderrBuf.length > 32_000) {
        this.stderrBuf = this.stderrBuf.slice(-16_000);
      }
    });

    child.on("error", (err) => {
      this.exitError = err;
      this.rejectAll(err);
      this._alive = false;
    });

    child.on("exit", (code, signal) => {
      const err =
        this.exitError ??
        new Error(`Agent process exited (code=${code} signal=${signal}). Stderr: ${this.stderr}`);
      this.exitError = err;
      this.rejectAll(err);
      this._alive = false;
      this.process = null;
      const info: RpcProcessExitInfo = { code, signal, error: err };
      for (const listener of this.exitListeners) {
        try {
          listener(info);
        } catch (e) {
          console.error("[pidance] rpc exit listener error:", e);
        }
      }
    });
  }

  private buildArgs(): string[] {
    const args = ["--mode", "rpc"];
    const { sessionFile, sessionDir, toolNames } = this.options;
    if (sessionDir) args.push("--session-dir", sessionDir);
    if (sessionFile) {
      args.push("--session", sessionFile);
    }
    if (toolNames !== undefined) {
      if (toolNames.length === 0) {
        args.push("--no-tools");
      } else {
        // 非空 allow-list：传 --tools；扩展工具若未列入则不可用（与 CLI 一致）
        args.push("--tools", toolNames.join(","));
      }
    }
    // toolNames === undefined：不传工具旗标 → pi 默认全集
    return args;
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if (data.type === "response" && typeof data.id === "string" && this.pending.has(data.id)) {
      const pending = this.pending.get(data.id)!;
      this.pending.delete(data.id);
      clearTimeout(pending.timer);
      pending.resolve(data as RpcResponse);
      return;
    }

    // 事件
    let event = data as AssemblerAgentEvent;
    if (this.assembleMessages) {
      const assembled = this.assembler.process(event);
      if (assembled === null) return;
      event = assembled;
    }
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[pidance] rpc event listener error:", err);
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async send(command: RpcCommand): Promise<RpcResponse> {
    const child = this.process;
    const stdin = child?.stdin;
    if (!child || !stdin) throw new Error("Client not started");
    if (this.exitError) throw this.exitError;
    if (child.exitCode !== null) {
      const error =
        this.exitError ??
        new Error(`Agent process exited (code=${child.exitCode}). Stderr: ${this.stderr}`);
      this.exitError = error;
      throw error;
    }
    if (stdin.destroyed || !stdin.writable) {
      throw new Error(`Agent process stdin is not writable. Stderr: ${this.stderr}`);
    }

    const id = `req_${++this.requestId}`;
    const fullCommand = { ...command, id };

    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });

      try {
        stdin.write(serializeJsonLine(fullCommand));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** 发送命令并在 success 时返回 data，否则抛错。 */

  /**
   * 发送命令但不等待响应（fire-and-forget）。
   * Pi 0.83 对部分命令不回响应（如 extension_ui_response）：request 会等到
   * 30s 超时才抛错，且调用方无法及时消费本地状态（重载后阻塞请求重现）。
   */
  notify(command: RpcCommand): void {
    const child = this.process;
    const stdin = child?.stdin;
    if (!child || !stdin) throw new Error("Client not started");
    if (this.exitError) throw this.exitError;
    if (child.exitCode !== null) {
      throw (
        this.exitError ??
        new Error(`Agent process exited (code=${child.exitCode}). Stderr: ${this.stderr}`)
      );
    }
    if (stdin.destroyed || !stdin.writable) {
      throw new Error(`Agent process stdin is not writable. Stderr: ${this.stderr}`);
    }
    // fire-and-forget：原样发送（不等响应，无需 RPC 请求 id；
    // command.id 保留调用方语义——如 extension_ui_response 的扩展请求 id）
    stdin.write(serializeJsonLine(command));
  }
  async request<T = unknown>(command: RpcCommand): Promise<T> {
    const response = await this.send(command);
    if (!response.success) {
      throw new Error(response.error ?? `RPC command failed: ${command.type}`);
    }
    return response.data as T;
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    this.intentionalStop = true;
    const child = this.process;
    if (!child) {
      this._alive = false;
      return;
    }
    this.detachReader?.();
    this.detachReader = null;
    this.assembler.reset();

    if (child.exitCode !== null) {
      this.process = null;
      this._alive = false;
      return;
    }

    await new Promise<void>((resolve) => {
      const forceTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 3000);
      child.once("exit", () => {
        clearTimeout(forceTimer);
        resolve();
      });
      try {
        child.kill(signal);
      } catch {
        clearTimeout(forceTimer);
        resolve();
      }
    });
    this.process = null;
    this._alive = false;
    this.rejectAll(new Error("Process stopped"));
  }
}
