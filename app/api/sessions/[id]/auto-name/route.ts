/**
 * POST /api/sessions/[id]/auto-name — 会话自动命名。
 */

import { NextResponse } from "next/server";
import {
  generateSessionTitleFromMessages,
  resolveTitleModelConfig,
} from "@/lib/session-title";
import { sessionService, READ_ONLY_SUBAGENT_ERROR, httpStatusForSessionError } from "@/lib/session-service";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const session = await sessionService.ensureLive(id);
    await (session as { waitUntilReady?: () => Promise<void> }).waitUntilReady?.();

    const snapshot = await sessionService.getNavigationSnapshot(id);
    if (!snapshot) throw new Error("Session not found");
    const messages = (snapshot.context as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [];

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

    try {
      await session.send({ type: "set_session_name", name: result.title });
    } catch {
      await sessionService.destroyAsync(id);
      await sessionService.renameSession(id, result.title);
    }
    return NextResponse.json({ title: result.title, usage: result.usage ?? null });
  } catch (error) {
    if (String(error) === READ_ONLY_SUBAGENT_ERROR) {
      return NextResponse.json({ error: READ_ONLY_SUBAGENT_ERROR }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: httpStatusForSessionError(error) });
  }
}
