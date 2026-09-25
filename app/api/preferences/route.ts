import { NextResponse } from "next/server";
import {
  applyAndWritePidancePrefsOps,
  mergeAndWritePidancePrefsWithDiff,
  readPidancePrefs,
  stripHostOwnedQueuePrefs,
} from "@/lib/pidance-prefs-file";
import { isSupportedPrefOp, type PidancePrefOp } from "@/lib/pidance-prefs-ops";
import { getPidancePrefsBus } from "@/lib/pidance-prefs-bus";
import { syncProjectTrustFromPrefs } from "@/lib/project-trust";
import { syncPiThemeWithShellPreference } from "@/lib/theme-preference-sync";

export const dynamic = "force-dynamic";

const MAX_PREFS_BYTES = 1_000_000;

/**
 * GET /api/preferences — 服务端持久化偏好（跨客户端同步）。
 */
export async function GET() {
  try {
    const bus = getPidancePrefsBus();
    // revision/bootId 供客户端对账（#66）：只应用更新的版本；bootId 变化说明后端重启过。
    return NextResponse.json(
      { prefs: readPidancePrefs(), revision: bus.revision(), bootId: bus.bootId() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/preferences — 顶层合并写入（不整体覆盖；后写者胜出）。
 * body: { prefs: object }
 */
export async function PUT(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { prefs?: unknown; ops?: unknown };
    // 命令语义（#66）：集合类键用 add/remove/set，由服务端在文件锁内施加到**当前**内容上，
    // 于是两个客户端各自「加一项」不会互相覆盖（整值 patch 会）。
    if (Array.isArray(body.ops)) {
      const ops = body.ops.filter((item): item is PidancePrefOp => {
        if (!item || typeof item !== "object") return false;
        const candidate = item as { key?: unknown; op?: unknown; value?: unknown };
        return typeof candidate.key === "string" && typeof candidate.op === "string"
          && isSupportedPrefOp(candidate as PidancePrefOp);
      });
      if (ops.length === 0) {
        return NextResponse.json({ error: "ops 里没有受支持的命令" }, { status: 400 });
      }
      const before = readPidancePrefs();
      const changed = applyAndWritePidancePrefsOps(ops);
      const after = readPidancePrefs();
      if (Object.keys(changed).length === 0) {
        return NextResponse.json({ ok: true, revision: getPidancePrefsBus().revision(), changed: {} });
      }
      syncProjectTrustFromPrefs(before, after);
      // 用户在设置里改壳的明暗 → 插件主题跟着切（dark/light 是同一个设置，见该模块注释）。
      syncPiThemeWithShellPreference(after);
      const bus = getPidancePrefsBus();
      const event = bus.publish(changed);
      return NextResponse.json({ ok: true, revision: event.revision, changed });
    }

    const prefs = body.prefs;
    if (typeof prefs !== "object" || prefs === null || Array.isArray(prefs)) {
      return NextResponse.json({ error: "prefs must be a JSON object" }, { status: 400 });
    }
    const serialized = JSON.stringify(prefs);
    if (Buffer.byteLength(serialized, "utf8") > MAX_PREFS_BYTES) {
      return NextResponse.json(
        { error: `preferences exceed ${MAX_PREFS_BYTES} bytes` },
        { status: 413 },
      );
    }
    // 客户端整包快照可能带着投递前的旧队列：它只能读到队列，不能写回（
    // 否则已投递条目会被恢复成 waiting 并重复投递）。
    const { patch, dropped } = stripHostOwnedQueuePrefs(prefs as Record<string, unknown>);
    if (dropped.length > 0) {
      console.warn(`[pidance] ignored host-owned queue preferences from client: ${dropped.join(", ")}`);
    }
    const before = readPidancePrefs();
    const changed = mergeAndWritePidancePrefsWithDiff(patch);
    const after = readPidancePrefs();
    const bus = getPidancePrefsBus();
    if (Object.keys(changed).length === 0) {
      // 没有实际变化就不广播（否则客户端会收到空事件、白跑一轮对账）
      return NextResponse.json({ ok: true, revision: bus.revision(), changed: {} });
    }
    syncProjectTrustFromPrefs(before, after);
    // 同上：壳明暗变了，插件主题也要同源。
    syncPiThemeWithShellPreference(after);
    const event = bus.publish(changed);
    return NextResponse.json({ ok: true, revision: event.revision, changed });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
