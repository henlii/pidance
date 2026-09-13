import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { messageNavPreview } = await jiti.import("./MessageNavRail.tsx");

// 说明：导航条改为「服务端完整大纲 + 懒加载跳转」后，节点不再由 DOM 测量得出
// （见 lib/session-outline.ts 与 MessageNavRail 的 outline 驱动）。
// 这里只保留组件自身的纯函数契约。

test("messageNavPreview：单行化并截断（aria-label 用）", () => {
  assert.equal(messageNavPreview("  多行\n文本   带空格  "), "多行 文本 带空格");
  assert.equal(messageNavPreview(""), "");
  const long = "x".repeat(200);
  assert.equal(messageNavPreview(long).length, 121);
  assert.ok(messageNavPreview(long).endsWith("…"));
});
