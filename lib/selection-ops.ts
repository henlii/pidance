/**
 * 每会话「模型 + 思考档」写入操作的串行与结算（纯函数）。
 *
 * 两个必须由代次保护的场景，都是实际发生过的缺陷：
 *
 * 1. **回滚不得覆盖更新的选择**。旧实现用「同一会话就允许回滚」的宽松条件，
 *    连续选择 A→B 时，A 的迟到失败会把 B 抹掉。这里按操作代次做 CAS：
 *    只有仍是最新操作的那次才允许回滚。
 * 2. **同一会话的两步写入必须串行**。`set_model` 与 `set_thinking_level` 是
 *    一对操作；两次选择交错执行会形成「模型 B + 深度 A」的组合。
 *
 * Host 的 `set_model` 会套用模型自带档位，所以顺序必须是 set_model → set_thinking_level，
 * 否则用户刚选的深度会被模型默认值覆盖（磁盘与 UI 分叉）。
 */

export type SelectionOpBook = Readonly<Record<string, number>>;

export function openSelectionOp(
  book: SelectionOpBook,
  sessionId: string,
  opId: number,
): SelectionOpBook {
  return { ...book, [sessionId]: opId };
}

/** 结算是幂等的：只有仍登记为该会话当前操作时才清除。 */
export function closeSelectionOp(
  book: SelectionOpBook,
  sessionId: string,
  opId: number,
): SelectionOpBook {
  if (book[sessionId] !== opId) return book;
  const next = { ...book };
  delete next[sessionId];
  return next;
}

/** 请求代次是否仍是最新：用于「迟到失败不得回滚更新的选择」。 */
export function isLatestOp(book: SelectionOpBook, sessionId: string, opId: number): boolean {
  return book[sessionId] === opId;
}

/** 该会话是否有在途操作（在途期间不得用磁盘快照结算 override）。 */
export function hasOpenOp(book: SelectionOpBook, sessionId: string): boolean {
  return book[sessionId] !== undefined;
}
