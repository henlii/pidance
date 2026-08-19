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
      "[pidance] 未解析到包内 Pi CLI（@earendil-works/pi-coding-agent/dist/cli.js）。subagent 可能失败。",
    );
  }
  // 版本号与 SDK 基线同步（AGENTS.md 锁定 0.84.1；升级 SDK 时同步此日志）。
  // 不用 require(package.json)：webpack 产物中无法解析包外模块路径。
  console.log("[pidance] 主 Agent runtime: 同进程 Pi SDK 0.84.1");
}
