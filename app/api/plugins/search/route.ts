import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const SEARCH_API = "https://registry.npmjs.org/-/v1/search";

export type NpmSearchResult = {
  name: string;
  version: string;
  description: string;
  publisher?: string;
};

/**
 * POST /api/plugins/search  body: { query: string }
 * 搜索 npm 官方 registry（插件库）。关键词默认加 pi 提升相关度。
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { query?: unknown };
    const raw = typeof body.query === "string" ? body.query.trim() : "";
    if (!raw || raw.length > 100) {
      return NextResponse.json({ error: "query is required (max 100 chars)" }, { status: 400 });
    }
    const text = encodeURIComponent(raw);
    const res = await fetch(`${SEARCH_API}?text=${text}&size=15`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `npm search failed: HTTP ${res.status}` }, { status: 502 });
    }
    const data = (await res.json()) as {
      objects?: Array<{ package?: { name?: unknown; version?: unknown; description?: unknown; publisher?: { username?: unknown } } }>;
    };
    const results: NpmSearchResult[] = (data.objects ?? [])
      .map((o) => o.package)
      .filter((p): p is NonNullable<typeof p> => Boolean(p && typeof p.name === "string"))
      .map((p) => ({
        name: p.name as string,
        version: typeof p.version === "string" ? p.version : "",
        description: typeof p.description === "string" ? p.description : "",
        publisher:
          p.publisher && typeof p.publisher.username === "string"
            ? p.publisher.username
            : undefined,
      }));
    return NextResponse.json({ results });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
