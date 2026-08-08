/**
 * 会话列表元数据的持久化磁盘缓存。
 *
 * 背景：会话列表全量扫描（SDK listAll 逐行解析全部 .jsonl + 逐 parent
 * 做 subagent 发现）在会话文件多/大时耗 2~7s，而 /api/sessions、文件
 * allow-list、会话路径解析等大量路由都会触发它。本模块把扫描结果按
 * (path, mtimeMs, size) 键控缓存到 ~/.pi/agent/pidance-session-cache.json，
 * 只有变更/新增/删除的文件才重新解析，冷扫成本从 O(全部字节) 降为
 * O(文件数 stat + 小缓存文件读)。
 *
 * 语义对齐 OpenChamber 的 persist-cache.ts（localStorage SWR 元数据缓存）：
 * 缓存只存列表元数据，会话正文永远以磁盘为准；mtime/size 失配即失效，
 * 缓存文件损坏则整体忽略并重建。
 */
import { createInterface } from "readline";
import { createReadStream } from "fs";
import { readdir, stat } from "fs/promises";
import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { join } from "path";
import { getAgentDir } from "./pi-paths";

export interface CachedSessionInfo {
	id: string;
	cwd: string;
	name?: string;
	/** ISO 字符串（header.timestamp） */
	created: string;
	/** ISO 字符串（最后消息活动时间，回退 header.timestamp / mtime） */
	modified: string;
	messageCount: number;
	firstMessage: string;
	parentSessionPath?: string;
}

/** 与 DiscoveredSubagent 同构的扁平缓存形状（header 字段直接提取） */
export interface CachedDiscoveredChild {
	path: string;
	id: string;
	cwd: string;
	timestamp: string;
	parentSessionId: string;
	runId: string;
	runIndex: number;
	agent?: string;
}

/** 顶层会话文件快照（stat 结果） */
export interface SessionFileStat {
	path: string;
	mtimeMs: number;
	size: number;
}

interface SessionCacheRecord {
	m: number;
	s: number;
	i: CachedSessionInfo;
}

interface DiscoveryCacheRecord {
	m: number;
	s: number;
	c: CachedDiscoveredChild[];
}

interface SessionFileHeader {
	type?: unknown;
	id?: unknown;
	cwd?: unknown;
	timestamp?: unknown;
	parentSession?: unknown;
}

interface SessionMetadataCacheFile {
	version: 1;
	sessions: Record<string, SessionCacheRecord>;
	discovery: Record<string, DiscoveryCacheRecord>;
}

const CACHE_VERSION = 1 as const;
const CACHE_FILE_NAME = "pidance-session-cache.json";
/** 缓存写防抖：批量变更只落盘一次 */
const SAVE_DEBOUNCE_MS = 1_500;
/** 顶层扫描的并发上限（每次只 stat + 读缓存，不解析） */
const SCAN_CONCURRENCY = 16;

function cacheFilePath(): string {
	return join(getAgentDir(), CACHE_FILE_NAME);
}

// ---------------------------------------------------------------------------
// 顶层扫描：列出 sessions 根下所有 *.jsonl + stat（不读内容）
// ---------------------------------------------------------------------------

async function statSafe(p: string): Promise<SessionFileStat | null> {
	try {
		const st = await stat(p);
		return { path: p, mtimeMs: st.mtimeMs, size: st.size };
	} catch {
		return null;
	}
}

export async function scanSessionFiles(
	sessionRoot = join(getAgentDir(), "sessions"),
): Promise<SessionFileStat[]> {
	let dirs: string[] = [];
	try {
		const entries = await readdir(sessionRoot, { withFileTypes: true });
		dirs = entries
			.filter((e) => e.isDirectory())
			.map((e) => join(sessionRoot, e.name));
	} catch {
		return [];
	}
	const files: string[] = [];
	const readPromises: Promise<void>[] = [];
	for (const dir of dirs) {
		readPromises.push(
			(async () => {
				try {
					const names = await readdir(dir);
					for (const name of names) {
						if (name.endsWith(".jsonl")) files.push(join(dir, name));
					}
				} catch {
					// 目录不可读/已删除：跳过
				}
			})(),
		);
	}
	await Promise.all(readPromises);
	const results = await Promise.all(files.map((f) => statSafe(f)));
	return results.filter((r): r is SessionFileStat => r !== null);
}

// ---------------------------------------------------------------------------
// 缓存文件读写（原子写 + 防抖 + 损坏降级）
// ---------------------------------------------------------------------------

export function loadSessionMetadataCache(
	filePath: string = cacheFilePath(),
): SessionMetadataCacheFile | null {
	try {
		const raw = readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw) as SessionMetadataCacheFile;
		if (!parsed || parsed.version !== CACHE_VERSION) return null;
		if (!parsed.sessions || typeof parsed.sessions !== "object") return null;
		return {
			version: CACHE_VERSION,
			sessions: parsed.sessions,
			discovery:
				parsed.discovery && typeof parsed.discovery === "object"
					? parsed.discovery
					: {},
		};
	} catch {
		return null;
	}
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pendingDirty = false;

/**
 * 防抖 + 原子写。sessions/discovery 为本次扫描后的完整 Map，直接序列化。
 * 多实例（31415/31416）共享 agentDir：原子 rename 保证文件永不完全写坏，
 * 内容由磁盘状态唯一决定，最后写入者胜出无害。
 */
export function scheduleSessionMetadataCacheSave(
	sessions: Map<string, SessionCacheRecord>,
	discovery: Map<string, DiscoveryCacheRecord>,
	filePath: string = cacheFilePath(),
): void {
	pendingDirty = true;
	if (saveTimer) return;
	saveTimer = setTimeout(() => {
		saveTimer = undefined;
		if (!pendingDirty) return;
		pendingDirty = false;
		const payload: SessionMetadataCacheFile = {
			version: CACHE_VERSION,
			sessions: Object.fromEntries(sessions),
			discovery: Object.fromEntries(discovery),
		};
		const tmp = `${filePath}.tmp`;
		try {
			writeFileSync(tmp, JSON.stringify(payload), "utf8");
			renameSync(tmp, filePath);
		} catch {
			try {
				// 半写清理；失败则忽略（下次扫描重建）
				if (existsSync(tmp)) renameSync(tmp, filePath);
			} catch {
				// ignore
			}
		}
	}, SAVE_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// 单文件轻量扫描：只提取列表元数据（不保留消息全文，避免 SDK listAll 的
// allMessagesText 内存开销）。readline 流式，不阻塞事件循环。
// ---------------------------------------------------------------------------

function extractTextContent(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } =>
			Boolean(block && block.type === "text" && typeof block.text === "string"),
		)
		.map((block) => block.text)
		.join(" ");
}

function isMessageWithContent(
	message: unknown,
): message is { role?: unknown; content?: unknown; timestamp?: unknown } {
	return (
		typeof message === "object" &&
		message !== null &&
		typeof (message as { role?: unknown }).role === "string" &&
		"content" in (message as object)
	);
}

function getMessageActivityTime(entry: {
	message?: unknown;
	timestamp?: string;
}): number | undefined {
	const message = entry.message;
	if (!isMessageWithContent(message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const msgTimestamp = message.timestamp;
	if (typeof msgTimestamp === "number") return msgTimestamp;
	const t = new Date(entry.timestamp ?? "").getTime();
	return Number.isNaN(t) ? undefined : t;
}

/**
 * 与 SDK buildSessionInfo 字段语义一致的轻量实现，但：
 * - 不保留 allMessagesText（Pidance 列表不消费）；
 * - 流式逐行，不整文件进内存（12MB 会话也 OK）。
 * 返回 null 表示文件不是合法会话（无 header 或 header 类型错误）。
 */
export async function scanSessionFileFast(
	filePath: string,
	st: { mtimeMs: number; size: number },
): Promise<CachedSessionInfo | null> {
	try {
		const rl = createInterface({
			input: createReadStream(filePath, { encoding: "utf8" }),
			crlfDelay: Infinity,
		});
		let header: SessionFileHeader | null = null;
		let messageCount = 0;
		let name: string | undefined;
		let lastActivityTime: number | undefined;
		let firstMessage = "";
		for await (const line of rl) {
			if (!line.trim()) continue;
			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue; // 半写行安全跳过
			}
			if (!header) {
				if (entry.type !== "session") return null;
				header = entry as unknown as SessionFileHeader;
				continue;
			}
			if (entry.type === "session_info") {
				const infoName = (entry as { name?: unknown }).name;
				if (typeof infoName === "string" && infoName.trim())
					name = infoName.trim();
				continue;
			}
			if (entry.type !== "message") continue;
			messageCount++;
			const activityTime = getMessageActivityTime(
				entry as { message?: unknown; timestamp?: string },
			);
			if (typeof activityTime === "number") {
				lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
			}
			const message = (entry as { message?: unknown }).message;
			if (!isMessageWithContent(message)) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;
			const textContent = extractTextContent(message);
			if (!textContent) continue;
			if (!firstMessage && message.role === "user") {
				firstMessage = textContent;
			}
		}
		if (!header) return null;
		const headerTime =
			typeof header.timestamp === "string"
				? new Date(header.timestamp).getTime()
				: NaN;
		const modified =
			typeof lastActivityTime === "number" && lastActivityTime > 0
				? new Date(lastActivityTime)
				: !Number.isNaN(headerTime)
					? new Date(headerTime)
					: new Date(st.mtimeMs);
		return {
			id: typeof header.id === "string" ? header.id : "",
			cwd: typeof header.cwd === "string" ? header.cwd : "",
			name,
			created: header.timestamp as string,
			modified: modified.toISOString(),
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			parentSessionPath:
				typeof header.parentSession === "string"
					? header.parentSession
					: undefined,
		};
	} catch {
		return null;
	}
}

export async function scanSessionFilesWithConcurrency(
	files: string[],
	concurrency = SCAN_CONCURRENCY,
): Promise<SessionFileStat[]> {
	const results: SessionFileStat[] = [];
	let index = 0;
	async function worker(): Promise<void> {
		for (;;) {
			const i = index++;
			if (i >= files.length) return;
			const st = await statSafe(files[i]);
			if (st) results.push(st);
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(concurrency, files.length) }, () => worker()),
	);
	return results;
}

export type { SessionCacheRecord, DiscoveryCacheRecord };
