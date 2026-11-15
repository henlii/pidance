/**
 * /api/sessions/[id]/tail 的探测语义（跨进程文件跟随的入口）。
 *
 * 直接导入 route handler 并替换 `sessionService` 的只读探针，不走 HTTP
 * （部署实例开着 Basic Auth，测试不该依赖口令）。
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { sessionService } = await jiti.import("@/lib/session-service");
const { GET } = await jiti.import("../app/api/sessions/[id]/tail/route.ts");

const entry = (id, parentId = null) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text: id }] },
});

function makeSessionFile(lines) {
  const dir = mkdtempSync(join(tmpdir(), "pidance-tail-route-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  return { dir, path };
}

async function withPatchedService(patch, run) {
  const original = {};
  for (const [key, value] of Object.entries(patch)) {
    original[key] = sessionService[key];
    sessionService[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(original)) sessionService[key] = value;
  }
}

const call = (id, query = "") =>
  GET(new Request(`http://localhost/api/sessions/${id}/tail${query}`), {
    params: Promise.resolve({ id }),
  });

test("未知会话：200 安全空态，不把跟随循环打成错误页", async () => {
  await withPatchedService({ resolvePath: async () => null }, async () => {
    const response = await call("missing-session");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.available, false);
    assert.equal(body.changed, false);
    assert.equal(body.reset, false);
    assert.equal(body.externalRewrite, false);
  });
});

test("首次只建基线；带 offset/ino 才报 changed", async () => {
  const { dir, path } = makeSessionFile([entry("a")]);
  try {
    await withPatchedService(
      {
        resolvePath: async () => path,
        getLive: () => undefined,
        isLockedByOther: () => false,
      },
      async () => {
        const baseline = await (await call("s1")).json();
        assert.equal(baseline.available, true);
        assert.equal(baseline.changed, false, "首次不该说变了");
        assert.equal(baseline.lastEntryId, "a");

        appendFileSync(path, `${JSON.stringify(entry("b", "a"))}\n`);
        const grown = await (
          await call("s1", `?offset=${baseline.size}&ino=${baseline.ino}`)
        ).json();
        assert.equal(grown.changed, true);
        assert.equal(grown.lastEntryId, "b");
        assert.equal(grown.localLive, false);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("截断：无 writer 判 reset，有 writer 判 externalRewrite", async () => {
  const { dir, path } = makeSessionFile([entry("a"), entry("b", "a")]);
  try {
    let writerActive = false;
    await withPatchedService(
      {
        resolvePath: async () => path,
        getLive: () => undefined,
        isLockedByOther: () => writerActive,
      },
      async () => {
        const baseline = await (await call("s2")).json();
        writeFileSync(path, `${JSON.stringify(entry("a"))}\n`);
        const reset = await (
          await call("s2", `?offset=${baseline.size}&ino=${baseline.ino}`)
        ).json();
        assert.equal(reset.reset, true);
        assert.equal(reset.externalRewrite, false);

        writeFileSync(path, '{"type":');
        writerActive = true;
        const external = await (
          await call("s2", `?offset=${baseline.size}&ino=${baseline.ino}`)
        ).json();
        assert.equal(external.reset, false, "writer 活着时不能静默采纳外部改写");
        assert.equal(external.externalRewrite, true);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("本进程有 live host 时回报 localLive（客户端据此让 SSE 独占）", async () => {
  const { dir, path } = makeSessionFile([entry("a")]);
  try {
    await withPatchedService(
      {
        resolvePath: async () => path,
        getLive: () => ({ isAlive: () => true }),
        isLockedByOther: () => false,
      },
      async () => {
        const body = await (await call("s3")).json();
        assert.equal(body.localLive, true);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
