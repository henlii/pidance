/**
 * 内联预览的生成门槛。
 * 目的：历史消息里的图片不得按原图下载（实测 1.9 MB 截图内联渲染拉满 1.9 MB）。
 *
 * 这里只覆盖**决策门槛**（在任何浏览器 API 之前的分支）；真正的缩小编码由
 * 浏览器 canvas 完成，用端到端实测验证。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { prepareImagePreview, DIRECT_PREVIEW_MAX_BYTES } =
  await jiti.import("./image-input.ts");

/** 只需要 size/type 的伪 File：门槛分支不会触及浏览器 API。 */
const fakeFile = (size, type) => ({ size, type });

test("小文件不生成预览：直接用原图作为内联预览即可", () => {
  assert.equal(DIRECT_PREVIEW_MAX_BYTES, 256 * 1024);
  return prepareImagePreview(fakeFile(DIRECT_PREVIEW_MAX_BYTES, "image/png")).then((r) =>
    assert.equal(r, null),
  );
});

test("大 PNG 在无浏览器环境返回 null（交由调用方回退），不会抛错", async () => {
  // node 下没有 document；这里断言的是「安全回退」而不是「一定能缩」。
  const result = await prepareImagePreview(fakeFile(2 * 1024 * 1024, "image/png"));
  assert.equal(result, null);
});

test("GIF 跳过：canvas 会丢动画，不能拿它当预览", async () => {
  const result = await prepareImagePreview(fakeFile(2 * 1024 * 1024, "image/gif"));
  assert.equal(result, null);
});

test("非位图类型跳过", async () => {
  for (const type of ["application/pdf", "video/mp4", "text/plain", ""]) {
    assert.equal(await prepareImagePreview(fakeFile(2 * 1024 * 1024, type)), null, type);
  }
});
