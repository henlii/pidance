/**
 * 树导航（`select_leaf_exact` / `branch_from_assistant`）的目标决策与落地。
 *
 * 单独成模块的理由：同一条命令有两条落地路径，判断必须一致。
 * - Host 的 live 路径（lib/sdk-session-host.ts）：会话还活着，用**它自己的 writer** 写。
 *   只有这样 `session_before_tree`（可取消）/ `session_tree` 才能由本会话的 extension runner
 *   按 Pi 的时序派发：SDK 的 `AgentSession.dispose()` 会 `_extensionRunner.invalidate(...)`，
 *   交接之后再补发只会把 stale ctx 交给插件；扩展实例也不跨加载共享（同进程两次加载同一批
 *   路径拿到的是不同实例），另建 runner 等于把事件发给一组没有状态的实例。
 * - Service 的离线路径（lib/session-service.ts）：先交出 writer，再开磁盘视图写。
 *
 * Pi 语义参照（dist/core/agent-session.js 的 `navigateTree`）：
 * - 目标就是当前 leaf → 无变化：Pi 在 emit 之前就 `return { cancelled: false }`，这里同样不发事件。
 * - 目标是文件末尾（外部 pi 的默认 leaf）→ 清掉过期 sidecar。只跳过写入会残留旧分支指针，
 *   下次开盘恢复旧 leaf，导航到最新分支的意图丢失。
 * - `SessionManager.branch()` 只改内存 leaf（dist/core/session-manager.js），所以这两个命令的
 *   磁盘效果只有 sidecar 文件。
 */
import { clearLeafSidecar, writeLeafSidecar } from "./session-leaf-sidecar";
import { computeTurnEnd, type TurnEndEntry } from "./turn-end";

/** 这两个命令用到的 SessionManager 面（Host 的 live manager 与离线磁盘视图共用）。 */
export interface TreeNavigationSessionManager {
  getLeafId(): string | null;
  getLastEntryId(): string | null;
  getEntry(entryId: string): TreeNavigationEntry | undefined;
  getBranch(leafId: string): readonly TurnEndEntry[];
  branch(entryId: string): void;
}

/** 只用得到的 entry 形状（不依赖 pi npm 的类型）。 */
export type TreeNavigationEntry = {
  type?: string;
  message?: { role?: string };
};

/**
 * 计划。`noop` = 连 sidecar 都不用动（Pi 同款提前返回，不发事件）；
 * `branch` = 把 leaf 指到 `leafId`，并按 `clearSidecar` 写或清 sidecar。
 */
export type TreeNavigationPlan =
  | { kind: "noop" }
  | { kind: "branch"; leafId: string; clearSidecar: boolean };

/** 精确 leaf：user 叶也停在该 entry，不触发 Pi 的 user 编辑语义。 */
export function planSelectLeafExact(
  sessionManager: TreeNavigationSessionManager,
  entryId: string,
): TreeNavigationPlan {
  if (entryId === sessionManager.getLeafId()) return { kind: "noop" };
  if (entryId === sessionManager.getLastEntryId()) {
    return { kind: "branch", leafId: entryId, clearSidecar: true };
  }
  if (!sessionManager.getEntry(entryId)) throw new Error(`Entry ${entryId} not found`);
  return { kind: "branch", leafId: entryId, clearSidecar: false };
}

/** assistant 轮末分支：leaf 落在该 assistant 所属轮的末尾 entry。 */
export function planBranchFromAssistant(
  sessionManager: TreeNavigationSessionManager,
  assistantEntryId: string,
): TreeNavigationPlan {
  const leafId = sessionManager.getLeafId();
  if (!leafId) throw new Error("Session has no leaf");
  const targetEntry = sessionManager.getEntry(assistantEntryId);
  if (!targetEntry) throw new Error("Entry not found");
  if (targetEntry.type !== "message" || targetEntry.message?.role !== "assistant") {
    throw new Error("Only assistant messages can be branched from");
  }
  const turnEnd = computeTurnEnd(sessionManager.getBranch(leafId), assistantEntryId);
  return {
    kind: "branch",
    leafId: turnEnd,
    clearSidecar: turnEnd === sessionManager.getLastEntryId(),
  };
}

/**
 * 落地：先写/清 sidecar（磁盘提交点），再改内存 leaf。`noop` 不产生任何写入。
 *
 * 顺序理由：`branch()` 只改内存，sidecar 是这两个命令**唯一**的磁盘效果。先写 sidecar、
 * 写成功再改内存，则 sidecar 写失败时内存 leaf 原样不动 —— 调用方看到失败就等于
 * 「什么都没发生」，不会留下「内存已经换了分支、磁盘指针还是旧的」的分裂（反过来的顺序
 * 就会出现这种状态：调用方收到失败、但同一个 manager 已经被改过）。
 * `branch()` 在计划阶段已校验过目标 entry 存在，因此它失败只可能是真正的程序错误。
 */
export function applyTreeNavigation(options: {
  sessionManager: TreeNavigationSessionManager;
  sessionFile: string;
  plan: TreeNavigationPlan;
}): void {
  const { sessionManager, sessionFile, plan } = options;
  if (plan.kind === "noop") return;
  // 没有会话文件就没有 sidecar 可写：空串不能当路径用（leafSidecarPath("") 会落到 cwd）。
  if (sessionFile) {
    if (plan.clearSidecar) clearLeafSidecar(sessionFile);
    else writeLeafSidecar(sessionFile, plan.leafId);
  }
  sessionManager.branch(plan.leafId);
}
