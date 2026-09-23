/**
 * overlay 布局映射：pi-tui 的锚点 + 行/列尺寸 → CSS。
 *
 * 用例直接取真实插件传的组合：
 *   pi-subagents fleet  → center / "95%" / minWidth 60 / maxHeight "85%" / margin 1
 *   pi-subagents stop   → center / 88 / maxHeight "80%"
 *   rpiv-ask-user       → bottom-center / "100%" / maxHeight "100%" / margin {left,right,bottom:0}
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { ANCHOR_ALIGNMENT, buildExtensionOverlayStyle, marginToPadding, sizeToCss } =
  await jiti.import("./extension-overlay-layout.ts");
const { CHAT_COLUMN_MAX_WIDTH_CSS } = await jiti.import("./chat-column.ts");

/** 期望的 padding 文本：每边都与安全区取 max。 */
function padding(top, right, bottom, left) {
  return [
    `max(${top}, env(safe-area-inset-top, 0px))`,
    `max(${right}, env(safe-area-inset-right, 0px))`,
    `max(${bottom}, env(safe-area-inset-bottom, 0px))`,
    `max(${left}, env(safe-area-inset-left, 0px))`,
  ].join(" ");
}

test("sizeToCss：数字按列数、字符串原样、缺省 undefined", () => {
  assert.equal(sizeToCss(88), "88ch");
  assert.equal(sizeToCss("95%"), "95%");
  assert.equal(sizeToCss(undefined), undefined);
});

test("marginToPadding：竖向 em、横向 ch，每边都避开安全区", () => {
  assert.equal(marginToPadding(1), padding("1em", "1ch", "1em", "1ch"));
  assert.equal(marginToPadding({ left: 0, right: 0, bottom: 0 }), padding("0em", "0ch", "0em", "0ch"));
  assert.equal(marginToPadding({ top: 2, left: 3 }), padding("2em", "0ch", "0em", "3ch"));
  assert.equal(marginToPadding({}), undefined);
  assert.equal(marginToPadding(undefined), undefined);
});

test("没有 layout → undefined（保持既有的全屏模态渲染）", () => {
  assert.equal(buildExtensionOverlayStyle(undefined), undefined);
});

test("fleet：center / 95% / minWidth 60 / maxHeight 85% / margin 1", () => {
  const styles = buildExtensionOverlayStyle({
    anchor: "center",
    width: "95%",
    minWidth: 60,
    maxHeight: "85%",
    margin: 1,
  });
  assert.deepEqual(styles.containerStyle, {
    alignItems: "center",
    justifyContent: "center",
    padding: padding("1em", "1ch", "1em", "1ch"),
  });
  assert.deepEqual(styles.panelStyle, {
    width: "95%",
    minWidth: "min(60ch, 100%)",
    maxHeight: "85%",
  });
});

test("stop 选择器：88 列会封顶到容器宽（窄屏不再被裁掉）", () => {
  const styles = buildExtensionOverlayStyle({ anchor: "center", width: 88, maxHeight: "80%" });
  assert.equal(styles.panelStyle.width, "min(88ch, 100%)");
  assert.equal(styles.panelStyle.minWidth, undefined);
  assert.equal(styles.panelStyle.maxHeight, "80%");
  assert.equal(styles.containerStyle.padding, undefined);
});

test("ask：bottom-center / 100% / margin 贴边但仍避开底部安全区", () => {
  const styles = buildExtensionOverlayStyle({
    anchor: "bottom-center",
    width: "100%",
    maxHeight: "100%",
    margin: { left: 0, right: 0, bottom: 0 },
  });
  assert.equal(styles.containerStyle.alignItems, "flex-end");
  assert.equal(styles.containerStyle.justifyContent, "center");
  assert.match(styles.containerStyle.padding, /env\(safe-area-inset-bottom, 0px\)/);
  assert.equal(styles.panelStyle.width, "100%");
  assert.equal(styles.panelStyle.maxHeight, "100%");
});

test("数字 maxHeight 按行高近似并封顶", () => {
  const styles = buildExtensionOverlayStyle({ anchor: "center", maxHeight: 10 });
  assert.equal(styles.panelStyle.maxHeight, "min(15em, 100%)");
});

test("未给 width → 回落到聊天列宽上限（本身就是 min(…, 100%)）", () => {
  const styles = buildExtensionOverlayStyle({ anchor: "top-left" });
  assert.equal(styles.panelStyle.width, CHAT_COLUMN_MAX_WIDTH_CSS);
});

test("九个锚点的方向都正确（不只数个数）", () => {
  const expected = {
    center: ["center", "center"],
    "top-left": ["flex-start", "flex-start"],
    "top-center": ["flex-start", "center"],
    "top-right": ["flex-start", "flex-end"],
    "bottom-left": ["flex-end", "flex-start"],
    "bottom-center": ["flex-end", "center"],
    "bottom-right": ["flex-end", "flex-end"],
    "left-center": ["center", "flex-start"],
    "right-center": ["center", "flex-end"],
  };
  for (const [anchor, [alignItems, justifyContent]] of Object.entries(expected)) {
    const styles = buildExtensionOverlayStyle({ anchor });
    assert.equal(styles.containerStyle.alignItems, alignItems, `${anchor} 竖向`);
    assert.equal(styles.containerStyle.justifyContent, justifyContent, `${anchor} 横向`);
  }
  assert.equal(Object.keys(ANCHOR_ALIGNMENT).length, 9);
});

test("未知锚点回退 center（不抛）", () => {
  const styles = buildExtensionOverlayStyle({ anchor: "somewhere-else" });
  assert.deepEqual(styles.containerStyle, { alignItems: "center", justifyContent: "center" });
});
