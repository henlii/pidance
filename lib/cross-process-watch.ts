/**
 * 跨进程变更通知：让 31415 / 31416 两个实例互相看见对方的动作。
 *
 * 两条通道：
 * 1. **运行租约**（`~/.pi/agent/pidance-running-leases`）：对端开始/结束执行某个会话时，
 *    本进程要把「该会话被对端占用」推给浏览器 —— 不能等用户下次打开会话才亮锁定条。
 * 2. **会话目录**（`~/.pi/agent/sessions`）：对端新建/删除会话时，本进程的列表缓存
 *    要失效并通知浏览器重取，否则要刷新页面才看得见。改名是同路径追加、本帧不推
 *    （见 `sessionsFingerprint` 的说明），等下次拉列表时生效。
 *
 * 机制是 `fs.watch`（Linux 走 inotify，事件驱动，不是轮询）**加** 2 秒兜底对账：
 * inotify 在网络盘、容器挂载、超出 watch 上限时会静默失效，兜底保证最终一致。
 * 对账只做目录列举与 stat（与一次列表刷新同级），不解析 JSONL。
 *
 * 为什么不直接 2 秒轮询了事：租约目录的增减是低频事件，inotify 能在对端真正开始执行
 * 的同一时刻推给浏览器；轮询则平均要多等 1 秒、最坏 2 秒。两条通道都在，事件优先、
 * 轮询兜底。
 */
import { readdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./pi-paths";
import { scanSessionFiles } from "./session-metadata-cache";
import { RUNNING_LEASE_DIRNAME, isRunningLeaseActivelyRunningByOther } from "./session-running-lease";
import { SESSION_STATE_DIRNAME, SESSION_STATE_POLL_MS, listSignaledSessionIds, signaledSessionsFingerprint } from "./session-state-signal";

/** 锁状态兜底对账间隔：用户要的「2 秒一轮询」下限（对端开始/结束执行最多迟 2 秒可见）。 */
export const LOCK_POLL_MS = 2_000;
/**
 * 会话目录兜底对账间隔。比锁宽松：目录扫描要 stat 每个会话文件，而 fs.watch 已经把
 * 新建/删除压到即时；5 秒只是 inotify 失效时的兜底。
 */
export const SESSION_POLL_MS = 5_000;
/** fs.watch 事件风暴（一次 append 会触发多次回调）合并窗口。 */
const EVENT_DEBOUNCE_MS = 50;

export type CrossProcessEvent =
	/** 对端进程当前持有写租约的会话 id（已排序、不含本进程）。 */
	| { type: "locks"; lockedSessionIds: string[] }
	/** 会话目录发生了增删改：列表缓存已失效，前端应重取。 */
	| { type: "sessions-changed" }
	/**
	 * 某个实例刚改写了这些会话的状态（思考档位 / 模型）。
	 *
	 * 与 `sessions-changed` 分开：那个是「列表变了」，这个是「同一个会话的权威值变了」，
	 * 消费方要按 id 重新对齐（而不是重取整份列表）。空数组表示没有信号。
	 */
	| { type: "session-state"; sessionIds: string[] };

type Listener = (event: CrossProcessEvent) => void;

interface WatchState {
	listeners: Set<Listener>;
	lockTimer: ReturnType<typeof setInterval> | null;
	sessionTimer: ReturnType<typeof setInterval> | null;
	debounce: ReturnType<typeof setTimeout> | null;
	leaseWatcher: FSWatcher | null;
	/** 状态信号目录的 watch（空闲会话被其他实例改了档位/模型时对齐）。 */
	stateWatcher: FSWatcher | null;
	stateTimer: ReturnType<typeof setInterval> | null;
	stateKey: string;
	/** 会话目录的 watch：根 + 每个项目子目录各一个（非递归）。 */
	sessionWatchers: Map<string, FSWatcher>;
	/** 上一次对账结果（变化才通知）。 */
	lockedKey: string;
	sessionsKey: string;
	agentDir: string;
	sessionsRoot: string;
	/** 首次对账只建基线，不广播。 */
	primed: boolean;
}

declare global {
	var __piCrossProcessWatch: WatchState | undefined;
}

function state(): WatchState {
	if (!globalThis.__piCrossProcessWatch) {
		const agentDir = getAgentDir();
		globalThis.__piCrossProcessWatch = {
			listeners: new Set(),
			lockTimer: null,
			sessionTimer: null,
			debounce: null,
			leaseWatcher: null,
			stateWatcher: null,
			stateTimer: null,
			stateKey: "", 
			sessionWatchers: new Map(),
			lockedKey: "",
			sessionsKey: "",
			agentDir,
			sessionsRoot: join(agentDir, "sessions"),
			primed: false,
		};
	}
	return globalThis.__piCrossProcessWatch;
}

/**
 * 对端持有写租约的会话 id（排序后返回，便于比对）。
 *
 * 判据是 `isRunningLeaseActivelyRunningByOther`（对端进程活着**且在跑**），不是「心跳新鲜」：
 * 对端事件循环卡住/SIGSTOP 超过租约 TTL 时心跳会过期，但它仍然是 writer，
 * `acquireRunningLease` 也仍然拒绝本进程。用新鲜度当占用集会让锁定条与输入框
 * 反复撒谎（推空锁集 → 收起锁定条 → 下一帧又变回锁定）。
 */
export function listSessionsLockedByOther(
	agentDir: string = getAgentDir(),
): string[] {
	let names: string[] = [];
	try {
		names = readdirSync(join(agentDir, RUNNING_LEASE_DIRNAME));
	} catch {
		return []; // 目录不存在 = 没有任何租约
	}
	const ids: string[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const sessionId = name.slice(0, -".json".length);
		if (isRunningLeaseActivelyRunningByOther(sessionId, agentDir)) ids.push(sessionId);
	}
	return ids.sort();
}

/** 会话根下的项目子目录（每个项目一个；用于补挂非递归 watch）。 */
function listProjectDirs(sessionsRoot: string): string[] {
	try {
		return readdirSync(sessionsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(sessionsRoot, entry.name));
	} catch {
		return [];
	}
}

/** 会话目录的变更指纹：路径 + mtime + size（不解析内容）。 */
async function sessionsFingerprint(): Promise<string> {
	const files = await scanSessionFiles(state().sessionsRoot);
	// 只比对「有哪些会话文件」。带上 mtime/size 会让正在跑的会话每轮都算变化 ——
	// 另一个实例就会每 2 秒重取一次整份列表（实测 12 秒刷了 236 帧），而用户要的是
	// 「对端新建/删除会话时列表跟着变」。内容追加与本进程自己的 run 走各自的路径。
	//
	// 代价（已知）：**改名**（追加 session_info，路径不变）不会触发本帧；侧栏在下次拉列表时
	// 会看到新名字。子代理/fork 会话在 `<父文件>/run-N/` 下，不在这个集合里。
	return files.map((f) => f.path).sort().join("\n");
}

function emit(event: CrossProcessEvent): void {
	for (const listener of [...state().listeners]) {
		try {
			listener(event);
		} catch {
			// 单个订阅者出错不影响其它订阅者（与 app-events-stream 同口径）
		}
	}
}

/** 对账锁集：只在变化时广播。 */
function reconcileLocks(): void {
	const s = state();
	const locked = listSessionsLockedByOther(s.agentDir);
	const lockedKey = locked.join(",");
	if (!s.primed) {
		s.lockedKey = lockedKey;
		return;
	}
	if (lockedKey === s.lockedKey) return;
	s.lockedKey = lockedKey;
	emit({ type: "locks", lockedSessionIds: locked });
}

/** 对账会话目录：只在「有哪些会话文件」变化时广播。 */
async function reconcileSessions(): Promise<void> {
	const s = state();
	let key = "";
	try {
		key = await sessionsFingerprint();
	} catch {
		return; // 目录暂时不可读：保持上次指纹，下轮再试
	}
	if (!s.primed) {
		s.sessionsKey = key;
		return;
	}
	if (key === s.sessionsKey) return;
	s.sessionsKey = key;
	attachWatchers(); // 新项目目录补挂 watch（幂等）
	emit({ type: "sessions-changed" });
}

/**
 * 对账状态信号：只在「被标记过的会话集合」变化时广播。
 *
 * 信号文件由改写方（host 处理 set_thinking_level / set_model 成功后）主动写出，
 * fs.watch 立刻可见；这里同时是 2 秒兜底探针的落点（inotify 失效时仍能收敛）。
 */
function reconcileSessionState(): void {
	const s = state();
	const ids = listSignaledSessionIds(s.agentDir);
	// 指纹带 mtime：同一会话再次改档位时集合不变，只看集合会漏掉。
	const key = signaledSessionsFingerprint(s.agentDir);
	if (!s.primed) {
		s.stateKey = key;
		return;
	}
	if (key === s.stateKey) return;
	s.stateKey = key;
	emit({ type: "session-state", sessionIds: ids });
}

/** 建基线：首次对账只记录当前状态，不广播（避免服务刚起来就推一屏）。 */
async function reconcile(): Promise<void> {
	const s = state();
	if (s.primed) {
		reconcileLocks();
		reconcileSessionState();
		await reconcileSessions();
		return;
	}
	s.lockedKey = listSessionsLockedByOther(s.agentDir).join(",");
	s.stateKey = signaledSessionsFingerprint(s.agentDir);
	try {
		s.sessionsKey = await sessionsFingerprint();
	} catch {
		s.sessionsKey = "";
	}
	s.primed = true;
}

/** 事件触发时的防抖对账（一次写入常常触发多条事件）。 */
function scheduleReconcile(): void {
	const s = state();
	if (s.debounce) return;
	s.debounce = setTimeout(() => {
		s.debounce = null;
		if (s.primed) {
			reconcileLocks();
			reconcileSessionState();
			void reconcileSessions();
		}
	}, EVENT_DEBOUNCE_MS);
}

function attachWatchers(): void {
	const s = state();
	if (!s.leaseWatcher) {
		try {
			const leaseWatcher = watch(join(s.agentDir, RUNNING_LEASE_DIRNAME), { persistent: false }, scheduleReconcile);
			leaseWatcher.on("error", () => {
				try { leaseWatcher.close(); } catch { /* 已关闭 */ }
				s.leaseWatcher = null;
			});
			s.leaseWatcher = leaseWatcher;
		} catch {
			// 目录还不存在（本进程还没跑过任何会话）：兜底轮询会覆盖，下次订阅时再试
			s.leaseWatcher = null;
		}
	}
	if (!s.stateWatcher) {
		try {
			const stateWatcher = watch(join(s.agentDir, SESSION_STATE_DIRNAME), { persistent: false }, scheduleReconcile);
			stateWatcher.on("error", () => {
				try { stateWatcher.close(); } catch { /* 已关闭 */ }
				s.stateWatcher = null;
			});
			s.stateWatcher = stateWatcher;
		} catch {
			// 目录还不存在（还没有任何实例改过档位/模型）：兜底探针会覆盖
			s.stateWatcher = null;
		}
	}
	// 不使用 `recursive: true`：Node 在 Linux 上把它实现成「每个文件一个 watch」，
	// 会话目录下文件数上千，两个进程各挂一套会逼近 inotify 上限；而且初始 ENOSPC 时
	// 它只覆盖到失败点、不报错。改为「根目录 + 每个项目子目录」各一个非递归 watch，
	// 数量等于项目数（几十）。新增项目目录由下一轮对账补挂。
	for (const dir of [s.sessionsRoot, ...listProjectDirs(s.sessionsRoot)]) {
		if (s.sessionWatchers.has(dir)) continue;
		try {
			const watcher = watch(dir, { persistent: false }, scheduleReconcile);
			watcher.on("error", () => {
				// error 后必须 close：不 close 的 watcher 对象会拴住 native handle 直到进程退出。
				try { watcher.close(); } catch { /* 已关闭 */ }
				s.sessionWatchers.delete(dir);
			});
			s.sessionWatchers.set(dir, watcher);
		} catch {
			// 目录不可读/刚被删：跳过，下一轮对账再试
		}
	}
}

/**
 * 订阅跨进程变更。首个订阅者启动 watch + 兜底定时器，最后一个退订时全部关掉。
 * 返回退订函数。
 */
export function subscribeCrossProcessEvents(listener: Listener): () => void {
	const s = state();
	s.listeners.add(listener);
	if (s.listeners.size === 1) {
		attachWatchers();
		const lockTimer = setInterval(() => { void reconcileLocks(); }, LOCK_POLL_MS);
		lockTimer.unref?.(); // 定时器不阻止进程退出
		s.lockTimer = lockTimer;
		const sessionTimer = setInterval(() => { void reconcileSessions(); }, SESSION_POLL_MS);
		sessionTimer.unref?.();
		s.sessionTimer = sessionTimer;
		// 状态信号兜底：fs.watch 失效时，其他实例的档位/模型改动最迟 2s 被察觉。
		const stateTimer = setInterval(() => { reconcileSessionState(); }, SESSION_STATE_POLL_MS);
		stateTimer.unref?.();
		s.stateTimer = stateTimer;
		void reconcile(); // 建基线（首次不广播）
	}
	return () => {
		s.listeners.delete(listener);
		if (s.listeners.size > 0) return;
		stopCrossProcessWatch();
	};
}

/** 停止 watch 与定时器（测试/收尾）。订阅者集合保留，下次订阅重建。 */
export function stopCrossProcessWatch(): void {
	const s = state();
	if (s.lockTimer) {
		clearInterval(s.lockTimer);
		s.lockTimer = null;
	}
	if (s.sessionTimer) {
		clearInterval(s.sessionTimer);
		s.sessionTimer = null;
	}
	if (s.stateTimer) {
		clearInterval(s.stateTimer);
		s.stateTimer = null;
	}
	if (s.stateWatcher) {
		try { s.stateWatcher.close(); } catch { /* 已关闭 */ }
		s.stateWatcher = null;
	}
	if (s.debounce) {
		clearTimeout(s.debounce);
		s.debounce = null;
	}
	s.leaseWatcher?.close();
	s.leaseWatcher = null;
	for (const watcher of s.sessionWatchers.values()) {
		try { watcher.close(); } catch { /* 已关闭 */ }
	}
	s.sessionWatchers.clear();
	s.primed = false;
}

/** 测试用：清掉单例，避免用例之间互相影响。 */
export function resetCrossProcessWatchForTests(): void {
	stopCrossProcessWatch();
	globalThis.__piCrossProcessWatch = undefined;
}
