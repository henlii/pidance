import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./pi-paths";

/**
 * 会话「状态已被某个实例改写」的跨进程信号。
 *
 * 场景：会话空闲时，A 实例改了思考档位/模型 —— 它写的是磁盘（文件权威）。
 * B 实例的页面还停在旧值上，它甚至可能有一个内存态陈旧的 live host。
 * 这里给写入方一个**主动通知**的手段：改完落盘后写一个信号文件，
 * 其他实例通过 fs.watch（+ 兜底探针）感知，然后重新对齐。
 *
 * 为什么不做成「谁改谁广播」的直连：多实例之间没有网络通道，共享的
 * `~/.pi/agent` 目录是唯一媒介。信号文件就是这个媒介上的一次性标记。
 *
 * 内容只有 revision 与时间戳：真正权威的值始终是会话 JSONL，消费方据此
 * 重新读盘即可，不要把状态往这里搬（否则又多一份会失配的副本）。
 */

/** 信号目录名（相对 agentDir）。 */
export const SESSION_STATE_DIRNAME = "pidance-session-state";

/** 兜底对账间隔：fs.watch 失效（网络盘/容器/超出 watch 上限）时的最终一致。 */
export const SESSION_STATE_POLL_MS = 2_000;

function signalDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, SESSION_STATE_DIRNAME);
}

function signalPath(sessionId: string, agentDir: string = getAgentDir()): string {
	// 会话 id 是 UUID；仍做一次安全化，避免异常 id 逃出目录。
	const safe = sessionId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
	return join(signalDir(agentDir), `${safe}.json`);
}

/**
 * 主动通知：某实例刚改写了这个会话的状态（档位/模型）。
 *
 * 原子写（临时文件 + rename），读者不会看到半截 JSON。写失败不影响调用方 ——
 * 跨实例同步是增强，不是正确性前提（文件本身已是权威）。
 */
export function signalSessionStateChanged(
	sessionId: string,
	agentDir: string = getAgentDir(),
	now = Date.now(),
): void {
	if (!sessionId) return;
	try {
		const dir = signalDir(agentDir);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const target = signalPath(sessionId, agentDir);
		const tmp = `${target}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ sessionId, revision: now, updatedAt: now })}\n`, "utf8");
		renameSync(tmp, target);
	} catch {
		// 目录不可写（权限/只读挂载）：静默降级为「其他实例靠探针/重读才发现」。
	}
}

/**
 * 信号目录的指纹：`id:mtimeMs` 逐行。
 *
 * 必须带时间戳，不能只看「有哪些文件」—— 同一个会话第二次改档位时集合不变，
 * 只看集合就永远不广播（实测踩过这个坑）。
 */
export function signaledSessionsFingerprint(agentDir: string = getAgentDir()): string {
	try {
		const dir = signalDir(agentDir);
		return readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => {
				const id = name.slice(0, -".json".length);
				try {
					return `${id}:${statSync(join(dir, name)).mtimeMs}`;
				} catch {
					return `${id}:0`;
				}
			})
			.sort()
			.join("\n");
	} catch {
		return "";
	}
}

/** 当前信号目录里有哪些会话被标记过（排序，供指纹比较）。 */
export function listSignaledSessionIds(agentDir: string = getAgentDir()): string[] {
	try {
		return readdirSync(signalDir(agentDir))
			.filter((name) => name.endsWith(".json"))
			.map((name) => name.slice(0, -".json".length))
			.sort();
	} catch {
		return [];
	}
}

/**
 * 读取某会话的信号版本（revision）。没有信号文件返回 null。
 *
 * 消费方用它做「只看比自己新的一次」：revision 不比自己记的大就跳过，
 * 避免每次兜底对账都重新拉一遍。
 */
export function readSessionStateSignal(
	sessionId: string,
	agentDir: string = getAgentDir(),
): { revision: number } | null {
	if (!sessionId) return null;
	try {
		const raw = JSON.parse(readFileSync(signalPath(sessionId, agentDir), "utf8")) as { revision?: unknown };
		return typeof raw?.revision === "number" ? { revision: raw.revision } : null;
	} catch {
		return null;
	}
}

/** 测试/收尾用：清掉某会话（或全部）的信号，避免陈旧标记无限累积。 */
export function clearSessionStateSignal(sessionId?: string, agentDir: string = getAgentDir()): void {
	try {
		if (!sessionId) {
			rmSync(signalDir(agentDir), { recursive: true, force: true });
			return;
		}
		rmSync(signalPath(sessionId, agentDir), { force: true });
	} catch {
		/* 不存在即可 */
	}
}
