/**
 * 附件兜底回收：只删「没有任何引用 + 超过保留期」的文件。
 *
 * 关键不是删得干净，而是**不删错**：偏好文件损坏、会话文件读不出来时必须整体放弃。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const gc = await jiti.import("./attachment-gc.ts");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 31, 12, 0, 0);

function makeAgentDir() {
  const agentDir = mkdtempSync(join(tmpdir(), "pidance-gc-"));
  mkdirSync(join(agentDir, "sessions", "--proj--"), { recursive: true });
  return agentDir;
}

function writeAttachment(agentDir, name, mtimeMs = NOW - 40 * DAY, bytes = "bytes") {
  const dir = join(agentDir, "pidance-attachments");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, bytes);
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  return path;
}

function writeSession(agentDir, name, content) {
  const path = join(agentDir, "sessions", "--proj--", name);
  writeFileSync(path, content);
  return path;
}

function writePrefs(agentDir, prefs) {
  writeFileSync(join(agentDir, "pidance-preferences.json"), JSON.stringify(prefs));
}

test("GC：删除无人引用且过期的文件，保留被会话引用的文件", () => {
  const agentDir = makeAgentDir();
  try {
    const referenced = writeAttachment(agentDir, "referenced.png");
    const orphan = writeAttachment(agentDir, "orphan.png");
    const fresh = writeAttachment(agentDir, "fresh.png", NOW - 1 * DAY);
    writeSession(agentDir, "s1.jsonl", `{"path":"${referenced}","type":"pidance-binary"}\n`);
    writePrefs(agentDir, {});

    const result = gc.sweepUnreferencedAttachments({ agentDir, now: NOW });
    assert.equal(result.complete, true);
    assert.equal(result.deleted, 1);
    assert.equal(existsSync(referenced), true, "会话 JSONL 引用的原图必须保留");
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(fresh), true, "没过保留期的不动（给在途输入框留窗口）");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("GC：偏好文件里的队列/草稿引用（含嵌套）也算引用", () => {
  const agentDir = makeAgentDir();
  try {
    const queued = writeAttachment(agentDir, "queued-model.png");
    const draftOriginal = writeAttachment(agentDir, "draft-original.png");
    const draftPreview = writeAttachment(agentDir, "draft-preview.png");
    const orphan = writeAttachment(agentDir, "orphan.png");
    writePrefs(agentDir, {
      sessionQueue: {
        "sess-1": { items: [{ text: "hi", images: [{ role: "model", path: queued }] }] },
      },
      drafts: {
        "sess-1": { value: "x", images: [{ mimeType: "image/png", original: { path: draftOriginal, previewPath: draftPreview } }] },
      },
    });

    const result = gc.sweepUnreferencedAttachments({ agentDir, now: NOW });
    assert.equal(result.deleted, 1);
    for (const kept of [queued, draftOriginal, draftPreview]) {
      assert.equal(existsSync(kept), true, `${kept} 必须保留`);
    }
    assert.equal(existsSync(orphan), false);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("GC：偏好文件损坏时整体放弃（一个文件都不删）", () => {
  const agentDir = makeAgentDir();
  try {
    const orphan = writeAttachment(agentDir, "orphan.png");
    writeFileSync(join(agentDir, "pidance-preferences.json"), "{ not json");

    const result = gc.sweepUnreferencedAttachments({ agentDir, now: NOW });
    assert.equal(result.complete, false);
    assert.equal(result.deleted, 0);
    assert.equal(existsSync(orphan), true, "引用集合不完整时必须留文件");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("GC：没有过期候选时不读会话（快路径）", () => {
  const agentDir = makeAgentDir();
  try {
    const fresh = writeAttachment(agentDir, "fresh.png", NOW - 1 * DAY);
    const result = gc.sweepUnreferencedAttachments({ agentDir, now: NOW });
    assert.equal(result.candidates, 0);
    assert.equal(result.deleted, 0);
    assert.equal(existsSync(fresh), true);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("GC：子目录（遗留 queue-outbox）里的文件同样按引用与保留期处理", () => {
  const agentDir = makeAgentDir();
  try {
    const nestedDir = join(agentDir, "pidance-attachments", "queue-outbox", "sess-1");
    mkdirSync(nestedDir, { recursive: true });
    const nested = join(nestedDir, "old.png");
    writeFileSync(nested, "old");
    utimesSync(nested, (NOW - 40 * DAY) / 1000, (NOW - 40 * DAY) / 1000);
    writePrefs(agentDir, {});

    const result = gc.sweepUnreferencedAttachments({ agentDir, now: NOW });
    assert.equal(result.deleted, 1);
    assert.equal(existsSync(nested), false);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("F6：JSONL 引用的文件名带空格/中文/引号/括号时不得被误删", () => {
  const agentDir = makeAgentDir();
  try {
    const names = [
      "screen shot.png",
      "截图 2026-09-17.png",
      'quote"and\\slash.png',
      "paren(1) [2].png",
      "comma,separated.png",
    ];
    const paths = names.map((name) => writeAttachment(agentDir, name));
    // 真实 JSONL 形状：binaryBlocks 里的 path 字段（历史消息引用）。
    for (const [index, path] of paths.entries()) {
      writeSession(
        agentDir,
        `s${index}.jsonl`,
        `${JSON.stringify({ type: "message", binaryBlocks: [{ path, type: "pidance-binary" }] })}\n`,
      );
    }
    // 还嵌在正文文本里的一张图（路径出现在字符串内部）。
    const inline = writeAttachment(agentDir, "inline in text.png");
    writeSession(
      agentDir,
      "s-inline.jsonl",
      `${JSON.stringify({ type: "message", text: `see ${inline} for the screenshot` })}\n`,
    );
    const orphan = writeAttachment(agentDir, "orphan.png");
    writePrefs(agentDir, {});

    const result = gc.sweepUnreferencedAttachments({ agentDir, now: NOW });
    assert.equal(result.complete, true);
    for (const kept of [...paths, inline]) {
      assert.equal(existsSync(kept), true, `${kept} 必须保留`);
    }
    assert.equal(existsSync(orphan), false, "真正无人引用的仍要删");
    assert.equal(result.deleted, 1);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("F6：半截行里已经写下的路径仍保护对应文件（子串搜索不依赖完整 JSON）", () => {
  const agentDir = makeAgentDir();
  try {
    // 崩溃残留：完整路径已写入磁盘，但这一行 JSON 没写完。
    const truncated = writeAttachment(agentDir, "truncated half line.png");
    const orphan = writeAttachment(agentDir, "orphan.png");
    writeSession(agentDir, "broken.jsonl", `{"path":"${truncated}"`);
    writePrefs(agentDir, {});

    const result = gc.sweepUnreferencedAttachments({ agentDir, now: NOW });
    assert.equal(result.deleted, 1);
    assert.equal(existsSync(truncated), true, "行里已写下的路径必须保护该文件");
    assert.equal(existsSync(orphan), false);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
