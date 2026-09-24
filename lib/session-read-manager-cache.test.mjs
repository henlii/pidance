import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  SESSION_READ_CACHE_LIMITS,
  invalidateSessionReadCache,
  openCachedSessionReadView,
  sessionReadCacheStats,
} = await jiti.import("./session-read-manager-cache.ts");

/** 最小合法会话文件：header + N 条 user 消息（SessionManager 能解析）。 */
function writeSessionFile(path, { id, messages = 2 }) {
  const lines = [JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/pidance-read-cache",
  })];
  let parentId = null;
  for (let i = 0; i < messages; i++) {
    const entryId = `e${i}`;
    lines.push(JSON.stringify({
      type: "message",
      id: entryId,
      parentId,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: `m${i}` },
    }));
    parentId = entryId;
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
}

function withLimits(overrides, run) {
  const previous = { ...SESSION_READ_CACHE_LIMITS };
  Object.assign(SESSION_READ_CACHE_LIMITS, overrides);
  try {
    return run();
  } finally {
    Object.assign(SESSION_READ_CACHE_LIMITS, previous);
    invalidateSessionReadCache();
  }
}

function tempSession(name, options) {
  const dir = mkdtempSync(join(tmpdir(), "pidance-read-cache-"));
  const path = join(dir, `${name}.jsonl`);
  writeSessionFile(path, options);
  return { dir, path };
}

test("同一 path 与指纹的第二次读复用同一个视图（不再重解 JSONL）", () => {
  invalidateSessionReadCache();
  const { dir, path } = tempSession("session-a", { id: "session-a", messages: 3 });
  try {
    const first = openCachedSessionReadView(path);
    const second = openCachedSessionReadView(path);
    assert.equal(first, second, "命中缓存应返回同一个对象");
    assert.equal(first.getEntries().length, 3, "3 条消息（header 不计入 entries）");
    assert.equal(sessionReadCacheStats().entries, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("正文变化（追加）后指纹失配，重新解析", () => {
  invalidateSessionReadCache();
  const { dir, path } = tempSession("session-b", { id: "session-b", messages: 2 });
  try {
    const first = openCachedSessionReadView(path);
    assert.equal(first.getEntries().length, 2);

    appendFileSync(path, `${JSON.stringify({
      type: "message",
      id: "e2",
      parentId: "e1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: "later" },
    })}\n`);

    const second = openCachedSessionReadView(path);
    assert.notEqual(second, first, "追加后必须重新解析");
    assert.equal(second.getEntries().length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("leaf sidecar 变化（正文未变）同样失效，不会返回旧 leaf", () => {
  invalidateSessionReadCache();
  const { dir, path } = tempSession("session-c", { id: "session-c", messages: 3 });
  try {
    const before = openCachedSessionReadView(path);
    assert.equal(before.getLeafId(), "e2", "无 sidecar 时 leaf = 文件末条");

    writeFileSync(`${path}.leaf.json`, JSON.stringify({ version: 1, leafId: "e0" }, null, 2));
    const after = openCachedSessionReadView(path);
    assert.notEqual(after, before, "sidecar 变化必须重新解析");
    assert.equal(after.getLeafId(), "e0", "导航到旧分支后 leaf 必须跟着 sidecar");

    unlinkSync(`${path}.leaf.json`);
    const restored = openCachedSessionReadView(path);
    assert.equal(restored.getLeafId(), "e2", "sidecar 删除后回到文件末条");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("文件被删除后不再返回缓存视图", () => {
  invalidateSessionReadCache();
  const { dir, path } = tempSession("session-d", { id: "session-d", messages: 1 });
  try {
    openCachedSessionReadView(path);
    assert.equal(sessionReadCacheStats().entries, 1);
    unlinkSync(path);
    openCachedSessionReadView(path);
    assert.equal(sessionReadCacheStats().entries, 0, "已删文件的条目必须被清掉");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("条数上界：超出后从最旧开始淘汰", () => {
  invalidateSessionReadCache();
  const first = tempSession("session-e1", { id: "session-e1", messages: 1 });
  const second = tempSession("session-e2", { id: "session-e2", messages: 1 });
  try {
    withLimits({ maxEntries: 1 }, () => {
      openCachedSessionReadView(first.path);
      const secondView = openCachedSessionReadView(second.path);
      assert.equal(sessionReadCacheStats().entries, 1, "只留最近一条");
      assert.equal(openCachedSessionReadView(second.path), secondView, "最近一条仍复用");
      const firstAgain = openCachedSessionReadView(first.path);
      assert.notEqual(firstAgain, undefined);
      assert.equal(sessionReadCacheStats().entries, 1);
    });
  } finally {
    rmSync(first.dir, { recursive: true, force: true });
    rmSync(second.dir, { recursive: true, force: true });
  }
});

test("单文件超过额度不缓存（不挤掉其它条目）", () => {
  invalidateSessionReadCache();
  const { dir, path } = tempSession("session-f", { id: "session-f", messages: 2 });
  try {
    withLimits({ maxEntryBytes: 1 }, () => {
      const view = openCachedSessionReadView(path);
      assert.equal(view.getEntries().length, 2, "仍然可用，只是不进缓存");
      assert.equal(sessionReadCacheStats().entries, 0);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalidateSessionReadCache(path) 只清指定条目", () => {
  invalidateSessionReadCache();
  const first = tempSession("session-g1", { id: "session-g1", messages: 1 });
  const second = tempSession("session-g2", { id: "session-g2", messages: 1 });
  try {
    const a = openCachedSessionReadView(first.path);
    const b = openCachedSessionReadView(second.path);
    invalidateSessionReadCache(first.path);
    assert.equal(sessionReadCacheStats().entries, 1);
    assert.notEqual(openCachedSessionReadView(first.path), a, "被清的条目重新解析");
    assert.equal(openCachedSessionReadView(second.path), b, "其它条目不受影响");
  } finally {
    rmSync(first.dir, { recursive: true, force: true });
    rmSync(second.dir, { recursive: true, force: true });
  }
});
