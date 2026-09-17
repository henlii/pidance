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
