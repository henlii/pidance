/**
 * 归档服务层测试（P0-2）。
 *
 * 覆盖（规格 7.2 A1/A4/A5/A6/A7）：
 * - sidecar 原子写 + 读回一致
 * - 损坏/超限/symlink/非法文件名安全跳过（不 500）
 * - running 会话归档拒绝（409 语义）
 * - readOnly subagent 拒绝
 * - header id 不一致拒绝
 * - 批量动作部分失败不回滚
 * - scope 分区（active/archived；path 不一致的失效记录不隐藏正常 active）
 * - 恢复删除 sidecar 并确认、返回恢复后的 SessionInfo
 * - 永久删除后清理 sidecar 幂等
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);
const mod = await jiti.import("./session-archive.ts");

const AGENT_DIR = "/agent";

// ── 内存 fake fs（目录/文件分离；rename = 移动；unlink = 删除） ─────────────
function createMemoryFs() {
  const files = new Map();
  const dirs = new Set();
  return {
    files,
    dirs,
    existsSync: (p) => files.has(p) || dirs.has(p),
    lstatSync: (p) => ({
      isDirectory: () => dirs.has(p),
      isSymbolicLink: () => false,
    }),
    mkdirSync: (p) => {
      dirs.add(p);
    },
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p);
    },
    writeFileSync: (p, data) => {
      files.set(p, data);
      dirs.add(p.split("/").slice(0, -1).join("/"));
    },
    renameSync: (a, b) => {
      if (!files.has(a)) throw new Error(`ENOENT: ${a}`);
      files.set(b, files.get(a));
      files.delete(a);
    },
    unlinkSync: (p) => {
      files.delete(p);
    },
    readdirSync: (p) => {
      const prefix = `${p}/`;
      const names = new Set();
      for (const k of files.keys()) {
        if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split("/")[0]);
      }
      for (const d of dirs) {
        if (d.startsWith(prefix) && d !== p) names.add(d.slice(prefix.length).split("/")[0]);
      }
      return [...names];
    },
  };
}

const SESSION_PATH = "/agent/sessions/proj/a1b2c3d4e5f6a7b8.jsonl";
const SESSION_INFO = {
  id: "a1b2c3d4e5f6a7b8",
  path: SESSION_PATH,
  cwd: "/agent/sessions/proj",
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-02T00:00:00.000Z",
  messageCount: 2,
  firstMessage: "hi",
  projectRoot: "/agent/sessions/proj",
};

function makeDeps(overrides = {}) {
  const calls = { invalidated: 0 };
  const fs = createMemoryFs();
  return {
    calls,
    fs,
    deps: {
      fs,
      agentDir: () => AGENT_DIR,
      resolveSessionPath: async (id) => (id === "a1b2c3d4e5f6a7b8" ? SESSION_PATH : null),
      readSessionHeader: (path) =>
        path === SESSION_PATH ? { type: "session", id: "a1b2c3d4e5f6a7b8", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/agent/sessions/proj" } : null,
      isReadOnly: async () => false,
      isRunning: () => false,
      getSessionInfo: async (id) => (id === "a1b2c3d4e5f6a7b8" ? { ...SESSION_INFO } : null),
      invalidateSessionListCache: () => {
        calls.invalidated += 1;
      },
      now: () => "2026-08-06T12:00:00.000Z",
      ...overrides,
    },
  };
}

function build(overrides = {}) {
  const { deps, calls, fs } = makeDeps(overrides);
  const actions = mod.createArchiveActions(deps);
  return { actions, calls, fs };
}

test("archiveSession：原子写 sidecar、返回 archivedAt、失效列表缓存", async () => {
  const { actions, calls, fs } = build();
  const archivedAt = await actions.archiveSession("a1b2c3d4e5f6a7b8");

  assert.equal(archivedAt, "2026-08-06T12:00:00.000Z");
  assert.equal(calls.invalidated, 1);
  // 记录可读回且字段完整
  const record = mod.readArchiveRecord(fs, AGENT_DIR, "a1b2c3d4e5f6a7b8");
  assert.deepEqual(record, {
    version: 1,
    sessionId: "a1b2c3d4e5f6a7b8",
    sessionPath: SESSION_PATH,
    archivedAt: "2026-08-06T12:00:00.000Z",
  });
  // 无残留临时文件（同目录原子写）
  const names = fs.readdirSync(`${AGENT_DIR}/pidance-archive`);
  assert.deepEqual(names, ["a1b2c3d4e5f6a7b8.json"]);
});

test("archiveSession：running 会话拒绝（409 语义），不 abort 不写盘", async () => {
  const { actions, fs } = build({ isRunning: () => true });
  await assert.rejects(() => actions.archiveSession("a1b2c3d4e5f6a7b8"), mod.ArchiveConflictError);
  assert.equal(mod.readArchiveRecord(fs, AGENT_DIR, "a1b2c3d4e5f6a7b8"), null);
});

test("archiveSession：只读 subagent 拒绝", async () => {
  const { actions, fs } = build({ isReadOnly: async () => true });
  await assert.rejects(() => actions.archiveSession("a1b2c3d4e5f6a7b8"), /read-only/i);
  assert.equal(mod.readArchiveRecord(fs, AGENT_DIR, "a1b2c3d4e5f6a7b8"), null);
});

test("archiveSession：会话不存在 / header id 不一致拒绝", async () => {
  const { actions } = build();
  await assert.rejects(() => actions.archiveSession("missing"), /Session not found/);
  // header id 与请求 id 不一致（override 返回其它 id）
  const { actions: mismatch } = build({
    readSessionHeader: () => ({ type: "session", id: "other-id", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/x" }),
  });
  await assert.rejects(
    () => mismatch.archiveSession("a1b2c3d4e5f6a7b8"),
    /header id mismatch/,
  );
});

test("archiveSession：header id 不一致时不写盘", async () => {
  const { actions, fs } = build({
    readSessionHeader: () => ({ type: "session", id: "other", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/x" }),
  });
  await assert.rejects(() => actions.archiveSession("a1b2c3d4e5f6a7b8"), /header id mismatch/);
  assert.equal(mod.readArchiveRecord(fs, AGENT_DIR, "a1b2c3d4e5f6a7b8"), null);
});

test("restoreSession：删除 sidecar 并确认、返回恢复后的 SessionInfo、失效缓存", async () => {
  const { actions, calls, fs } = build();
  await actions.archiveSession("a1b2c3d4e5f6a7b8");
  const restored = await actions.restoreSession("a1b2c3d4e5f6a7b8");

  assert.equal(calls.invalidated, 2);
  assert.equal(restored?.id, "a1b2c3d4e5f6a7b8");
  assert.equal(restored.archivedAt, undefined, "恢复后的 SessionInfo 不应带 archivedAt");
  assert.equal(mod.readArchiveRecord(fs, AGENT_DIR, "a1b2c3d4e5f6a7b8"), null, "sidecar 已删除");
  assert.equal(fs.existsSync(`${AGENT_DIR}/pidance-archive/a1b2c3d4e5f6a7b8.json`), false);
});

test("restoreSession：未归档会话拒绝", async () => {
  const { actions } = build();
  await assert.rejects(() => actions.restoreSession("a1b2c3d4e5f6a7b8"), /Session is not archived/);
});

test("批量动作：单条失败不回滚已成功条目", async () => {
  const { actions, fs } = build({
    resolveSessionPath: async (id) => (id === "a1b2c3d4e5f6a7b8" ? SESSION_PATH : null),
  });
  const result = await actions.archiveSessions(["a1b2c3d4e5f6a7b8", "ghost", "a1b2c3d4e5f6a7b8"]);
  assert.deepEqual(result.succeededIds, ["a1b2c3d4e5f6a7b8", "a1b2c3d4e5f6a7b8"]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, "ghost");
  assert.match(result.failed[0].error, /Session not found/);
  // 成功条目 sidecar 已写入；失败条目无记录
  assert.equal(mod.readArchiveRecord(fs, AGENT_DIR, "a1b2c3d4e5f6a7b8").sessionId, "a1b2c3d4e5f6a7b8");
  assert.equal(mod.readArchiveRecord(fs, AGENT_DIR, "ghost"), null);

  const restored = await actions.restoreSessions(["a1b2c3d4e5f6a7b8", "ghost"]);
  assert.deepEqual(restored.succeededIds, ["a1b2c3d4e5f6a7b8"]);
  assert.equal(restored.failed.length, 1);
  assert.equal(restored.failed[0].id, "ghost");
});

test("partitionSessionsByArchiveState：active/archived 分区 + 失效记录不隐藏 active", () => {
  const records = [
    { version: 1, sessionId: "a1b2c3d4e5f6a7b8", sessionPath: SESSION_PATH, archivedAt: "2026-08-06T12:00:00.000Z" },
    { version: 1, sessionId: "s2", sessionPath: "/agent/sessions/proj/old-s2.jsonl", archivedAt: "2026-08-05T12:00:00.000Z" },
  ];
  const sessions = [
    { ...SESSION_INFO, id: "a1b2c3d4e5f6a7b8" },
    { ...SESSION_INFO, id: "s2", path: "/agent/sessions/proj/new-s2.jsonl" },
    { ...SESSION_INFO, id: "s3" },
  ];
  const { active, archived } = mod.partitionSessionsByArchiveState(sessions, records);
  assert.deepEqual(active.map((s) => s.id), ["s2", "s3"], "path 不一致的记录不归档 s2（不隐藏正常 active）");
  assert.deepEqual(archived.map((s) => s.id), ["a1b2c3d4e5f6a7b8"]);
  assert.equal(archived[0].archivedAt, "2026-08-06T12:00:00.000Z");
});

test("统一归档判定：stale sidecar（path 不符）列表/active 搜索/archived 搜索三处一致为 active", () => {
  // sidecar 存在但 sessionPath 与真实会话 path 不符（会话移动/重建后未清理）
  const records = [
    { version: 1, sessionId: "a1b2c3d4e5f6a7b8", sessionPath: "/agent/sessions/proj/old-location.jsonl", archivedAt: "2026-08-06T12:00:00.000Z" },
  ];
  const sessions = [{ ...SESSION_INFO }]; // path 为 SESSION_PATH，与记录不符
  // 列表投影：视为 active，不隐藏
  const { active, archived } = mod.partitionSessionsByArchiveState(sessions, records);
  assert.deepEqual(active.map((s) => s.id), ["a1b2c3d4e5f6a7b8"]);
  assert.deepEqual(archived.map((s) => s.id), []);
  // 搜索投影：active 可见、archived 不可见（与列表一致）
  const keptActive = mod.filterSessionIdsByArchiveScope(["a1b2c3d4e5f6a7b8"], sessions, records, "active");
  const keptArchived = mod.filterSessionIdsByArchiveScope(["a1b2c3d4e5f6a7b8"], sessions, records, "archived");
  assert.equal(keptActive.has("a1b2c3d4e5f6a7b8"), true);
  assert.equal(keptArchived.has("a1b2c3d4e5f6a7b8"), false);
});

test("统一归档判定：正常归档三处一致为 archived", () => {
  const records = [
    { version: 1, sessionId: "a1b2c3d4e5f6a7b8", sessionPath: SESSION_PATH, archivedAt: "2026-08-06T12:00:00.000Z" },
  ];
  const sessions = [{ ...SESSION_INFO }];
  const { active, archived } = mod.partitionSessionsByArchiveState(sessions, records);
  assert.deepEqual(active.map((s) => s.id), []);
  assert.deepEqual(archived.map((s) => s.id), ["a1b2c3d4e5f6a7b8"]);
  assert.equal(archived[0].archivedAt, "2026-08-06T12:00:00.000Z");
  const keptActive = mod.filterSessionIdsByArchiveScope(["a1b2c3d4e5f6a7b8"], sessions, records, "active");
  const keptArchived = mod.filterSessionIdsByArchiveScope(["a1b2c3d4e5f6a7b8"], sessions, records, "archived");
  assert.equal(keptActive.has("a1b2c3d4e5f6a7b8"), false);
  assert.equal(keptArchived.has("a1b2c3d4e5f6a7b8"), true);
});

test("统一归档判定：恢复（记录删除）后三处一致为 active", () => {
  const records = [];
  const sessions = [{ ...SESSION_INFO }];
  const { active, archived } = mod.partitionSessionsByArchiveState(sessions, records);
  assert.deepEqual(active.map((s) => s.id), ["a1b2c3d4e5f6a7b8"]);
  assert.deepEqual(archived.map((s) => s.id), []);
  const keptActive = mod.filterSessionIdsByArchiveScope(["a1b2c3d4e5f6a7b8"], sessions, records, "active");
  const keptArchived = mod.filterSessionIdsByArchiveScope(["a1b2c3d4e5f6a7b8"], sessions, records, "archived");
  assert.equal(keptActive.has("a1b2c3d4e5f6a7b8"), true);
  assert.equal(keptArchived.has("a1b2c3d4e5f6a7b8"), false);
});

test("统一归档判定：候选 id 不在真实会话列表（索引孤儿）视为 active 不隐藏", () => {
  const records = [
    { version: 1, sessionId: "ghost", sessionPath: "/x/ghost.jsonl", archivedAt: "2026-08-06T12:00:00.000Z" },
  ];
  const sessions = [{ ...SESSION_INFO }];
  const keptActive = mod.filterSessionIdsByArchiveScope(["ghost"], sessions, records, "active");
  const keptArchived = mod.filterSessionIdsByArchiveScope(["ghost"], sessions, records, "archived");
  assert.equal(keptActive.has("ghost"), true, "孤儿索引条目不隐藏（视为 active）");
  assert.equal(keptArchived.has("ghost"), false);
});

test("search route：归档过滤走权威 (id, path) 判定，不直接 map sidecar sessionId", () => {
  const searchRouteSource = readFileSync(
    join(here, "..", "app", "api", "sessions", "search", "route.ts"),
    "utf8",
  );
  const serviceSource = readFileSync(
    join(here, "session-service.ts"),
    "utf8",
  );
  assert.match(searchRouteSource, /sessionService\.searchFulltext/);
  assert.doesNotMatch(searchRouteSource, /from "@\/lib\/pi-paths"/);
  assert.doesNotMatch(searchRouteSource, /from "@\/lib\/session-archive"/);
  assert.match(serviceSource, /filterSessionIdsByArchiveScope/);
  assert.match(serviceSource, /searchFulltext/);
  assert.doesNotMatch(searchRouteSource, /listArchiveRecords\([^)]*\)\.map\(/);
  assert.doesNotMatch(searchRouteSource, /archivedIds\.has/);
});

test("listArchiveRecords：损坏/超限/symlink/非法文件名安全跳过，不 500", () => {
  const fs = createMemoryFs();
  const dir = `${AGENT_DIR}/pidance-archive`;
  fs.mkdirSync(dir);
  const valid = { version: 1, sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", sessionPath: "/x/a.jsonl", archivedAt: "2026-08-06T12:00:00.000Z" };
  fs.writeFileSync(`${dir}/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json`, JSON.stringify(valid));
  fs.writeFileSync(`${dir}/broken.json`, "not-json{{{"); // 损坏
  fs.writeFileSync(`${dir}/../escape.json`, JSON.stringify(valid)); // 无法创建但忽略
  fs.writeFileSync(`${dir}/toolong-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json`, JSON.stringify(valid)); // 超长文件名
  fs.writeFileSync(`${dir}/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.json`, "x".repeat(mod.ARCHIVE_RECORD_MAX_BYTES + 1)); // 超限内容
  fs.writeFileSync(`${dir}/cccccccc-cccc-cccc-cccc-cccccccccccc.json`, JSON.stringify({ ...valid, version: 99 })); // 版本非法
  fs.writeFileSync(`${dir}/dddddddd-dddd-dddd-dddd-dddddddddddd.json`, JSON.stringify({ ...valid, sessionId: "different-id" })); // id 不匹配
  fs.writeFileSync(`${dir}/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee.json`, JSON.stringify(valid));
  // symlink 跳过：手工把该文件标记为 symlink
  const originalLstat = fs.lstatSync.bind(fs);
  fs.lstatSync = (p) => {
    if (p.endsWith("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee.json")) {
      return { isDirectory: () => false, isSymbolicLink: () => true };
    }
    return originalLstat(p);
  };

  const records = mod.listArchiveRecords(fs, AGENT_DIR);
  assert.deepEqual(records.map((r) => r.sessionId), ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]);
});

test("removeArchiveRecordAfterPermanentDelete：幂等清理 sidecar", async () => {
  const { actions, fs } = build();
  await actions.archiveSession("a1b2c3d4e5f6a7b8");
  mod.removeArchiveRecordAfterPermanentDelete(fs, AGENT_DIR, "a1b2c3d4e5f6a7b8");
  assert.equal(mod.readArchiveRecord(fs, AGENT_DIR, "a1b2c3d4e5f6a7b8"), null);
  // 幂等：再次调用不抛错
  assert.doesNotThrow(() => mod.removeArchiveRecordAfterPermanentDelete(fs, AGENT_DIR, "a1b2c3d4e5f6a7b8"));
});

test("archiveFileNameFor：非法 id 拒绝（路径穿越防护）", () => {
  assert.equal(mod.archiveFileNameFor("../../../etc/passwd"), null);
  assert.equal(mod.archiveFileNameFor(".."), null);
  assert.equal(mod.archiveFileNameFor("a"), null);
  assert.equal(mod.archiveFileNameFor("x".repeat(65)), null);
  assert.equal(mod.archiveFileNameFor("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json");
});

test("sidecar 目录 symlink 时安全降级：不写不读", () => {
  const fs = createMemoryFs();
  const dir = `${AGENT_DIR}/pidance-archive`;
  fs.mkdirSync(dir);
  const originalLstat = fs.lstatSync.bind(fs);
  fs.lstatSync = (p) => {
    if (p === dir) return { isDirectory: () => false, isSymbolicLink: () => true };
    return originalLstat(p);
  };
  assert.equal(mod.listArchiveRecords(fs, AGENT_DIR).length, 0);
  assert.throws(() =>
    mod.writeArchiveRecord(fs, AGENT_DIR, { version: 1, sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", sessionPath: "/x", archivedAt: "2026-08-06T12:00:00.000Z" }),
    /Archive directory unavailable/,
  );
});
