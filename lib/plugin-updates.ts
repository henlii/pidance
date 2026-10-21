/**
 * 插件更新检查：对 npm 源插件批量查询 registry 最新版本。
 *
 * 走 HTTP 而不是 `npm view`：服务进程的 PATH 里不一定有 npm —— systemd 拉起的稳定版
 * 没有（实测 PATH 只有 /usr/bin 一类系统目录，npm 装在 nvm 目录下），桌面壳用包内
 * Electron 的 Node 拉起服务时也没有。`execFileSync("npm")` 只会 ENOENT → latest 恒为
 * null，界面表现就是「检查更新」永远没有更新。registry 地址与主包自更新同一口径
 * （`getNpmRegistry`：PIDANCE_NPM_REGISTRY / npm_config_registry / 官方源）。
 */
import { getNpmRegistry } from "./pidance-update";
import { parseNpmSpec } from "./plugin-packages";

export type PluginUpdateInfo = {
  source: string;
  installed: string | null;
  latest: string | null;
  hasUpdate: boolean;
};

/** 并发上限（每包一次 registry 请求）。 */
const CONCURRENCY = 4;

/** 单包查询超时；超时按「取不到 latest」处理，不拖住其它包。 */
const FETCH_TIMEOUT_MS = 12_000;

/** registry.npmjs.org/pi-subagents/latest；作用域包是 @scope%2Fname。 */
function latestUrl(name: string, registry: string): string {
  const base = registry.endsWith("/") ? registry : `${registry}/`;
  const path = name.startsWith("@") ? name.replace("/", "%2F") : name;
  return new URL(`${path}/latest`, base).toString();
}

/** 取单个包的 latest；任何失败都返回 null（调用方按「无更新」处理）。 */
export async function fetchLatestPluginVersion(
  name: string,
  registry: string = getNpmRegistry(),
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<string | null> {
  try {
    const res = await fetchImpl(latestUrl(name, registry), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === "string" && data.version.trim() ? data.version.trim() : null;
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
  options: { registry?: string; fetchImpl?: typeof fetch } = {},
): Promise<PluginUpdateInfo[]> {
  const registry = options.registry ?? getNpmRegistry();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const npmSources = sources.filter((s) => s.source.trim().startsWith("npm:"));
  const infos = await mapLimit(npmSources, CONCURRENCY, async ({ source, installed }) => {
    const name = parseNpmSpec(source.slice(4)).name;
    const latest = name ? await fetchLatestPluginVersion(name, registry, fetchImpl) : null;
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
