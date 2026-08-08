/**
 * 将 Pi RPC get_state（及可选 get_session_stats）投影为前端消费的状态快照。
 * 只透传权威字段；本地覆盖显式标注，不把空默认值伪装成 runtime 事实。
 */

import { PI_RPC_GET_STATE_FIELDS } from "./rpc-capabilities";

export type RpcModelRef = {
	id: string;
	provider: string;
};

export type ContextUsageSnapshot = {
	percent: number | null;
	contextWindow: number;
	tokens: number | null;
};

export type QueuedMessagesSnapshot = {
	steering: string[];
	followUp: string[];
};

export type ProjectedAgentState = {
	/** 状态字段来源说明（调试 / 前端降级用） */
	stateSources: {
		rpcGetState: true;
		sessionStats: boolean;
		localQueue: boolean;
		localExtensionUi: boolean;
	};
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	isStreaming: boolean;
	isCompacting: boolean;
	/** 本地跟踪：RPC get_state 无此字段 */
	isPromptRunning: boolean;
	/** 本地跟踪：RPC get_state 无此字段 */
	isBashRunning: boolean;
	autoCompactionEnabled?: boolean;
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	thinkingLevel: string;
	model?: RpcModelRef;
	messageCount: number;
	pendingMessageCount: number;
	/**
	 * 仅当调用方提供 queue_update 本地跟踪时附带。
	 * 不从 get_state 伪造空队列（否则会在重连时抹掉真实队列 UI）。
	 */
	queuedMessages?: QueuedMessagesSnapshot;
	/**
	 * 仅当 get_session_stats 返回 contextUsage 时附带；缺省则字段不存在（未知）。
	 * 禁止写成 null 冒充「0%」。
	 */
	contextUsage?: ContextUsageSnapshot;
	/** 扩展 UI 本地快照（非 RPC get_state） */
	extensionStatuses: Array<{ key: string; text: string }>;
	extensionWidgets: Array<{ key: string; content: unknown }>;
	pendingExtensionRequests: unknown[];
};

export type ProjectRpcStateInput = {
	rpc: Record<string, unknown>;
	/** 会话 id / 文件回退 */
	fallbackSessionId: string;
	fallbackSessionFile?: string;
	/** 本地运行标志 */
	isPromptRunning: boolean;
	isBashRunning: boolean;
	localStreaming?: boolean;
	localCompacting?: boolean;
	/** queue_update 跟踪；undefined = 不附带 queuedMessages */
	localQueue?: QueuedMessagesSnapshot;
	extensionStatuses: Array<{ key: string; text: string }>;
	extensionWidgets: Array<{ key: string; content: unknown }>;
	pendingExtensionRequests: unknown[];
	/** get_session_stats 原始结果（可选） */
	sessionStats?: Record<string, unknown> | null;
};

function asFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function projectModel(raw: unknown): RpcModelRef | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const m = raw as { id?: unknown; provider?: unknown };
	if (typeof m.id === "string" && m.id && typeof m.provider === "string" && m.provider) {
		return { id: m.id, provider: m.provider };
	}
	return undefined;
}

function projectContextUsage(stats: Record<string, unknown> | null | undefined): ContextUsageSnapshot | undefined {
	if (!stats || typeof stats !== "object") return undefined;
	const raw = stats.contextUsage;
	if (!raw || typeof raw !== "object") return undefined;
	const u = raw as Record<string, unknown>;
	const contextWindow = asFiniteNumber(u.contextWindow);
	if (contextWindow === null || contextWindow <= 0) return undefined;
	return {
		contextWindow,
		percent: asFiniteNumber(u.percent),
		tokens: asFiniteNumber(u.tokens),
	};
}

/**
 * 投影 get_state。不输出 systemPrompt / autoRetryEnabled 等 RPC 未提供字段。
 */
export function projectRpcAgentState(input: ProjectRpcStateInput): ProjectedAgentState {
	const { rpc } = input;
	// 防止调用方误把整包 legacy 字段当权威：只读白名单键
	void PI_RPC_GET_STATE_FIELDS;

	const sessionId =
		typeof rpc.sessionId === "string" && rpc.sessionId
			? rpc.sessionId
			: input.fallbackSessionId;
	const sessionFile =
		typeof rpc.sessionFile === "string" && rpc.sessionFile
			? rpc.sessionFile
			: input.fallbackSessionFile;

	const thinkingLevel =
		typeof rpc.thinkingLevel === "string" && rpc.thinkingLevel
			? rpc.thinkingLevel
			: "off";

	const projected: ProjectedAgentState = {
		stateSources: {
			rpcGetState: true,
			sessionStats: Boolean(input.sessionStats),
			localQueue: input.localQueue !== undefined,
			localExtensionUi: true,
		},
		sessionId,
		sessionFile,
		sessionName: typeof rpc.sessionName === "string" ? rpc.sessionName : undefined,
		isStreaming: rpc.isStreaming === true || input.localStreaming === true,
		isCompacting: rpc.isCompacting === true || input.localCompacting === true,
		isPromptRunning: input.isPromptRunning,
		isBashRunning: input.isBashRunning,
		autoCompactionEnabled:
			typeof rpc.autoCompactionEnabled === "boolean" ? rpc.autoCompactionEnabled : undefined,
		steeringMode:
			rpc.steeringMode === "all" || rpc.steeringMode === "one-at-a-time"
				? rpc.steeringMode
				: undefined,
		followUpMode:
			rpc.followUpMode === "all" || rpc.followUpMode === "one-at-a-time"
				? rpc.followUpMode
				: undefined,
		thinkingLevel,
		model: projectModel(rpc.model),
		messageCount: asFiniteNumber(rpc.messageCount) ?? 0,
		pendingMessageCount: asFiniteNumber(rpc.pendingMessageCount) ?? 0,
		extensionStatuses: input.extensionStatuses,
		extensionWidgets: input.extensionWidgets,
		pendingExtensionRequests: input.pendingExtensionRequests,
	};

	if (input.localQueue) {
		projected.queuedMessages = {
			steering: [...input.localQueue.steering],
			followUp: [...input.localQueue.followUp],
		};
	}

	const usage = projectContextUsage(input.sessionStats ?? undefined);
	if (usage) projected.contextUsage = usage;

	return projected;
}
