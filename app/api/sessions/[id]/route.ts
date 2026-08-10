import { NextResponse } from "next/server";
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import {
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  readSessionHeader,
  listAllSessions,
  buildSessionNavigationSnapshot,
} from "@/lib/session-reader";
import { openSessionFile } from "@/lib/session-file";
import { clearLeafSidecar } from "@/lib/session-leaf-sidecar";
import {
  parseContextLimitParam,
  sliceContextTail,
  DEFAULT_SESSION_TAIL_LIMIT,
} from "@/lib/session-context-window";
import { sessionService, READ_ONLY_SUBAGENT_ERROR, requireWritableSession } from "@/lib/session-service";
import { collectSubagentTree, deleteValidatedSubagents } from "@/lib/subagent-sessions";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    // navigateTree 只改 live sessionManager leaf，不改磁盘末 entry；
    // getReadView：存活 wrapper 时以 live 为权威，避免 loadSession 整刷跳回旧 leaf。
    const view = await sessionService.getReadView(id);
    if (!view) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const { filePath, manager: sm } = view;
    const searchParams = new URL(req.url).searchParams;
    const { leafId, tree, context: fullContext, header, sessionName } = buildSessionNavigationSnapshot(sm, {
      deferThinking: searchParams.has("deferThinking"),
      deferToolResultImages: searchParams.has("deferMedia"),
    });

    // tail/limit：首屏只返回最新 N 条，避免大会话整包下发；缺省不切片（兼容旧客户端）。
    const tailLimit = parseContextLimitParam(searchParams, DEFAULT_SESSION_TAIL_LIMIT);
    const context = tailLimit !== null
      ? sliceContextTail(fullContext, tailLimit)
      : {
          ...fullContext,
          hasMoreBefore: false,
          totalMessageCount: fullContext.messages.length,
        };

    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const relation = (await listAllSessions()).find((session) => session.id === id);
    const info = header ? {
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: sessionName,
      created: header.timestamp,
      modified,
      // messageCount 用全量总数，避免 tail 切片后侧栏计数失真
      messageCount: context.totalMessageCount ?? context.messages.length,
      firstMessage: context.messages.find((m) => m.role === "user")
        ? (() => {
            const msg = context.messages.find((m) => m.role === "user")!;
            const c = (msg as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
      ...(relation?.subagent ? { subagent: relation.subagent, readOnly: true as const } : {}),
    } : null;
    return NextResponse.json({
      sessionId: id,
      filePath,
      info,
      leafId,
      tree,
      context,
    });
  } catch (error) {
    if (String(error) === READ_ONLY_SUBAGENT_ERROR) {
      return NextResponse.json({ error: READ_ONLY_SUBAGENT_ERROR }, { status: 403 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await requireWritableSession(id, sessionService.isReadOnly);
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    // 单写者：live 会话走外部 pi 的 set_session_name（pi 自管写盘）；
    // 无 live 时才由 Pidance 磁盘写入（不会与外部进程并发写同一 JSONL）。
    const live = sessionService.getLive(id);
    if (live?.isAlive()) {
      await live.send({ type: "set_session_name", name: name.trim() });
    } else {
      const sm = openSessionFile(filePath);
      sm.appendSessionInfo(name.trim());
    }
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (String(error) === READ_ONLY_SUBAGENT_ERROR) {
      return NextResponse.json({ error: READ_ONLY_SUBAGENT_ERROR }, { status: 403 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await requireWritableSession(id, sessionService.isReadOnly);
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Read only the bounded header before deleting.
    const parentSessionPath = readSessionHeader(filePath)?.parentSession;

    const verifiedChildren = readSessionHeader(filePath)?.id === id
      ? collectSubagentTree(filePath, id)
      : [];

    // Re-attach all direct children to this session's parent (cascade re-parent)
    // Scan sibling files in the same directory
    const dir = filePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && join(dir, f) !== filePath);
      for (const file of files) {
        const childPath = join(dir, file);
        try {
          const content = readFileSync(childPath, "utf8");
          const lines = content.split("\n");
          const header = JSON.parse(lines[0]) as { type?: string; parentSession?: string };
          if (header.type === "session" && header.parentSession === filePath) {
            // Rewrite header with new parentSession
            header.parentSession = parentSessionPath;
            lines[0] = JSON.stringify(header);
            writeFileSync(childPath, lines.join("\n"));
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* skip if dir unreadable */ }

    sessionService.destroy(id);
    unlinkSync(filePath);
    clearLeafSidecar(filePath);
    const parentRoot = resolve(filePath.slice(0, -6));
    const skippedSubagents = deleteValidatedSubagents(verifiedChildren, parentRoot, invalidateSessionPathCache);
    invalidateSessionPathCache(id);
    // 永久删除成功后同步清理归档 sidecar（D8.4）；删除失败时 sidecar 保留。
    sessionService.removeArchiveRecordAfterPermanentDelete(id);
    invalidateSessionListCache();
    return NextResponse.json({ ok: true, skippedSubagents });
  } catch (error) {
    if (String(error) === READ_ONLY_SUBAGENT_ERROR) {
      return NextResponse.json({ error: READ_ONLY_SUBAGENT_ERROR }, { status: 403 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
