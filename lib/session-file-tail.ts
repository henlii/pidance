/**
 * 会话文件跟随（跨进程 / 外部修改）。
 *
 * 为什么要有：JSONL 的 writer 是持有 running lease 的那个进程（`SessionManager`
 * 单写者）。另一个实例、或外部工具改了文件时，本进程没有 live host，
 * `/api/agent/<id>/events` 直接 404，界面就停在打开那一刻。
 *
 * 粒度说明：Pi 只在 `message_end` 与各种 `append*` 操作时落一行
 * （`agent-session.js` 的持久化点 + `session-manager._persist`），流式 token
 * 不落盘。所以文件跟随能拿到的是**消息/工具结果边界**，不是打字机。
 *
 * 这里只做两件事：探测文件有没有变、等文件变。投影由
 * `/api/sessions/[id]/context?after=<entryId>` 负责（服务端已有的切片逻辑），
 * 不在这里重写一遍 entry → message 的规则。
 */
import { closeSync, openSync, readSync, statSync, watch, type FSWatcher } from "node:fs";

export type FileStamp = { ino: number; size: number };

export type SessionFileProbe = {
  /** 文件可读。false 时其余字段为中性值（客户端保持现状，不报错）。 */
  available: boolean;
  ino: number;
  size: number;
  /** 文件末尾一条**完整** entry 的 id；用于确认客户端手里的尾巴是否还对得上。 */
  lastEntryId: string | null;
  /** 相对上次探测，文件变长了（或有新的完整行）。 */
  changed: boolean;
  /** 需要整份重载：文件被外部重写/截断，且当前没有别的 writer。 */
  reset: boolean;
  /** 有别的 writer 在写，却检测到截断/换 inode：外部改写，不能静默合并。 */
  externalRewrite: boolean;
};

/** 尾部探测窗口：只为取最后一条 entry id，不做整份解析。 */
const TAIL_PROBE_BYTES = 64 * 1024;
/** fs.watch 事件合并窗口（一次 append 会触发多次回调）。 */
const WATCH_DEBOUNCE_MS = 60;
/** 等待期间的兜底对账间隔：inotify 在网络盘/容器挂载上会静默失效。 */
export const FILE_FOLLOW_POLL_MS = 2_000;

export function readFileStamp(path: string): FileStamp | null {
  try {
    const stat = statSync(path);
    return { ino: Number(stat.ino), size: stat.size };
  } catch {
    return null;
  }
}

/**
 * 读文件末尾最后一条完整 entry 的 id。
 *
 * 只读尾部窗口（64KB），并从第一个换行后开始解析：窗口起点可能落在某行中间。
 * 写入中的半行解析失败就继续往前找——它还没有 id 可言。
 */
export function readLastEntryId(path: string, size: number): string | null {
  if (size <= 0) return null;
  const length = Math.min(size, TAIL_PROBE_BYTES);
  const start = size - length;
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    let text = buffer.subarray(0, read).toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      if (newline < 0) return null;
      text = text.slice(newline + 1);
    }
    const lines = text.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as { id?: unknown };
        if (typeof entry?.id === "string" && entry.id.length > 0) return entry.id;
      } catch {
        // 写端正在写的半行（或损坏行）：往前找一条完整的。
      }
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * 探测一次。
 *
 * - `previous` 为 null（首次）：只建基线，`changed` 恒 false —— 客户端刚加载完详情，
 *   不该因为"文件比 offset 大"再拉一遍。
 * - 变长：`changed = true`。
 * - 变短 / 换 inode：没有 writer 时 `reset`（文件被外部重写或分支换文件）；
 *   有 writer 时 `externalRewrite`（运行中的 writer 不会截断自己的文件）。
 */
export function probeSessionFile(
  path: string,
  previous: { offset: number; ino: number } | null,
  options: { writerActive?: boolean } = {},
): SessionFileProbe {
  const stamp = readFileStamp(path);
  if (!stamp) {
    return {
      available: false,
      ino: 0,
      size: 0,
      lastEntryId: null,
      changed: false,
      reset: false,
      externalRewrite: false,
    };
  }
  const writerActive = options.writerActive === true;
  const regressed = previous !== null && (stamp.ino !== previous.ino || stamp.size < previous.offset);
  const changed =
    previous !== null && !regressed && (stamp.size !== previous.offset || stamp.ino !== previous.ino);
  // 没变化时不读尾巴：空闲会话按 10s 一轮探测，不该每轮都读 64KB。
  const wantsTail = previous === null || changed || regressed;
  return {
    available: true,
    ino: stamp.ino,
    size: stamp.size,
    lastEntryId: wantsTail ? readLastEntryId(path, stamp.size) : null,
    changed,
    reset: regressed && !writerActive,
    externalRewrite: regressed && writerActive,
  };
}

/**
 * 长轮询：等到文件出现**实质变化**（或超时）。
 *
 * 订阅语义由请求生命周期承担：一个在途请求 = 一份订阅，客户端 abort 即退订，
 * 服务端不留全局 watcher 表 —— 打开的会话数就是 watch 数。
 *
 * 返回值：true = 观察到变化（调用方再 probe 一次拿准确值），false = 超时/被取消。
 * fs.watch 的事件不直接当结论：事件可能由无关的元数据变更触发，这里 debounce 后
 * 比对 stamp，没变就继续等，避免客户端被假事件拉着空转。
 */
export function waitForSessionFileChange(
  path: string,
  since: FileStamp,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let watcher: FSWatcher | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (debounce !== null) clearTimeout(debounce);
      if (poll !== null) clearInterval(poll);
      if (deadline !== null) clearTimeout(deadline);
      watcher?.close();
      watcher = null;
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (changed: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(changed);
    };
    const check = () => {
      if (settled) return;
      const stamp = readFileStamp(path);
      // 文件消失/换 inode/变长/变短都算变化：具体是 reset 还是 changed 由 probe 判。
      if (!stamp || stamp.ino !== since.ino || stamp.size !== since.size) finish(true);
    };
    const onAbort = () => finish(false);

    if (signal?.aborted) {
      resolve(false);
      return;
    }
    try {
      watcher = watch(path, () => {
        if (settled) return;
        if (debounce !== null) clearTimeout(debounce);
        debounce = setTimeout(check, WATCH_DEBOUNCE_MS);
      });
      watcher.on("error", () => {
        // watch 失效不等于文件没变：交给兜底轮询。
        watcher?.close();
        watcher = null;
      });
    } catch {
      // 目录不可 watch（网络盘等）：只走轮询。
    }
    poll = setInterval(check, FILE_FOLLOW_POLL_MS);
    deadline = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
