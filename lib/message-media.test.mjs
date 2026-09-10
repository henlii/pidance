import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { saveChatAttachmentStream } = await jiti.import("./chat-attachments.ts");

function bodyFrom(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

test("saveChatAttachmentStream：大媒体按流写入并返回可复用路径", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pidance-media-"));
  try {
    const saved = await saveChatAttachmentStream("movie.mp4", bodyFrom(["hello", " media"]), agentDir);
    assert.equal(saved.name, "movie.mp4");
    assert.equal(saved.size, 11);
    assert.ok(saved.storedName.endsWith("_movie.mp4"));
    assert.ok(existsSync(saved.path));
    assert.equal(readFileSync(saved.path, "utf8"), "hello media");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("saveChatAttachmentStream：超过传输安全上限时清理临时文件", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pidance-media-limit-"));
  try {
    await assert.rejects(
      saveChatAttachmentStream("big.bin", bodyFrom(["123456"]), agentDir, 5),
      /message media exceeds 5 bytes/,
    );
    const files = await (await import("node:fs/promises")).readdir(join(agentDir, "pidance-attachments"));
    assert.deepEqual(files, []);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
