/**
 * 扩展加载的共享缓存（issue #71 引入）：两个只读消费者共用一份加载结果。
 *
 * 重点：同一 (cwd, agentDir) 只加载一次（含并发去重与失效），失败不抛。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { loadExtensionsForCwd, invalidateLoadedExtensionsCache, LOADED_EXTENSIONS_CACHE_TTL_MS } =
  await jiti.import("./loaded-extensions.ts");

test("同一 (cwd, agentDir) 只加载一次；并发调用共享同一次加载", async () => {
  let calls = 0;
  const loaderFactory = () => async () => {
    calls += 1;
    return { extensions: [{ name: "qa" }], runtime: {}, errors: [] };
  };
  const cwd = "/tmp/qa-loaded-1";
  const [a, b] = await Promise.all([
    loadExtensionsForCwd({ cwd, loaderFactory }),
    loadExtensionsForCwd({ cwd, loaderFactory }),
  ]);
  assert.equal(calls, 1);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const third = await loadExtensionsForCwd({ cwd, loaderFactory });
  assert.equal(calls, 1, "命中缓存不应再加载");
  assert.equal(third.ok, true);
  assert.equal(third.value.extensions.length, 1);
  assert.ok(LOADED_EXTENSIONS_CACHE_TTL_MS > 0);
});

test("失效后重新加载；agentDir/cwd 不同则各自成键", async () => {
  const seen = [];
  const loaderFactory = (cwd, agentDir) => async () => {
    seen.push(`${cwd}|${agentDir ?? ""}`);
    return { extensions: [], runtime: {}, errors: [] };
  };
  const cwd = "/tmp/qa-loaded-2";
  await loadExtensionsForCwd({ cwd, loaderFactory });
  await loadExtensionsForCwd({ cwd, agentDir: "/tmp/qa-agent-2", loaderFactory });
  assert.equal(seen.length, 2, "不同 agentDir 应各自加载");

  invalidateLoadedExtensionsCache();
  await loadExtensionsForCwd({ cwd, loaderFactory });
  assert.equal(seen.length, 3, "失效后应重新加载");
});

test("加载失败降级为 { ok:false }，不抛；bypassCache 每次真加载", async () => {
  const failing = await loadExtensionsForCwd({
    cwd: "/tmp/qa-loaded-3",
    loaderFactory: () => async () => { throw new Error("load boom"); },
  });
  assert.equal(failing.ok, false);
  assert.equal(failing.error, "load boom");

  let calls = 0;
  const loaderFactory = () => async () => {
    calls += 1;
    return { extensions: [], runtime: {}, errors: [] };
  };
  await loadExtensionsForCwd({ cwd: "/tmp/qa-loaded-4", loaderFactory, bypassCache: true });
  await loadExtensionsForCwd({ cwd: "/tmp/qa-loaded-4", loaderFactory, bypassCache: true });
  assert.equal(calls, 2, "bypassCache 必须每次真加载（测试/内部用）");
});
