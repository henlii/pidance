import { NextResponse } from "next/server";
import { sessionService } from "@/lib/session-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/sessions/search?q=&limit=&scope=active|archived|all
 * 只读全文搜索：业务下沉 SessionService。
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("q") ?? "";
    const scope = url.searchParams.get("scope") ?? "active";
    if (scope !== "active" && scope !== "archived" && scope !== "all") {
      return NextResponse.json({ error: `Invalid scope: ${scope}` }, { status: 400 });
    }
    const limitRaw = url.searchParams.get("limit");
    let maxHits: number | undefined;
    if (limitRaw !== null && limitRaw !== "") {
      const n = Number(limitRaw);
      if (!Number.isFinite(n) || n < 1) {
        return NextResponse.json({ error: "limit must be a positive number" }, { status: 400 });
      }
      maxHits = Math.min(Math.floor(n), 100);
    }

    const result = await sessionService.searchFulltext(q, { maxHits, scope });
    return NextResponse.json({
      query: result.query,
      source: result.source,
      hits: result.hits,
      sessionIds: result.sessionIds,
    });
  } catch {
    return NextResponse.json({
      query: "",
      source: "none",
      hits: [],
      sessionIds: [],
    });
  }
}
