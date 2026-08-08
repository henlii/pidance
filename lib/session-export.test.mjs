import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createJiti as createJitiForSession } from "jiti";
const _jitiSession = createJitiForSession(import.meta.url);
/** @type {typeof import("./session-file.ts")} */
const { openSessionFile, SessionFile } = await _jitiSession.import("./session-file.ts");

const jiti = createJiti(import.meta.url);

/** @returns {Promise<typeof import("./session-export.ts")>} */
async function load() {
  return jiti.import("./session-export.ts");
}

/**
 * @param {Array<Record<string, unknown> & { id: string; parentId?: string | null }>} entries
 * @param {{ sessionId?: string; cwd?: string; leafId?: string | null }} [opts]
 */
function fakeSource(entries, opts = {}) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return {
    getSessionId: () => opts.sessionId ?? "sess-export-1",
    getCwd: () => opts.cwd ?? "/tmp/project",
    getEntry: (id) => byId.get(id),
    getBranch: (fromId) => {
      const startId = fromId ?? opts.leafId ?? entries.at(-1)?.id;
      const pathEntries = [];
      let current = startId ? byId.get(startId) : undefined;
      while (current) {
        pathEntries.push(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      pathEntries.reverse();
      return pathEntries;
    },
  };
}

/** 分叉 fixture：root → a → leafA；root → a → b → leafB */
function branchedEntries() {
  return [
    {
      type: "model_change",
      id: "root",
      parentId: null,
      provider: "test",
      modelId: "m1",
      timestamp: "2026-01-01T00:00:00.000Z",
    },
    {
      type: "message",
      id: "a",
      parentId: "root",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: "hello", timestamp: 1 },
    },
    {
      type: "message",
      id: "leafA",
      parentId: "a",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "branch A" }],
        timestamp: 2,
      },
    },
    {
      type: "thinking_level_change",
      id: "b",
      parentId: "a",
      thinkingLevel: "high",
      timestamp: "2026-01-01T00:00:03.000Z",
    },
    {
      type: "message",
      id: "leafB",
      parentId: "b",
      timestamp: "2026-01-01T00:00:04.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "branch B" }],
        timestamp: 4,
      },
      extraField: { keep: true },
    },
  ];
}

function parseJsonl(text) {
  assert.ok(text.endsWith("\n"), "JSONL 必须以换行结束");
  return text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("parseExportFormat 默认 html、jsonl、未知", async () => {
  const { parseExportFormat } = await load();
  assert.equal(parseExportFormat(null), "html");
  assert.equal(parseExportFormat(""), "html");
  assert.equal(parseExportFormat("jsonl"), "jsonl");
  assert.equal(parseExportFormat("JSONL"), null);
  assert.equal(parseExportFormat("html"), null);
  assert.equal(parseExportFormat("xml"), null);
});

test("空会话允许 header-only", async () => {
  const { buildSessionBranchJsonl } = await load();
  const fixed = new Date("2026-07-27T12:00:00.000Z");
  const text = buildSessionBranchJsonl(fakeSource([], { leafId: null }), {
    now: () => fixed,
  });
  const lines = parseJsonl(text);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], {
    type: "session",
    version: 3,
    id: "sess-export-1",
    timestamp: "2026-07-27T12:00:00.000Z",
    cwd: "/tmp/project",
  });
});

test("分叉两个 leaf 各自只含 root→leaf，parentId 线性重链且字段保留", async () => {
  const { buildSessionBranchJsonl } = await load();
  const entries = branchedEntries();
  const source = fakeSource(entries, { leafId: "leafB" });
  const fixed = new Date("2026-07-27T12:00:00.000Z");

  const exportA = parseJsonl(
    buildSessionBranchJsonl(source, { leafId: "leafA", now: () => fixed }),
  );
  const exportB = parseJsonl(
    buildSessionBranchJsonl(source, { leafId: "leafB", now: () => fixed }),
  );

  assert.deepEqual(
    exportA.slice(1).map((e) => e.id),
    ["root", "a", "leafA"],
  );
  assert.deepEqual(
    exportB.slice(1).map((e) => e.id),
    ["root", "a", "b", "leafB"],
  );

  // parentId 线性有效：null → id0 → id1 ...
  for (const branch of [exportA, exportB]) {
    let prev = null;
    for (const entry of branch.slice(1)) {
      assert.equal(entry.parentId, prev);
      prev = entry.id;
    }
  }

  // 不包含另一分支节点
  assert.ok(!exportA.some((e) => e.id === "leafB" || e.id === "b"));
  assert.ok(!exportB.some((e) => e.id === "leafA"));

  // 原字段保留（除 parentId 重链）
  const leafB = exportB.find((e) => e.id === "leafB");
  assert.equal(leafB.type, "message");
  assert.deepEqual(leafB.extraField, { keep: true });
  assert.equal(leafB.message.content[0].text, "branch B");
  assert.equal(leafB.timestamp, "2026-01-01T00:00:04.000Z");

  const thinking = exportB.find((e) => e.id === "b");
  assert.equal(thinking.type, "thinking_level_change");
  assert.equal(thinking.thinkingLevel, "high");
});

test("省略 leafId 时用源当前 leaf", async () => {
  const { buildSessionBranchJsonl } = await load();
  const source = fakeSource(branchedEntries(), { leafId: "leafA" });
  const ids = parseJsonl(buildSessionBranchJsonl(source))
    .slice(1)
    .map((e) => e.id);
  assert.deepEqual(ids, ["root", "a", "leafA"]);
});

test("空字符串 leafId 按省略处理", async () => {
  const { buildSessionBranchJsonl } = await load();
  const source = fakeSource(branchedEntries(), { leafId: "leafB" });
  const withEmpty = parseJsonl(
    buildSessionBranchJsonl(source, { leafId: "" }),
  )
    .slice(1)
    .map((e) => e.id);
  const withNull = parseJsonl(
    buildSessionBranchJsonl(source, { leafId: null }),
  )
    .slice(1)
    .map((e) => e.id);
  assert.deepEqual(withEmpty, ["root", "a", "b", "leafB"]);
  assert.deepEqual(withNull, ["root", "a", "b", "leafB"]);
});

test("显式非法 leaf 拒绝", async () => {
  const { buildSessionBranchJsonl, SessionExportError } = await load();
  const source = fakeSource(branchedEntries());
  assert.throws(
    () => buildSessionBranchJsonl(source, { leafId: "missing-leaf" }),
    (err) => {
      assert.ok(err instanceof SessionExportError);
      assert.equal(err.code, "bad-request");
      assert.match(err.message, /Invalid leafId/);
      return true;
    },
  );
});

test("写入临时 jsonl 后可被 SessionFile.open 再打开", async () => {
  const { buildSessionBranchJsonl, exportSessionFileToJsonl } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pidance-export-"));
  try {
    // 用自有 SessionFile 建持久化会话并分叉
    const sm = SessionFile.create(dir, dir);
    const sessionFile = sm.getSessionFile();
    assert.ok(sessionFile);

    const rootId = sm.appendModelChange("test", "model-a");
    const userId = sm.appendMessage({
      role: "user",
      content: "u1",
      timestamp: Date.now(),
    });
    const leafA = sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "A" }],
      api: "test",
      provider: "test",
      model: "model-a",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    sm.branch(userId);
    const leafB = sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "B" }],
      api: "test",
      provider: "test",
      model: "model-a",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const before = fs.statSync(sessionFile);
    const contentBefore = fs.readFileSync(sessionFile);

    const jsonlA = exportSessionFileToJsonl(sessionFile, { leafId: leafA });
    const jsonlB = exportSessionFileToJsonl(sessionFile, { leafId: leafB });

    // 源文件不变
    const after = fs.statSync(sessionFile);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.size, before.size);
    assert.deepEqual(fs.readFileSync(sessionFile), contentBefore);

    const outA = path.join(dir, "export-a.jsonl");
    const outB = path.join(dir, "export-b.jsonl");
    fs.writeFileSync(outA, jsonlA, "utf8");
    fs.writeFileSync(outB, jsonlB, "utf8");

    const reA = openSessionFile(outA);
    const reB = openSessionFile(outB);
    assert.deepEqual(
      reA.getBranch().map((e) => e.id),
      [rootId, userId, leafA],
    );
    assert.deepEqual(
      reB.getBranch().map((e) => e.id),
      [rootId, userId, leafB],
    );

    // 纯函数路径与文件路径一致
    const pure = buildSessionBranchJsonl(openSessionFile(sessionFile), {
      leafId: leafA,
      now: () => new Date("2020-01-01T00:00:00.000Z"),
    });
    const fromFile = exportSessionFileToJsonl(sessionFile, {
      leafId: leafA,
      now: () => new Date("2020-01-01T00:00:00.000Z"),
    });
    assert.equal(pure, fromFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getExportJsonlFileName 与 JSONL MIME 常量", async () => {
  const { getExportJsonlFileName, JSONL_EXPORT_CONTENT_TYPE } = await load();
  assert.equal(
    getExportJsonlFileName("/x/2026-01-01_uuid.jsonl"),
    "pi-session-2026-01-01_uuid.jsonl",
  );
  assert.equal(JSONL_EXPORT_CONTENT_TYPE, "application/x-ndjson; charset=utf-8");
});

test("路由 format 未知 400、jsonl 非法 leaf 400、缺失会话 404、成功响应头与只读", async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const jitiRoute = createJiti(import.meta.url, {
    alias: { "@": root },
  });
  const { cacheSessionPath, invalidateSessionPathCache } = await jitiRoute.import(
    path.join(root, "lib/session-reader.ts"),
  );
  const { GET } = await jitiRoute.import(
    path.join(root, "app/api/sessions/[id]/export/route.ts"),
  );
  const {
    getExportJsonlFileName,
    JSONL_EXPORT_CONTENT_TYPE,
  } = await load();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pidance-export-route-"));
  let sessionId = "";
  try {
    const sm = SessionFile.create(dir, dir);
    const sessionFile = sm.getSessionFile();
    assert.ok(sessionFile);
    sessionId = sm.getSessionId();

    sm.appendModelChange("test", "model-a");
    sm.appendMessage({
      role: "user",
      content: "u1",
      timestamp: Date.now(),
    });
    const leafId = sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "A" }],
      api: "test",
      provider: "test",
      model: "model-a",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    cacheSessionPath(sessionId, sessionFile);
    const before = fs.statSync(sessionFile);
    const contentBefore = fs.readFileSync(sessionFile);
    const params = { params: Promise.resolve({ id: sessionId }) };

    const unknown = await GET(
      new Request(
        `http://localhost/api/sessions/${sessionId}/export?format=yaml`,
      ),
      params,
    );
    assert.equal(unknown.status, 400);
    assert.deepEqual(await unknown.json(), { error: "Unknown export format" });

    const missing = await GET(
      new Request(
        "http://localhost/api/sessions/no-such-export-session/export?format=jsonl",
      ),
      { params: Promise.resolve({ id: "no-such-export-session" }) },
    );
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "Session not found" });

    const badLeaf = await GET(
      new Request(
        `http://localhost/api/sessions/${sessionId}/export?format=jsonl&leafId=missing-leaf`,
      ),
      params,
    );
    assert.equal(badLeaf.status, 400);
    assert.deepEqual(await badLeaf.json(), {
      error: "Invalid leafId: missing-leaf",
    });

    const ok = await GET(
      new Request(
        `http://localhost/api/sessions/${sessionId}/export?format=jsonl&leafId=${encodeURIComponent(leafId)}`,
      ),
      params,
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), JSONL_EXPORT_CONTENT_TYPE);
    assert.equal(ok.headers.get("cache-control"), "no-cache");
    const disposition = ok.headers.get("content-disposition") ?? "";
    assert.match(disposition, /^attachment;/);
    assert.ok(disposition.includes(getExportJsonlFileName(sessionFile)));

    const body = await ok.text();
    const lines = parseJsonl(body);
    assert.equal(lines[0].type, "session");
    assert.equal(lines[0].id, sessionId);
    assert.ok(lines.some((e) => e.id === leafId));

    // 空 leafId 按省略：当前 leaf 可导出
    const omitLeaf = await GET(
      new Request(
        `http://localhost/api/sessions/${sessionId}/export?format=jsonl&leafId=`,
      ),
      params,
    );
    assert.equal(omitLeaf.status, 200);
    assert.ok((await omitLeaf.text()).includes(leafId));

    // 源文件内容 / mtime / size 不变
    const after = fs.statSync(sessionFile);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.size, before.size);
    assert.deepEqual(fs.readFileSync(sessionFile), contentBefore);
  } finally {
    if (sessionId) invalidateSessionPathCache(sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
