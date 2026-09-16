import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, existsSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const mod = await jiti.import("./chat-attachments.ts");

test("sanitizeAttachmentFileName：去掉路径与空字节", () => {
  assert.equal(mod.sanitizeAttachmentFileName("../../etc/passwd"), "passwd");
  assert.equal(mod.sanitizeAttachmentFileName("a\\b\\c.txt"), "c.txt");
  assert.equal(mod.sanitizeAttachmentFileName(""), "file");
  assert.equal(mod.sanitizeAttachmentFileName("..."), "file");
});

test("uniqueAttachmentFileName：含时间戳与原名且不冲突风格", () => {
  const a = mod.uniqueAttachmentFileName("report.pdf", 1_700_000_000_000);
  const b = mod.uniqueAttachmentFileName("report.pdf", 1_700_000_000_000);
  assert.match(a, /report\.pdf$/);
  assert.match(b, /report\.pdf$/);
  // 同时间戳仍靠 uuid 前缀区分
  assert.notEqual(a, b);
});

test("saveChatAttachmentBytes：写入 agentDir/pidance-attachments 并返回绝对路径", () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-att-"));
  try {
    const saved = mod.saveChatAttachmentBytes("hello.txt", Buffer.from("hello"), root);
    assert.ok(saved.path.includes("pidance-attachments"));
    assert.ok(saved.path.endsWith(saved.storedName));
    assert.equal(saved.name, "hello.txt");
    assert.equal(saved.size, 5);
    assert.equal(readFileSync(saved.path, "utf8"), "hello");
    assert.ok(existsSync(join(root, "pidance-attachments")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("getChatAttachmentsDir：路径形状", () => {
  assert.equal(mod.getChatAttachmentsDir("/tmp/agent"), "/tmp/agent/pidance-attachments");
});

test("queue outbox：保存/读取/删除/清扫，路径必须落在本会话目录内", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "queue-outbox-"));
  try {
    const ref = mod.saveQueueMediaBytes("sess-1", Buffer.from("bytes"), "image/png", "a.png", agentDir);
    assert.equal(mod.readQueueMediaBase64("sess-1", ref.path, agentDir), Buffer.from("bytes").toString("base64"));
    assert.equal(mod.isQueueMediaPath("sess-1", ref.path, agentDir), true);
    // 越界：别的会话 / outbox 之外 / 深层子目录 / 路径穿越，全部不接受。
    assert.equal(mod.isQueueMediaPath("sess-2", ref.path, agentDir), false);
    assert.equal(mod.isQueueMediaPath("sess-1", join(agentDir, "elsewhere.png"), agentDir), false);
    assert.equal(mod.isQueueMediaPath("sess-1", `${mod.getQueueOutboxDir("sess-1", agentDir)}/sub/deep.png`, agentDir), false);
    assert.equal(mod.isQueueMediaPath("sess-1", `${mod.getQueueOutboxDir("sess-1", agentDir)}/../../etc/passwd`, agentDir), false);
    assert.equal(mod.readQueueMediaBase64("sess-1", join(agentDir, "elsewhere.png"), agentDir), null);

    // 清扫：不被引用的文件删除，被引用的保留。
    const keep = mod.saveQueueMediaBytes("sess-1", Buffer.from("keep"), "image/png", "keep.png", agentDir);
    const removed = mod.sweepQueueOutbox("sess-1", [keep.path], agentDir);
    assert.equal(removed, 1);
    assert.equal(existsSync(ref.path), false);
    assert.equal(existsSync(keep.path), true);

    // 单独删除与整目录删除（会话永久删除路径）。
    mod.deleteQueueMedia("sess-1", keep.path, agentDir);
    assert.equal(existsSync(keep.path), false);
    mod.saveQueueMediaBytes("sess-1", Buffer.from("x"), "image/png", "x.png", agentDir);
    mod.removeQueueOutboxDir("sess-1", agentDir);
    assert.equal(existsSync(mod.getQueueOutboxDir("sess-1", agentDir)), false);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("queue outbox：symlink 指向 outbox 之外时必须拒绝（不能变成任意文件读取）", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "queue-outbox-link-"));
  try {
    const outbox = mod.ensureQueueOutboxDir("sess-1", agentDir);
    const outside = join(agentDir, "secret.png");
    writeFileSync(outside, "secret");
    const link = join(outbox, "linked.png");
    try {
      symlinkSync(outside, link);
    } catch {
      // Windows 无权限创建 symlink：跳过该平台，不改断其余断言。
      return;
    }
    assert.equal(mod.isQueueMediaPath("sess-1", link, agentDir), false, "symlink 伪装成 outbox 内的文件");
    assert.equal(mod.readQueueMediaBase64("sess-1", link, agentDir), null);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("queue outbox：超过大小上限的图拒绝读取（不把任意大文件读进内存）", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "queue-outbox-big-"));
  try {
    const giant = mod.saveQueueMediaBytes("sess-1", Buffer.alloc(mod.QUEUE_MEDIA_MAX_BYTES + 1), "image/png", "big.png", agentDir);
    assert.equal(mod.readQueueMediaBase64("sess-1", giant.path, agentDir), null);
    const small = mod.saveQueueMediaBytes("sess-1", Buffer.from("ok"), "image/png", "ok.png", agentDir);
    assert.ok(mod.readQueueMediaBase64("sess-1", small.path, agentDir));
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("queue outbox：拒绝非法会话 id（不接受路径穿越作为目录名）", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "queue-outbox-bad-"));
  try {
    for (const bad of ["../x", "a/b", "", "a b", "a".repeat(129)]) {
      assert.throws(() => mod.getQueueOutboxDir(bad, agentDir), /session/i);
    }
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
