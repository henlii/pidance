import { NextResponse } from "next/server";
import { getNpmRegistry } from "@/lib/pidance-update";

export const dynamic = "force-dynamic";

const FETCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 8_000;
/** README 可能有一两百 KB，详情接口只给渲染用的前 60k 字符。 */
const README_MAX_CHARS = 60_000;
/** npm 包名（含作用域）的合法字符集，兼作 SSRF 白名单。 */
const NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
const DOWNLOAD_API = "https://api.npmjs.org/downloads/point/last-month/";

type VersionDoc = {
  name?: unknown;
  version?: unknown;
  readme?: unknown;
  description?: unknown;
  homepage?: unknown;
  license?: unknown;
  repository?: unknown;
};

function registryPath(name: string): string {
  return name.startsWith("@") ? name.replace("/", "%2F") : name;
}

function repoUrl(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const url = (value as { url?: unknown }).url;
    if (typeof url === "string" && url.trim()) return url.trim();
  }
  return null;
}

/**
 * 只查 <name>/latest：根文档会带上全部历史版本元数据（实测 billion-context 21MB / 5564 版），
 * 详情页拉一次就超时。
 */
async function fetchReadmeFromCdn(name: string, version: string): Promise<string> {
  if (!version) return "";
  const base = `https://cdn.jsdelivr.net/npm/${name}@${version}/`;
  for (const file of ["README.md", "readme.md"]) {
    try {
      const res = await fetch(`${base}${file}`, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.trim()) return text.slice(0, README_MAX_CHARS);
    } catch {
      // 换下一个文件名
    }
  }
  return "";
}

async function fetchMonthlyDownloads(name: string): Promise<number | null> {
  try {
    const res = await fetch(`${DOWNLOAD_API}${registryPath(name)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { downloads?: unknown };
    return typeof data.downloads === "number" && Number.isFinite(data.downloads) ? data.downloads : null;
  } catch {
    return null;
  }
}

/** GET /api/plugins/market/detail?name=@scope/pkg */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const name = (searchParams.get("name") ?? "").trim();
  if (!name || name.length > 214 || !NAME_RE.test(name)) {
    return NextResponse.json({ error: "invalid package name" }, { status: 400 });
  }

  const base = getNpmRegistry();
  const url = new URL(`${registryPath(name)}/latest`, base).toString();
  try {
    const [res, monthlyDownloads] = await Promise.all([
      fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }),
      fetchMonthlyDownloads(name),
    ]);
    if (res.status === 404) {
      return NextResponse.json({ error: "package not found" }, { status: 404 });
    }
    if (!res.ok) {
      return NextResponse.json({ error: `registry failed: HTTP ${res.status}` }, { status: 502 });
    }
    const doc = (await res.json()) as VersionDoc;
    const version = typeof doc.version === "string" ? doc.version : "";
    const readme = await fetchReadmeFromCdn(name, version);
    return NextResponse.json({
      name: typeof doc.name === "string" ? doc.name : name,
      version,
      description: typeof doc.description === "string" ? doc.description : "",
      readme,
      repository: repoUrl(doc.repository),
      homepage: typeof doc.homepage === "string" && doc.homepage ? doc.homepage : null,
      license: typeof doc.license === "string" ? doc.license : null,
      monthlyDownloads,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
