import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  buildFallbackFts5Query,
  buildSnippet,
  extractSearchableTextFromJsonlLine,
  normalizeFts5Query,
  normalizeFulltextQuery,
  resolveHermesSessionsDbPath,
  scanJsonlFileForQuery,
  searchSessionsFulltext,
  sessionIdFromJsonlPath,
} = await jiti.import("./session-fulltext-search.ts");

test("A2: 空查询与 FTS 查询归一化", () => {
  assert.equal(normalizeFulltextQuery("  hi  "), "hi");
  assert.equal(normalizeFts5Query("codegraph pi"), '"codegraph" "pi"');
  assert.equal(normalizeFts5Query('hello "world"'), '"hello" "world"');
  assert.equal(normalizeFts5Query("a AND b"), "a AND b");
  assert.equal(buildFallbackFts5Query("codegraph pi"), '"codegraph" OR "pi"');
  assert.equal(buildFallbackFts5Query("only"), null);
  assert.equal(buildFallbackFts5Query("a OR b"), null);
});

test("A2: 片段截取以 query 为中心", () => {
  const long = `${"x".repeat(80)}TARGET${"y".repeat(80)}`;
  const snip = buildSnippet(long, "TARGET", 10);
  assert.match(snip, /TARGET/);
  assert.ok(snip.startsWith("…"));
  assert.ok(snip.endsWith("…"));
  assert.equal(buildSnippet("short", "nope"), "short");
});

test("A2: JSONL 行解析只取 user/assistant/system 文本", () => {
  assert.deepEqual(
    extractSearchableTextFromJsonlLine(JSON.stringify({
      type: "session", id: "sid-1", version: 3, timestamp: "t", cwd: "/",
    })),
    { sessionId: "sid-1", text: "" },
  );
  const user = extractSearchableTextFromJsonlLine(JSON.stringify({
    type: "message",
    id: "m1",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { role: "user", content: "find codegraph usage" },
  }));
  assert.equal(user.role, "user");
  assert.equal(user.text, "find codegraph usage");
  assert.equal(user.messageId, "m1");

  const blocks = extractSearchableTextFromJsonlLine(JSON.stringify({
    type: "message",
    id: "m2",
    message: { role: "assistant", content: [{ type: "text", text: "答案在此" }] },
  }));
  assert.equal(blocks.text, "答案在此");

  assert.equal(extractSearchableTextFromJsonlLine("not-json"), null);
  assert.equal(extractSearchableTextFromJsonlLine(JSON.stringify({
    type: "message", message: { role: "toolResult", content: "x" },
  })), null);
});

test("A2: 从路径推断 session id", () => {
  assert.equal(
    sessionIdFromJsonlPath("/root/.pi/agent/sessions/--x--/2026-07-21T06-51-36-667Z_019f8371-bb5b-7665-a78a-7bc9855db0f2.jsonl"),
    "019f8371-bb5b-7665-a78a-7bc9855db0f2",
  );
  assert.equal(sessionIdFromJsonlPath("/tmp/nope.txt"), null);
});

test("A2: JSONL 扫描命中与字节上限", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pidance-search-"));
  try {
    const file = join(dir, "2026-07-21T00-00-00-000Z_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
    const lines = [
      JSON.stringify({ type: "session", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", version: 3, timestamp: "2026-07-21T00:00:00.000Z", cwd: "/tmp" }),
      JSON.stringify({ type: "message", id: "u1", timestamp: "2026-07-21T00:00:01.000Z", message: { role: "user", content: "hello UNIQUE_TOKEN world" } }),
      JSON.stringify({ type: "message", id: "a1", timestamp: "2026-07-21T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "no match here" }] } }),
    ];
    writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
    const hits = await scanJsonlFileForQuery(file, "UNIQUE_TOKEN");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].sessionId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    assert.match(hits[0].snippet, /UNIQUE_TOKEN/);

    // 超过 maxBytesPerFile 时跳过
    const big = join(dir, "2026-07-21T00-00-00-000Z_bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
    writeFileSync(big, "x".repeat(100), "utf8");
    const none = await scanJsonlFileForQuery(big, "x", { maxBytesPerFile: 10, snippetRadius: 8 });
    assert.deepEqual(none, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A2: resolveHermesSessionsDbPath 默认与空文件拒绝", () => {
  const dir = mkdtempSync(join(tmpdir(), "pidance-hermes-"));
  try {
    assert.equal(resolveHermesSessionsDbPath(dir), null);
    const memory = join(dir, "pi-hermes-memory");
    mkdirSync(memory);
    const empty = join(memory, "sessions.db");
    writeFileSync(empty, "", "utf8");
    assert.equal(resolveHermesSessionsDbPath(dir), null);
    writeFileSync(empty, "not-empty", "utf8");
    assert.equal(resolveHermesSessionsDbPath(dir), empty);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A2: FTS 优先返回 source=fts；DB 失败降级 jsonl", async () => {
  // FTS 成功路径（注入假 DB）
  const fakeDb = {
    prepare(sql) {
      assert.match(sql, /message_fts/);
      return {
        all(...params) {
          assert.ok(params.length >= 1);
          return [{
            session_id: "sid-fts",
            role: "user",
            content: "hello from fts INDEX_TOKEN",
            timestamp: "2026-07-25T00:00:00.000Z",
            message_id: "m9",
            snippet: "hello from fts «INDEX_TOKEN»",
          }];
        },
      };
    },
    close() {},
  };
  const fts = await searchSessionsFulltext("INDEX_TOKEN", {
    deps: {
      getAgentDir: () => "/tmp/unused",
      resolveHermesDbPath: () => "/tmp/fake.db",
      openSqliteReadonly: () => fakeDb,
      listJsonlFiles: () => { throw new Error("不应扫描 JSONL"); },
      scanJsonlFile: async () => { throw new Error("不应扫描 JSONL"); },
      existsSync: () => true,
    },
  });
  assert.equal(fts.source, "fts");
  assert.equal(fts.hits.length, 1);
  assert.equal(fts.hits[0].sessionId, "sid-fts");
  assert.deepEqual(fts.sessionIds, ["sid-fts"]);

  // DB 打开失败 → JSONL 降级
  const dir = mkdtempSync(join(tmpdir(), "pidance-fallback-"));
  try {
    const sessions = join(dir, "sessions", "--tmp--");
    mkdirSync(sessions, { recursive: true });
    const file = join(sessions, "2026-07-21T00-00-00-000Z_cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
    writeFileSync(file, [
      JSON.stringify({ type: "session", id: "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee", version: 3, timestamp: "t", cwd: "/tmp" }),
      JSON.stringify({ type: "message", id: "u", timestamp: "2026-07-21T01:00:00.000Z", message: { role: "user", content: "FALLBACK_TOKEN here" } }),
    ].join("\n") + "\n", "utf8");

    const jsonl = await searchSessionsFulltext("FALLBACK_TOKEN", {
      limits: { maxHits: 10, maxFiles: 20 },
      deps: {
        getAgentDir: () => dir,
        resolveHermesDbPath: () => null,
        openSqliteReadonly: () => null,
        listJsonlFiles: (root) => {
          assert.equal(root, join(dir, "sessions"));
          return [file];
        },
        scanJsonlFile: scanJsonlFileForQuery,
        existsSync: (p) => {
          try { return statSync(p).isDirectory() || statSync(p).isFile(); } catch { return false; }
        },
      },
    });
    assert.equal(jsonl.source, "jsonl");
    assert.equal(jsonl.hits.length, 1);
    assert.equal(jsonl.hits[0].sessionId, "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee");
    assert.match(jsonl.hits[0].snippet, /FALLBACK_TOKEN/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A2: 有界响应 — maxHits 截断", async () => {
  let calls = 0;
  const result = await searchSessionsFulltext("token", {
    limits: { maxHits: 2 },
    deps: {
      getAgentDir: () => "/tmp",
      resolveHermesDbPath: () => "/tmp/db",
      openSqliteReadonly: () => ({
        prepare() {
          return {
            all() {
              calls += 1;
              return [
                { session_id: "a", role: "user", content: "token 1", timestamp: "2026-07-02", message_id: "1", snippet: "token 1" },
                { session_id: "b", role: "user", content: "token 2", timestamp: "2026-07-01", message_id: "2", snippet: "token 2" },
                { session_id: "c", role: "user", content: "token 3", timestamp: "2026-06-01", message_id: "3", snippet: "token 3" },
              ].slice(0, 2); // SQL LIMIT 已截断
            },
          };
        },
        close() {},
      }),
      listJsonlFiles: () => [],
      scanJsonlFile: async () => [],
      existsSync: () => true,
    },
  });
  assert.equal(result.hits.length, 2);
  assert.equal(calls, 1);
});
