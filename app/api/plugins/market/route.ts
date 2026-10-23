import { NextResponse } from "next/server";
import { getNpmRegistry } from "@/lib/pidance-update";

export const dynamic = "force-dynamic";

const SEARCH_PATH = "-/v1/search";
const FETCH_TIMEOUT_MS = 15_000;
/** 热门榜一次多取一些再按下载量排序；npm search 单次上限 250。 */
const HOT_SIZE = 250;
/** 关键词搜索按相关度取前 60，过滤后的前 24 条给前端。 */
const SEARCH_SIZE = 60;
const RESULT_LIMIT = 24;
const PI_KEYWORD = "pi-package";

type NpmSearchPackage = {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  keywords?: unknown;
  date?: unknown;
  publisher?: { username?: unknown };
};

type NpmSearchObject = {
  package?: NpmSearchPackage;
  downloads?: { monthly?: unknown };
};

type MarketPackage = {
  name: string;
  version: string;
  description: string;
  keywords: string[];
  publisher?: string;
  monthlyDownloads: number | null;
  updated: string | null;
};

/**
 * GET /api/plugins/market?q=
 * 无 q：Pi 官方约定关键词 pi-package 的热门榜（按月下载量降序）。
 * 有 q：npm 全文搜索后只保留真 Pi 包。
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").trim().slice(0, 100);
  const text = q || `keywords:${PI_KEYWORD}`;
  const size = q ? SEARCH_SIZE : HOT_SIZE;
  const base = getNpmRegistry();
  const url = new URL(`${SEARCH_PATH}?text=${encodeURIComponent(text)}&size=${size}`, base).toString();

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `npm search failed: HTTP ${res.status}` }, { status: 502 });
    }
    const data = (await res.json()) as { objects?: NpmSearchObject[] };
    const items: MarketPackage[] = (data.objects ?? [])
      .filter((o) => {
        const pkg = o.package;
        return Boolean(
          pkg &&
          typeof pkg.name === "string" &&
          Array.isArray(pkg.keywords) &&
          (pkg.keywords as unknown[]).includes(PI_KEYWORD),
        );
      })
      .map((o) => {
        const pkg = o.package as NpmSearchPackage;
        const monthly = o.downloads?.monthly;
        return {
          name: pkg.name as string,
          version: typeof pkg.version === "string" ? pkg.version : "",
          description: typeof pkg.description === "string" ? pkg.description : "",
          keywords: (pkg.keywords as unknown[]).filter((k): k is string => typeof k === "string"),
          publisher:
            pkg.publisher && typeof pkg.publisher.username === "string"
              ? pkg.publisher.username
              : undefined,
          monthlyDownloads: typeof monthly === "number" && Number.isFinite(monthly) ? monthly : null,
          updated: typeof pkg.date === "string" ? pkg.date : null,
        };
      });

    // 热门榜按下载量排；搜索结果保留 npm 的相关度顺序。
    if (!q) {
      items.sort((a, b) => (b.monthlyDownloads ?? 0) - (a.monthlyDownloads ?? 0));
    }
    return NextResponse.json({ items: items.slice(0, RESULT_LIMIT) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
