/**
 * 文件编辑器的查找 / 替换（纯逻辑，无 React、无 IO，node:test 直接测）。
 *
 * 为什么单独一个模块：匹配范围、空查询、大小写、以及「替换串里又含查询串」这几个边界都容易
 * 写错，而且错了会静默改坏文件内容。组件里只留接线、焦点与选区，规则全在这里。
 */

/** 一处匹配（`content.slice(start, end)` 就是命中的文本）。 */
export interface FindMatch {
	start: number;
	end: number;
}

export interface FindOptions {
	/** 默认不区分大小写。 */
	caseSensitive?: boolean;
}

/**
 * 找出全部**不重叠**的匹配。
 *
 * 空查询返回空数组：空串在任意两个字符之间都「匹配」，全选中没有意义。
 * 不做 lower 化整串再用 indexOf —— 某些字符小写化后长度会变（例如 İ），索引会整体错位；
 * 这里逐位置比较，索引永远对着原文。
 */
export function findMatches(content: string, query: string, options: FindOptions = {}): FindMatch[] {
	const matches: FindMatch[] = [];
	if (query === "") return matches;
	const caseSensitive = options.caseSensitive === true;
	const needle = caseSensitive ? query : query.toLowerCase();
	const limit = content.length - query.length;
	for (let index = 0; index <= limit; index += 1) {
		const candidate = caseSensitive
			? content.slice(index, index + query.length)
			: content.slice(index, index + query.length).toLowerCase();
		if (candidate !== needle) continue;
		matches.push({ start: index, end: index + query.length });
		index += query.length - 1; // 不重叠：跳过这一处
	}
	return matches;
}

/** 替换一处匹配；范围越界（内容已经变了）就原样返回。 */
export function replaceMatch(content: string, match: FindMatch, replacement: string): string {
	if (match.start < 0 || match.end > content.length || match.end < match.start) return content;
	return `${content.slice(0, match.start)}${replacement}${content.slice(match.end)}`;
}

/**
 * 全部替换：一遍扫描边扫边拼，**不会**把替换串里新出现的查询串再替换一遍
 * （否则把 "a" 换成 "aa" 会无限长）。
 */
export function replaceAllMatches(
	content: string,
	query: string,
	replacement: string,
	options: FindOptions = {},
): { content: string; count: number } {
	if (query === "") return { content, count: 0 };
	const caseSensitive = options.caseSensitive === true;
	const needle = caseSensitive ? query : query.toLowerCase();
	let result = "";
	let cursor = 0;
	let count = 0;
	const limit = content.length - query.length;
	for (let index = 0; index <= limit; index += 1) {
		const candidate = caseSensitive
			? content.slice(index, index + query.length)
			: content.slice(index, index + query.length).toLowerCase();
		if (candidate !== needle) continue;
		result += content.slice(cursor, index) + replacement;
		cursor = index + query.length;
		count += 1;
		index = cursor - 1;
	}
	if (count === 0) return { content, count: 0 };
	return { content: result + content.slice(cursor), count };
}

/**
 * 下一个 / 上一个匹配的下标（环形）。`current` 是当前下标（-1 = 还没定位过）。
 * 没有匹配返回 -1。方向 -1 且还没定位过时从最后一个开始。
 */
export function stepMatchIndex(current: number, total: number, direction: 1 | -1): number {
	if (total <= 0) return -1;
	if (current < 0 || current >= total) return direction === 1 ? 0 : total - 1;
	return (current + direction + total) % total;
}
