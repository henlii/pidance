import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
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

test("附件媒体：保存/读取/删除/列举都在附件目录内", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pidance-media-"));
  try {
    const saved = mod.saveChatAttachmentBytes("a.png", Buffer.from("bytes"), agentDir);
    assert.equal(mod.isChatAttachmentMediaPath(saved.path, agentDir), true);
    assert.equal(mod.chatAttachmentMediaSize(saved.path, agentDir), 5);
    assert.equal(mod.readChatAttachmentBase64(saved.path, agentDir), Buffer.from("bytes").toString("base64"));
    assert.deepEqual(
      mod.listChatAttachmentFiles(agentDir).map((file) => file.path),
      [saved.path],
    );

    // 越界：目录外、附件目录本身、路径穿越、不存在，全部不接受。
    const outside = join(agentDir, "elsewhere.png");
    writeFileSync(outside, "secret");
    assert.equal(mod.isChatAttachmentMediaPath(outside, agentDir), false);
    assert.equal(mod.isChatAttachmentMediaPath(mod.getChatAttachmentsDir(agentDir), agentDir), false);
    assert.equal(mod.isChatAttachmentMediaPath(join(saved.path, "..", "..", "etc", "passwd"), agentDir), false);
    assert.equal(mod.isChatAttachmentMediaPath(join(agentDir, "pidance-attachments", "missing.png"), agentDir), false);
    assert.equal(mod.readChatAttachmentBase64(outside, agentDir), null);
    // 删除只认附件目录内的文件：目录外的文件与目录本身都不碰。
    assert.equal(mod.deleteChatAttachmentMedia(outside, agentDir), false);
    assert.equal(existsSync(outside), true);
    assert.equal(mod.deleteChatAttachmentMedia(saved.path, agentDir), true);
    assert.equal(existsSync(saved.path), false);
    // 幂等：已删的文件再删不报错
    assert.equal(mod.deleteChatAttachmentMedia(saved.path, agentDir), false);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("附件媒体：symlink 指向附件目录之外时必须拒绝（不能变成任意文件读取/删除）", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pidance-media-link-"));
  try {
    const root = mod.ensureChatAttachmentsDir(agentDir);
    const outside = join(agentDir, "secret.png");
    writeFileSync(outside, "secret");
    const link = join(root, "linked.png");
    try {
      symlinkSync(outside, link);
    } catch {
      // Windows 无权限创建 symlink：跳过该平台，不改断其余断言。
      return;
    }
    assert.equal(mod.isChatAttachmentMediaPath(link, agentDir), false);
    assert.equal(mod.readChatAttachmentBase64(link, agentDir), null);
    assert.equal(mod.deleteChatAttachmentMedia(link, agentDir), false);
    assert.equal(readFileSync(outside, "utf8"), "secret", "越界 symlink 的目标文件不得被删");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("附件媒体：超过大小上限的图拒绝读进内存", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pidance-media-big-"));
  try {
    const saved = mod.saveChatAttachmentBytes("big.png", Buffer.alloc(64), agentDir);
    assert.equal(mod.readChatAttachmentBase64(saved.path, agentDir, 32), null);
    assert.equal(mod.readChatAttachmentBase64(saved.path, agentDir, 64), Buffer.alloc(64).toString("base64"));
    assert.equal(mod.isChatAttachmentReadable(saved.path, agentDir, 32), false);
    assert.equal(mod.isChatAttachmentReadable(saved.path, agentDir, 64), true);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("附件媒体：列举递归到子目录（遗留 outbox 目录也认），但不列 symlink 与目录", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pidance-media-scan-"));
  try {
    const root = mod.ensureChatAttachmentsDir(agentDir);
    const flat = mod.saveChatAttachmentBytes("flat.png", Buffer.from("flat"), agentDir);
    const nestedDir = join(root, "queue-outbox", "sess-1");
    mkdirSync(nestedDir, { recursive: true });
    const nested = join(nestedDir, "nested.png");
    writeFileSync(nested, "nested");
    const link = join(root, "link.png");
    symlinkSync(flat.path, link);

    const listed = mod.listChatAttachmentFiles(agentDir).map((file) => file.path).sort();
    assert.deepEqual(listed, [flat.path, nested].sort());
    // 遗留 outbox 里的文件仍可被引用（旧 prefs 里的 ref 不会因为升级而失效）
    assert.equal(mod.isChatAttachmentMediaPath(nested, agentDir), true);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
