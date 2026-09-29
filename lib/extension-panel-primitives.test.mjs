import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  walkPanelComponents,
  isSelectListLike,
  isInputLike,
  findPanelSelectList,
  findPanelInput,
  applySelectListIndex,
} = await jiti.import("./extension-panel-primitives.ts");

/** 假装是 pi-tui 的 SelectList：只带上那两个**公开**方法。 */
function fakeSelectList(items = ["甲", "乙", "丙"], selected = 0) {
  return {
    items,
    selected,
    getSelectedItem() {
      return this.items[this.selected] ?? null;
    },
    setSelectedIndex(index) {
      if (index < 0 || index >= this.items.length) throw new Error("out of range");
      this.selected = index;
    },
  };
}

/** 假装是 pi-tui 的 Container / Box：只有公开的 children。 */
function fakeContainer(children) {
  return { children, render: () => [] };
}

test("走树：容器嵌套（Box 里放 Container 再放原语）都能找到", () => {
  const list = fakeSelectList();
  const root = fakeContainer([{ render: () => [] }, fakeContainer([fakeContainer([list])])]);
  assert.deepEqual(findPanelSelectList(root), list);
  assert.equal(walkPanelComponents(root).length, 5, "广度优先应走过每个节点（根 + 4 层嵌套）");
});

test("识别用鸭子类型：有那两个方法才算可选列表（缺一个都不算）", () => {
  assert.equal(isSelectListLike(fakeSelectList()), true);
  assert.equal(isSelectListLike({ getSelectedItem: () => null }), false);
  assert.equal(isSelectListLike({ setSelectedIndex: () => {} }), false);
  assert.equal(isSelectListLike(null), false);
  assert.equal(isSelectListLike({ setSelectedIndex: () => {} }), false);
  // 输入原语同理
  assert.equal(isInputLike({ getValue: () => "", setValue: () => {} }), true);
  assert.equal(isInputLike({ getValue: () => "" }), false);
});

test("直接设置选中项：合法索引生效、越界/缺方法/抛错一律 false", () => {
  const list = fakeSelectList();
  assert.equal(applySelectListIndex(list, 2), true);
  assert.equal(list.getSelectedItem(), "丙", "应直接落到第 3 项（不必模拟按键）");
  assert.equal(applySelectListIndex(list, 99), false, "越界要 false（原始码会抛）");
  assert.equal(applySelectListIndex(list, -1), false);
  assert.equal(applySelectListIndex(list, 1.5), false);
  assert.equal(applySelectListIndex({}, 0), false);
  assert.equal(applySelectListIndex(null, 0), false);
  assert.equal(applySelectListIndex({ getSelectedItem: () => null, setSelectedIndex: () => { throw new Error("boom"); } }, 0), false);
});

test("没有原语的面板（手搓 Text 拼的）返回 null —— 交回行级层", () => {
  const handRolled = fakeContainer([{ text: "❯ 1. 甲" }, { text: "  2. 乙" }]);
  assert.equal(findPanelSelectList(handRolled), null);
  assert.equal(findPanelInput(handRolled), null);
});

test("走树有界：异常深的树不会无限走（也不会抛）", () => {
  let node = { render: () => [] };
  for (let i = 0; i < 50; i += 1) node = fakeContainer([node]);
  const walked = walkPanelComponents(node);
  assert.ok(walked.length > 0 && walked.length <= 200);
  assert.equal(findPanelSelectList(node), null);
});

test("环状引用不会卡死（有界遍历的意义）", () => {
  const a = fakeContainer([]);
  const b = fakeContainer([a]);
  a.children.push(b);
  assert.ok(walkPanelComponents(a).length <= 200);
});
