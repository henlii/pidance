import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildSessionContext } = await jiti.import("./session-reader.ts");

const binary = {
  type: "binary",
  version: 1,
  kind: "image",
  path: "/tmp/pidance-attachments/original.png",
  previewPath: "/tmp/pidance-attachments/preview.jpg",
  name: "original.png",
  mimeType: "image/png",
  size: 8_000_000,
  messageEntryId: "user-1",
};

test("buildSessionContext：二进制 custom entry 合并到关联 user 消息", () => {
  const context = buildSessionContext([
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "看图" },
    },
    {
      type: "custom",
      id: "binary-1",
      parentId: "user-1",
      timestamp: "2026-01-01T00:00:01.000Z",
      customType: "pidance.binary",
      data: binary,
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "binary-1",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "收到" }],
        provider: "test",
        model: "test-model",
        stopReason: "stop",
      },
    },
  ]);

  assert.deepEqual(context.entryIds, ["user-1", "assistant-1"]);
  assert.deepEqual(context.messages[0].binaryBlocks, [binary]);
  assert.equal(context.messages[1].role, "assistant");
});

test("buildSessionContext：deferMedia 时剥离已有 binary 元数据对应的用户 base64 图片", () => {
  const context = buildSessionContext([
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image", data: "A".repeat(2_000_000), mimeType: "image/png" },
        ],
      },
    },
    {
      type: "custom",
      id: "binary-1",
      parentId: "user-1",
      timestamp: "2026-01-01T00:00:01.000Z",
      customType: "pidance.binary",
      data: binary,
    },
  ], undefined, { deferToolResultImages: true });

  assert.deepEqual(context.messages[0].content, [{ type: "text", text: "看图" }]);
  assert.deepEqual(context.messages[0].binaryBlocks, [binary]);
});
