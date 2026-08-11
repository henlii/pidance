/**
 * 插件更新检查：对 npm 源插件批量查询 registry 最新版本。
 */
import { execFileSync } from "node:child_process";
import { parseNpmSpec } from "./plugin-packages";

export type PluginUpdateInfo = {
  source: string;
  installed: string | null;
  latest: string | null;
  hasUpdate: boolean;
};

/** 并发上限（npm view 每包一次网络请求）。 */
const CONCURRENCY = 4;

function npmViewVersion(name: string): string | null {
  try {
    const out = execFileSync(
      "npm",
      ["view", name, "version", "--json", "--no-update-notifier"],
      { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const parsed: unknown = JSON.parse(out);
    return typeof parsed === "string" && parsed ? parsed : null;
  } catch {
    return null;
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 检查一组插件的更新。仅处理 npm: 源；git 源返回 hasUpdate:false。
 * installedVersion 由调用方提供（settings 中配置的版本或已装版本）。
 */
export async function checkPluginUpdates(
  sources: Array<{ source: string; installed: string | null }>,
): Promise<PluginUpdateInfo[]> {
  const npmSources = sources.filter((s) => s.source.trim().startsWith("npm:"));
  const infos = await mapLimit(npmSources, CONCURRENCY, async ({ source, installed }) => {
    const name = parseNpmSpec(source.slice(4)).name;
    const latest = name ? npmViewVersion(name) : null;
    const hasUpdate =
      latest !== null &&
      installed !== null &&
      latest !== installed &&
      compareVersions(latest, installed) > 0;
    return { source, installed, latest, hasUpdate };
  });
  // 非 npm 源：无更新
  const skipped = sources
    .filter((s) => !s.source.trim().startsWith("npm:"))
    .map((s) => ({ source: s.source, installed: s.installed, latest: null, hasUpdate: false }));
  return [...infos, ...skipped];
}
