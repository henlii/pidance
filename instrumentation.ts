export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // 默认只用外部 pi：主 runtime 与 PI_SUBAGENT_PI_BINARY 同源。
  // 仅显式 inprocess 时回退到包内 CLI（兼容旧路径）。
  const { getAgentRuntimeMode, configureRuntimeEnv } = await import("@/lib/pi-runtime");
  if (getAgentRuntimeMode() === "inprocess") {
    const { configurePiSubagentBinary } = await import("@/lib/pi-subagent-bridge");
    configurePiSubagentBinary();
  } else {
    const resolved = configureRuntimeEnv(process.env);
    if (!resolved.path) {
      console.error(
        "[pidance] 未找到外部 Pi runtime（PIDANCE_PI_RUNTIME 或 PATH 中的 pi）。Agent 将无法启动。",
      );
    } else {
      console.log(
        `[pidance] 外部 Pi runtime: ${resolved.path} (${resolved.version ?? "?"} / ${resolved.source})`,
      );
    }
  }
}
