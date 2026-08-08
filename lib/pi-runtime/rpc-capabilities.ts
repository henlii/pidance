/**
 * Pi 0.83 RPC 能力矩阵（以官方 rpc-mode / rpc-types 为准）。
 *
 * 用途：
 * - 产品命令路由：公开 RPC vs Pidance 本地产品命令 vs 明确不支持
 * - 禁止对未知命令伪造成功
 * - 测试固定当前基线，升级 runtime 时先改本表
 */

/** Pi 0.83 公开 stdin 命令（extension_ui_response 为特殊入站类型，不在此列） */
export const PI_RPC_COMMANDS_0_83 = [
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"new_session",
	"get_state",
	"set_model",
	"cycle_model",
	"get_available_models",
	"set_thinking_level",
	"cycle_thinking_level",
	"get_available_thinking_levels",
	"set_steering_mode",
	"set_follow_up_mode",
	"compact",
	"set_auto_compaction",
	"set_auto_retry",
	"abort_retry",
	"bash",
	"abort_bash",
	"get_session_stats",
	"export_html",
	"switch_session",
	"fork",
	"clone",
	"get_fork_messages",
	"get_entries",
	"get_tree",
	"get_last_assistant_text",
	"set_session_name",
	"get_messages",
	"get_commands",
] as const;

export type PiRpcCommandName = (typeof PI_RPC_COMMANDS_0_83)[number];

const PI_RPC_COMMAND_SET = new Set<string>(PI_RPC_COMMANDS_0_83);

/** 既无公开 RPC、也不提供本地等价实现的命令（必须返回 unsupported，不得伪造成功） */
export const UNSUPPORTED_RPC_COMMANDS = [
	"clear_queue",
	"set_active_tools",
	"abort_compaction",
	"extension_ui_input",
	"flush_queue_as_steer",
] as const;

export type UnsupportedRpcCommandName = (typeof UNSUPPORTED_RPC_COMMANDS)[number];

const UNSUPPORTED_SET = new Set<string>(UNSUPPORTED_RPC_COMMANDS);

/**
 * Pidance 产品命令：不走 Pi 公开 RPC，由 ExternalRpcSession 本地实现
 *（quiesce + 磁盘 / 重启进程等）。
 */
export const PIDANCE_PRODUCT_COMMANDS = [
	"fork", // 一期仍可走磁盘 fork；Pi 也有 fork，后续可切 RPC
	"navigate_tree",
	"select_leaf_exact",
	"branch_from_assistant",
	"create_session_from_leaf",
	"set_branch_label",
	"reload",
	"append_activity",
	"set_tools", // 本地记录 + 重启 spawn
	"get_tools", // 返回启动配置，非 runtime 权威
] as const;

/** Pi 0.83 get_state 真实字段（RpcSessionState） */
export const PI_RPC_GET_STATE_FIELDS = [
	"model",
	"thinkingLevel",
	"isStreaming",
	"isCompacting",
	"steeringMode",
	"followUpMode",
	"sessionFile",
	"sessionId",
	"sessionName",
	"autoCompactionEnabled",
	"messageCount",
	"pendingMessageCount",
] as const;

/** 旧 SDK get_state 字段：不得再从空值伪造为权威 */
export const LEGACY_FAKE_STATE_FIELDS = [
	"contextUsage",
	"systemPrompt",
	"queuedMessages",
	"autoRetryEnabled",
	"isBashRunning",
] as const;

export type UnsupportedCommandResult = {
	unsupported: true;
	command: string;
	reason: string;
};

export function isPiRpcCommand(type: string): type is PiRpcCommandName {
	return PI_RPC_COMMAND_SET.has(type);
}

export function isUnsupportedRpcCommand(type: string): type is UnsupportedRpcCommandName {
	return UNSUPPORTED_SET.has(type);
}

export function unsupportedCommand(
	command: string,
	reason?: string,
): UnsupportedCommandResult {
	return {
		unsupported: true,
		command,
		reason:
			reason ??
			`Pi RPC 不支持命令 ${command}（当前矩阵基线 0.83；不得伪造成功）`,
	};
}

export function isUnsupportedResult(value: unknown): value is UnsupportedCommandResult {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as UnsupportedCommandResult).unsupported === true &&
		typeof (value as UnsupportedCommandResult).command === "string"
	);
}
