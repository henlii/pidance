import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { normalizeBinaryMessageInput } = await jiti.import("./message-binary-store.ts");

function fixture() {
  const agentDir = mkdtempSync(join(tmpdir(), "pidance-binary-store-"));
  const dir = join(agentDir, "pidance-attachments");
  mkdirSync(dir);
  const path = join(dir, "photo.png");
  const previewPath = join(dir, "photo.preview.jpg");
  writeFileSync(path, Buffer.from("original"));
  writeFileSync(previewPath, Buffer.from("preview"));
  return { agentDir, path, previewPath };
}

test("normalizeBinaryMessageInput：只允许聊天附件根目录，并以磁盘大小为准", () => {
  const f = fixture();
  try {
    const binary = normalizeBinaryMessageInput({
      path: f.path,
      previewPath: f.previewPath,
      name: "photo.png",
      mimeType: "image/png",
      size: 999999,
    }, f.agentDir);
    assert.equal(binary.version, 1);
    assert.equal(binary.kind, "image");
    assert.equal(binary.size, 8);
    assert.equal(binary.previewPath, f.previewPath);
  } finally {
    rmSync(f.agentDir, { recursive: true, force: true });
  }
});

test("normalizeBinaryMessageInput：拒绝附件根目录外的路径", () => {
  const f = fixture();
  try {
    assert.throws(
      () => normalizeBinaryMessageInput({
        path: join(f.agentDir, "outside.bin"),
        name: "outside.bin",
        mimeType: "application/octet-stream",
        size: 1,
      }, f.agentDir),
      /binary media file not found|binary media path is not allowed/,
    );
  } finally {
    rmSync(f.agentDir, { recursive: true, force: true });
  }
});
