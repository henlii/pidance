/**
 * 轮末（turnEnd）计算纯函数：用于「基于此回答分支 / 基于此回答开始新会话」的锚点。
 *
 * 语义（Oracle 审核定稿，选项 B）：
 *   在所选 assistant 所在的当前分支路径上，从该 assistant 开始向后扫描，
 *   直到下一条 role === "user" 之前；该范围内最后一条 session entry 为 turnEnd。
 *   若无后继，turnEnd = selectedAssistant。
 *
 * turnEnd 必然为非 user entry（toolResult / assistant / custom_message /
 * compaction / model_change 等），因此 `navigate_tree(turnEnd)` 在 Pi 中
 * 走「精确设 leaf」语义（user 目标才会退到 parent）。
 */
/** 最小 entry 形状（不依赖 pi npm） */
export type TurnEndEntry = {
	id: string;
	type?: string;
	message?: { role?: string };
};

/**
 * 计算轮末 entry id。
 *
 * @param path root→leaf 顺序的当前分支路径
 * @param selectedAssistantId 被点击的 assistant entry id（必须在 path 上）
 * @returns turnEnd entry id；selectedAssistantId 不在 path 上时返回原值（调用方应自行校验）
 */
export function computeTurnEnd(
	path: readonly TurnEndEntry[],
	selectedAssistantId: string,
): string {
	const idx = path.findIndex((entry) => entry.id === selectedAssistantId);
	if (idx === -1) return selectedAssistantId;

	let turnEnd = selectedAssistantId;
	for (let i = idx + 1; i < path.length; i += 1) {
		const entry = path[i];
		// 下一条 user 消息 = 新一轮开始，停止扫描
		if (entry.type === "message" && entry.message?.role === "user") break;
		turnEnd = entry.id;
	}
	return turnEnd;
}

/** 判断 entry 是否为 user 消息（供调用方前置校验「assistant 锚点」）。 */
export function isUserMessageEntry(entry: TurnEndEntry): boolean {
	return entry.type === "message" && entry.message?.role === "user";
}

/** 判断 entry 是否为 assistant 消息。 */
export function isAssistantMessageEntry(entry: TurnEndEntry): boolean {
	return entry.type === "message" && entry.message?.role === "assistant";
}
