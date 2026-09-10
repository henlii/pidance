import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  PIDANCE_BINARY_CUSTOM_TYPE,
  binaryKindFromMime,
  binaryMessageToUiMessage,
  parseBinaryMessageData,
} = await jiti.import("./message-binary.ts");

const valid = {
  type: "binary",
  version: 1,
  kind: "image",
  path: "/tmp/pidance-attachments/photo.png",
  name: "photo.png",
  mimeType: "image/png",
  size: 1234,
  previewPath: "/tmp/pidance-attachments/photo.preview.jpg",
  messageEntryId: "entry-user",
};

test("binaryKindFromMime：图片/音频/视频/其它分类稳定", () => {
  assert.equal(binaryKindFromMime("image/png"), "image");
  assert.equal(binaryKindFromMime("audio/mpeg"), "audio");
  assert.equal(binaryKindFromMime("video/mp4"), "video");
  assert.equal(binaryKindFromMime("application/pdf"), "file");
});

test("parseBinaryMessageData：只接受有限且版本正确的 UI 元数据", () => {
  assert.deepEqual(parseBinaryMessageData(valid), valid);
  assert.equal(parseBinaryMessageData({ ...valid, version: 2 }), null);
  assert.equal(parseBinaryMessageData({ ...valid, kind: "video" }), null);
  assert.equal(parseBinaryMessageData({ ...valid, size: -1 }), null);
  const sanitized = parseBinaryMessageData({ ...valid, name: "../../secret" });
  assert.ok(sanitized);
  assert.equal(sanitized.name.includes("/"), false);
  assert.equal(parseBinaryMessageData({ ...valid, mimeType: "text/html" }), null);
});

test("binaryMessageToUiMessage：使用 pidance.binary customType 且不携带二进制内容", () => {
  const parsed = parseBinaryMessageData(valid);
  assert.ok(parsed);
  const message = binaryMessageToUiMessage(parsed, 123);
  assert.equal(message.role, "custom");
  assert.equal(message.customType, PIDANCE_BINARY_CUSTOM_TYPE);
  assert.equal(message.content, "photo.png");
  assert.equal(message.details.size, 1234);
  assert.equal(JSON.stringify(message).includes("data:"), false);
});
