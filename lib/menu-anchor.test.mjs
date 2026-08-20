import assert from "node:assert/strict";
import test from "node:test";
import { didMenuAnchorMove } from "./menu-anchor.ts";

test("didMenuAnchorMove：聊天区滚动不关菜单，触发器位移才关", () => {
  const anchor = { top: 100, right: 20 };
  assert.equal(didMenuAnchorMove(anchor, { top: 100, right: 20 }), false);
  assert.equal(didMenuAnchorMove(anchor, { top: 101, right: 20 }), false);
  assert.equal(didMenuAnchorMove(anchor, { top: 120, right: 20 }), true);
  assert.equal(didMenuAnchorMove(anchor, { top: 100, right: 40 }), true);
  assert.equal(didMenuAnchorMove(null, anchor), false);
});
