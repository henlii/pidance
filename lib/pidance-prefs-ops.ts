/**
 * 偏好写入的「命令」语义（#66）。
 *
 * 为什么需要它：`PUT /api/preferences` 原本是**整值 patch** —— 客户端发
 * `{sidebarUi:{projectRoots:[...11 项, 新项]}}`。服务端只做「顶层键 + 一层子键」合并，
 * 数组是整体替换，所以两个客户端各自基于自己的快照加一项时，后写者会把前者的项**丢掉**
 * （已知限制：同一数组两标签各加一项仍是 LWW）。
 *
 * 命令把「加一项 / 删一项」表达成意图，由服务端在**文件锁内**施加到**当前**内容上，
 * 于是并发加项不会互相覆盖，也不需要 CRDT。命令只覆盖「集合」类键；标量键继续走 patch。
 */

export type PidancePrefOpKind = "add" | "remove" | "set";

export interface PidancePrefOp {
  /** 点路径，例如 `sidebarUi.projectRoots`、`pluginLocks.my-plugin`。 */
  key: string;
  op: PidancePrefOpKind;
  value?: unknown;
}

export type PidancePrefsRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PidancePrefsRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPath(root: PidancePrefsRecord, key: string): unknown {
  let node: unknown = root;
  for (const part of key.split(".")) {
    if (!isPlainRecord(node)) return undefined;
    node = node[part];
  }
  return node;
}

/** 写入点路径；沿路创建缺失的对象。返回被写入的容器与末段键，供集合操作复用。 */
function ensurePath(root: PidancePrefsRecord, key: string): { container: PidancePrefsRecord; last: string; existed: boolean } {
  const parts = key.split(".");
  let node: PidancePrefsRecord = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    const next = node[part];
    if (!isPlainRecord(next)) {
      const created: PidancePrefsRecord = {};
      node[part] = created;
      node = created;
      continue;
    }
    node = next;
  }
  const last = parts[parts.length - 1];
  return { container: node, last, existed: Object.prototype.hasOwnProperty.call(node, last) };
}

/** 命令是否被支持：只有集合类键允许 add/remove，其余必须是 set。 */
export function isSupportedPrefOp(op: PidancePrefOp): boolean {
  if (!op || typeof op.key !== "string" || op.key.length === 0) return false;
  if (op.key === "sessionQueue" || op.key.startsWith("sessionQueue.")) return false;
  if (op.op === "add" || op.op === "remove") {
    return op.key === "sidebarUi.projectRoots"
      || op.key === "sidebarUi.pinnedSessionIds"
      || op.key === "sidebarUi.ungroupedSessionIds"
      || op.key === "sidebarUi.collapsedProjectRoots";
  }
  return op.op === "set";
}

/**
 * 就地把命令施加到偏好对象上（**纯内存操作，调用方负责锁与写盘**）。
 *
 * - `add`：数组去重追加；`value` 为空或数组中已有则不改动。
 * - `remove`：过滤掉 `value`。
 * - `set`：整值替换；`value === null` 表示删键（与服务端 merge 的墓碑语义一致）。
 *
 * 返回**实际变更的点路径**（空数组 = 无改动）；调用方据此决定要不要写盘/广播。
 */
export function applyPrefOps(prefs: PidancePrefsRecord, ops: readonly PidancePrefOp[]): string[] {
  const changedKeys: string[] = [];
  const mark = (key: string) => {
    if (!changedKeys.includes(key)) changedKeys.push(key);
  };
  for (const op of ops) {
    if (!isSupportedPrefOp(op)) continue;
    if (op.op === "set") {
      const { container, last, existed } = ensurePath(prefs, op.key);
      if (op.value === null || op.value === undefined) {
        if (!existed) continue;
        delete container[last];
        mark(op.key);
        continue;
      }
      if (JSON.stringify(container[last]) === JSON.stringify(op.value)) continue;
      container[last] = op.value;
      mark(op.key);
      continue;
    }
    const current = getPath(prefs, op.key);
    const list = Array.isArray(current) ? current.filter((item): item is unknown => true) : [];
    const value = op.value;
    if (typeof value !== "string" || value.length === 0) continue;
    if (op.op === "add") {
      if (list.includes(value)) continue;
      list.push(value);
    } else {
      if (!list.includes(value)) continue;
      const filtered = list.filter((item) => item !== value);
      list.length = 0;
      list.push(...filtered);
    }
    const { container, last } = ensurePath(prefs, op.key);
    container[last] = list;
    mark(op.key);
  }
  return changedKeys;
}
