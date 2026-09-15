import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { messageNavPreview, centeredRailScrollTop } = await jiti.import("./MessageNavRail.tsx");

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


// ---------------------------------------------------------------------------
// Bug：导航条不跟随当前项（长会话滚到靠前消息时，导航条仍停在原处）
// ---------------------------------------------------------------------------

test("centeredRailScrollTop：把当前项滚到轨道中部", () => {
  // 视口 200、内容 1000、项在内容 500 处（高 14）→ 500+7-100 = 407
  assert.equal(
    centeredRailScrollTop({ scrollTop: 0, viewportHeight: 200, contentHeight: 1000, itemTop: 500, itemHeight: 14 }),
    407,
  );
});

test("centeredRailScrollTop：首尾项夹在可滚范围内（不出现空白）", () => {
  assert.equal(
    centeredRailScrollTop({ scrollTop: 300, viewportHeight: 200, contentHeight: 1000, itemTop: 0, itemHeight: 14 }),
    0,
  );
  assert.equal(
    centeredRailScrollTop({ scrollTop: 0, viewportHeight: 200, contentHeight: 1000, itemTop: 986, itemHeight: 14 }),
    800,
  );
});

test("centeredRailScrollTop：内容未溢出时恒为 0", () => {
  assert.equal(
    centeredRailScrollTop({ scrollTop: 0, viewportHeight: 400, contentHeight: 300, itemTop: 150, itemHeight: 14 }),
    0,
  );
});

test("centeredRailScrollTop：非法输入保持当前滚动位置", () => {
  assert.equal(
    centeredRailScrollTop({ scrollTop: 42, viewportHeight: 200, contentHeight: 1000, itemTop: Number.NaN, itemHeight: 14 }),
    42,
  );
});
