/**
 * 插件编辑器接管的显示判据（issue #107）。
 *
 * 这几条门槛就是功能的验收项（手机不接管、设置可关、用户收起过、只读 / 被对端持有 /
 * 扩展对话框占着输入区），所以单独抽成纯函数在这里逐条钉住 —— 写在 ChatWindow 的 JSX 里
 * 只能靠「源码有没有这段字符」来"测"。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { shouldShowEditorTakeover, shouldShowEditorTakeoverBar } = await jiti.import("./extension-editor-takeover.ts");

/** 全部条件都满足的基线：桌面、可写、有接管、开关开着、没被收起。 */
const base = {
  hasTakeover: true,
  enabled: true,
  dismissed: false,
  isMobile: false,
  isReadOnly: false,
  lockedByOther: false,
  hasDialog: false,
};

test("接管面板：条件齐了才显示", () => {
  assert.equal(shouldShowEditorTakeover(base), true);
});

test("接管面板：手机不接管（插件画的是终端界面，窄视口保持真输入框）", () => {
  assert.equal(shouldShowEditorTakeover({ ...base, isMobile: true }), false);
});

test("接管面板：设置里关掉就不接管（插件那边照旧，只是本页不显示）", () => {
  assert.equal(shouldShowEditorTakeover({ ...base, enabled: false }), false);
});

test("接管面板：只读 / 被对端持有 / 扩展对话框占着输入区都不接管", () => {
  assert.equal(shouldShowEditorTakeover({ ...base, isReadOnly: true }), false);
  assert.equal(shouldShowEditorTakeover({ ...base, lockedByOther: true }), false);
  assert.equal(shouldShowEditorTakeover({ ...base, hasDialog: true }), false);
});

test("接管面板：没有接管内容就不显示（渲染失败降级后 / 插件卸下之后）", () => {
  assert.equal(shouldShowEditorTakeover({ ...base, hasTakeover: false }), false);
});

test("收起细条：只有「用户收起过、且接管还在、且本来该接管」时显示", () => {
  assert.equal(shouldShowEditorTakeoverBar({ ...base, dismissed: true }), true);
  assert.equal(shouldShowEditorTakeoverBar(base), false, "没收起时由面板显示，不是细条");
  assert.equal(shouldShowEditorTakeoverBar({ ...base, dismissed: true, hasTakeover: false }), false);
  assert.equal(shouldShowEditorTakeoverBar({ ...base, dismissed: true, enabled: false }), false);
  assert.equal(shouldShowEditorTakeoverBar({ ...base, dismissed: true, isMobile: true }), false);
});

test("收起细条：与面板互斥（同一时刻只可能显示一个）", () => {
  for (const options of [
    base,
    { ...base, dismissed: true },
    { ...base, isReadOnly: true },
    { ...base, isMobile: true },
  ]) {
    assert.equal(
      shouldShowEditorTakeover(options) && shouldShowEditorTakeoverBar(options),
      false,
      JSON.stringify(options),
    );
  }
});
