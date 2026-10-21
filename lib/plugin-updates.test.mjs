import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { checkPluginUpdates, fetchLatestPluginVersion } = await jiti.import("./plugin-updates.ts");

const REGISTRY = "https://registry.example/";

/** 只认 URL → body 的假 registry；未登记的 URL 按 404 处理。 */
function fakeFetch(routes = {}, calls = []) {
  return async (url) => {
    calls.push(String(url));
    const body = routes[String(url)];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
}

test("registry URL：普通包与作用域包都查 /latest，作用域斜杠要转义", async () => {
  const calls = [];
  const fetchImpl = fakeFetch({}, calls);
  await fetchLatestPluginVersion("pi-subagents", REGISTRY, fetchImpl);
  await fetchLatestPluginVersion("@juicesharp/rpiv-btw", REGISTRY, fetchImpl);
  assert.deepEqual(calls, [
    "https://registry.example/pi-subagents/latest",
    "https://registry.example/@juicesharp%2Frpiv-btw/latest",
  ]);
});

test("批量检查：latest 高于已装才算可更新，git 源与查询失败都不算", async () => {
  const fetchImpl = fakeFetch({
    "https://registry.example/pi-subagents/latest": { version: "0.79.2" },
    "https://registry.example/@scope%2Fpkg/latest": { version: "2.0.0" },
  });
  const out = await checkPluginUpdates(
    [
      { source: "npm:pi-subagents@0.79.1", installed: "0.79.1" },
      { source: "npm:@scope/pkg", installed: "2.0.0" },
      { source: "npm:missing-pkg", installed: "1.0.0" },
      { source: "git:github.com/x/y@abc1234", installed: null },
    ],
    { registry: REGISTRY, fetchImpl },
  );
  assert.deepEqual(out, [
    { source: "npm:pi-subagents@0.79.1", installed: "0.79.1", latest: "0.79.2", hasUpdate: true },
    { source: "npm:@scope/pkg", installed: "2.0.0", latest: "2.0.0", hasUpdate: false },
    { source: "npm:missing-pkg", installed: "1.0.0", latest: null, hasUpdate: false },
    { source: "git:github.com/x/y@abc1234", installed: null, latest: null, hasUpdate: false },
  ]);
});

test("查询异常：网络错误按取不到 latest 处理，不抛给路由", async () => {
  const latest = await fetchLatestPluginVersion("pi-subagents", REGISTRY, async () => {
    throw new Error("ENOTFOUND");
  });
  assert.equal(latest, null);
});
