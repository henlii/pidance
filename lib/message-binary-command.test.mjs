import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parsePromptBinaryBlocks, parsePromptCommand } = await jiti.import("./agent-commands.ts");

const block = {
  path: "/home/user/.pi/agent/pidance-attachments/movie.mp4",
  previewPath: "/home/user/.pi/agent/pidance-attachments/movie.preview.jpg",
  name: "movie.mp4",
  mimeType: "video/mp4",
  size: 26 * 1024 * 1024,
};

test("parsePromptBinaryBlocks：保留媒体引用，不读取或内联二进制内容", () => {
  assert.deepEqual(parsePromptBinaryBlocks([block]), [block]);
  assert.deepEqual(parsePromptCommand({ type: "prompt", message: "play", binaryBlocks: [block] }).binaryBlocks, [block]);
});

test("parsePromptBinaryBlocks：拒绝错误结构和过多块", () => {
  assert.throws(() => parsePromptBinaryBlocks([{ ...block, size: -1 }]), /invalid binary block/);
  assert.throws(() => parsePromptBinaryBlocks(Array.from({ length: 33 }, () => block)), /too many binary blocks/);
  assert.throws(() => parsePromptBinaryBlocks([{ ...block, mimeType: "not-a-mime" }]), /invalid binary block/);
});
