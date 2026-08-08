/**
 * POST /api/sessions/[id]/auto-name — 会话自动命名。
 * 从磁盘消息 + 默认模型配置生成标题（HTTP chat completions，不创建 pi Agent），
 * 再经 LiveAgentSession 统一 set_session_name 写名（外部 RPC / 进程内同一路径）。
 */

import { NextResponse } from "next/server";
import {
  generateSessionTitleFromMessages,
  resolveTitleModelConfig,
} from "@/lib/session-title";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";
import { sessionService, READ_ONLY_SUBAGENT_ERROR } from "@/lib/session-service";
import { openSessionFile } from "@/lib/session-file";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    // ensureLive：readOnly 门禁 + 复用/启动；不存在 → Session not found
    const session = await sessionService.ensureLive(id);

    // globalThis keeps wrappers alive across dev hot reloads; older instances
    // may predate waitUntilReady(), but those have already completed startup.
    // 外部 RPC 会话无 waitUntilReady（进程启动即就绪）；仅 wrapper 需要等扩展绑定。
    await (session as { waitUntilReady?: () => Promise<void> }).waitUntilReady?.();

    // 读磁盘消息（不依赖 live wrapper 的 inner AgentSession）
    const filePath = await resolveSessionPath(id);
    if (!filePath) throw new Error("Session not found");
    const { messages } = openSessionFile(filePath).buildSessionContext() as {
      messages: Array<{ role: string; content: unknown }>;
      entryIds: string[];
    };

    // 默认模型配置：settings.json defaultProvider/defaultModel + models.json
    const config = resolveTitleModelConfig();

    const result = await generateSessionTitleFromMessages({
      messages,
      provider: config.provider,
      modelId: config.modelId,
      baseUrl: config.baseUrl,
      api: config.api,
      apiKey: config.apiKey,
      headers: config.headers,
    });

    if (!session.isAlive()) {
      return NextResponse.json(
        { error: "The session was closed while its title was being generated. Please try again." },
        { status: 409 },
      );
    }

    // 统一写名路径：优先 send set_session_name（wrapper 与 ExternalRpcSession 均支持）；
    // 会话进程不可用（如外部 RPC 已退出）时回退磁盘 SessionFile 直写。
    try {
      await session.send({ type: "set_session_name", name: result.title });
    } catch {
      const sessionFile = session.sessionFile;
      if (!sessionFile) throw new Error("Session file is missing");
      openSessionFile(sessionFile).appendSessionInfo(result.title);
    }
    invalidateSessionListCache();
    return NextResponse.json({ title: result.title, usage: result.usage ?? null });
  } catch (error) {
    if (String(error) === READ_ONLY_SUBAGENT_ERROR) {
      return NextResponse.json({ error: READ_ONLY_SUBAGENT_ERROR }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Session not found")) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
