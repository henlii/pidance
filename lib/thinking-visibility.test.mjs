/**
 * 「隐藏思考块」设置：读、写、订阅三件事的行为。
 *
 * 用户可见的后果全在这里定死：坏值/存储不可用必须回退「显示」而不是崩或误隐藏；
 * 写之后订阅者要立刻收到（否则开关点了界面不变 —— 那就还是原来那个 bug）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  HIDE_THINKING_STORAGE_KEY,
  loadHideThinkingBlockSetting,
  saveHideThinkingBlockSetting,
  subscribeHideThinkingBlock,
  serverHideThinkingBlockSetting,
} = await jiti.import("./thinking-visibility.ts");

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
    get dump() {
      return Object.fromEntries(map);
    },
  };
}

test("默认与坏值：只有显式 1 才算开，缺值/坏值/存储不可用都当关", () => {
  assert.equal(loadHideThinkingBlockSetting(fakeStorage()), false);
  assert.equal(loadHideThinkingBlockSetting(fakeStorage({ [HIDE_THINKING_STORAGE_KEY]: "yes" })), false);
  assert.equal(loadHideThinkingBlockSetting(null), false, "存储不可用不能抛");
  assert.equal(serverHideThinkingBlockSetting(), false, "首帧默认关，避免水合不一致");
});

test("写入能被读回，且订阅者立刻收到通知", () => {
  const store = fakeStorage();
  let notified = 0;
  const unsubscribe = subscribeHideThinkingBlock(() => {
    notified += 1;
  });

  saveHideThinkingBlockSetting(true, store);
  assert.equal(loadHideThinkingBlockSetting(store), true);
  assert.equal(store.dump[HIDE_THINKING_STORAGE_KEY], "1");
  assert.equal(notified, 1, "开关点了界面要立刻跟着变");

  saveHideThinkingBlockSetting(false, store);
  assert.equal(loadHideThinkingBlockSetting(store), false);
  assert.equal(notified, 2);

  unsubscribe();
  saveHideThinkingBlockSetting(true, store);
  assert.equal(notified, 2, "退订后不再收到");
});

test("存储抛异常不影响界面：写失败不抛，读失败当关", () => {
  const throwing = {
    getItem() {
      throw new Error("boom");
    },
    setItem() {
      throw new Error("boom");
    },
  };
  assert.equal(loadHideThinkingBlockSetting(throwing), false);
  assert.doesNotThrow(() => saveHideThinkingBlockSetting(true, throwing));
});
