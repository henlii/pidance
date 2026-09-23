export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // 主 Agent 使用同进程 SDK；subagent 使用同一发布依赖内的 Pi CLI。
  const { configurePiSubagentBinaryFromPackage } = await import(
    "@/lib/pi-subagent-bridge"
  );
  const resolved = configurePiSubagentBinaryFromPackage();
  if (resolved) {
    console.log(`[pidance] subagent Pi CLI: ${resolved}`);
  } else {
    console.error(
      "[pidance] 未解析到包内 Pi CLI（@earendil-works/pi-coding-agent package.json#bin.pi）。subagent 可能失败。",
    );
  }
  // 版本号与 SDK 基线同步（AGENTS.md 锁定 0.87.0；升级 SDK 时同步此日志）。
  // 不用 require(package.json)：webpack 产物中无法解析包外模块路径。
  console.log("[pidance] 主 Agent runtime: 同进程 Pi SDK 0.87.0");

  // 回收崩溃/被 SIGKILL 的进程留下的租约文件：release 只在优雅 dispose 时执行，
  // 否则租约目录会无界增长（实测本机 2550 文件 / 11MB）。只删持有者已死的。
  try {
    const { sweepStaleRunningLeases } = await import("@/lib/session-running-lease");
    const swept = sweepStaleRunningLeases();
    if (swept.removed > 0) {
      console.log(`[pidance] 已回收 ${swept.removed} 个失效运行租约文件（在用的 ${swept.active} 个）`);
    }
  } catch (error) {
    // 回收失败不得影响服务启动（下次启动再清）。
    console.error("[pidance] 回收运行租约失败（已忽略）:", error);
  }

  // 附件兜底回收：超过保留期且已被任何队列/会话引用不到的文件才会删（引用集合
  // 读不完整时自身会放弃）。主要针对崩溃残留与已投递消息的模型副本：
  // 「删除附件即回收」走客户端主动 DELETE，这里是长尾兜底。
  try {
    const { sweepUnreferencedAttachments } = await import("@/lib/attachment-gc");
    const swept = sweepUnreferencedAttachments();
    if (swept.deleted > 0) {
      console.log(`[pidance] 已回收 ${swept.deleted} 个无引用附件（${Math.round(swept.bytes / 1024)} KB）`);
    }
  } catch (error) {
    // 回收失败不得影响服务启动（下次启动再清）。
    console.error("[pidance] 回收无引用附件失败（已忽略）:", error);
  }

  // 恢复服务端重启前未投递的 follow-up 队列（后台消息投递）。
  try {
    const { recoverFollowUpQueues } = await import("@/lib/live-session-registry");
    void recoverFollowUpQueues();
  } catch (error) {
    console.error("[pidance] recover follow-up queues failed:", error);
  }

  // 项目信任对齐：主 Agent 走同进程 SDK，本来就不做信任判定；subagent 走 pi CLI
  // 子进程，会真的判定 —— 不写条目时 ask + 无 UI = false，子代理里项目技能/扩展
  // 会缺失。启动时按侧栏现状把信任面拉齐（打开的写 true、关闭的撤销），顺带补齐
  // 本功能上线前就已加入的项目。
  try {
    const { readPidancePrefs } = await import("@/lib/pidance-prefs-file");
    const { syncProjectTrustBackfill } = await import("@/lib/project-trust");
    const result = syncProjectTrustBackfill(readPidancePrefs());
    if (result.trusted > 0 || result.revoked > 0) {
      console.log(`[pidance] 项目信任已对齐：新增 ${result.trusted}，撤销 ${result.revoked}`);
    }
  } catch (error) {
    console.error("[pidance] 项目信任对齐失败（已忽略）:", error);
  }
}
