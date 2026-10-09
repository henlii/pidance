/**
 * 输入框历史回溯（↑/↓）。用户可见行为全在这里定死：
 * 顺序、相邻去重、越界不动、草稿暂存与归还、容量截断。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createInputHistory, INPUT_HISTORY_DEFAULT_LIMIT } = await jiti.import("./input-history.ts");

test("顺序：↑ 从最新往回，↓ 往回走；到头不动", () => {
  const h = createInputHistory();
  h.push("一");
  h.push("二");
  h.push("三");
  assert.equal(h.prev("草稿"), "三");
  assert.equal(h.prev("草稿"), "二");
  assert.equal(h.prev("草稿"), "一");
  assert.equal(h.prev("草稿"), null, "最早一条再往上没有更早的，保持不动");
  assert.equal(h.next(), "二");
  assert.equal(h.next(), "三");
});

test("草稿暂存：第一次按 ↑ 存下当前草稿，↓ 走到末尾要还回来", () => {
  const h = createInputHistory();
  h.push("旧消息");
  assert.equal(h.prev("还没发出去的半句话"), "旧消息");
  assert.equal(h.next(), "还没发出去的半句话", "回到草稿而不是空");
  assert.equal(h.next(), null, "已经在草稿态，再按 ↓ 不动");
});

test("相邻重复不重复记录；空白内容不记录", () => {
  const h = createInputHistory();
  h.push("同一句");
  h.push("同一句");
  h.push("   ");
  assert.equal(h.prev(""), "同一句");
  assert.equal(h.prev(""), null, "只有一条");
});

test("reset 之后回到草稿态（提交后游标归位）", () => {
  const h = createInputHistory();
  h.push("一");
  h.push("二");
  assert.equal(h.prev(""), "二");
  h.reset();
  assert.equal(h.next(), null, "归位后按 ↓ 不动");
  assert.equal(h.prev(""), "二", "再次按 ↑ 还是从最新开始");
});

test("容量截断：只留最近 limit 条", () => {
  const h = createInputHistory({ limit: 3 });
  for (const text of ["1", "2", "3", "4"]) h.push(text);
  assert.equal(h.prev(""), "4");
  assert.equal(h.prev(""), "3");
  assert.equal(h.prev(""), "2");
  assert.equal(h.prev(""), null, "1 已被挤掉");
});

test("limit 非法时用默认值，不抛", () => {
  for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const h = createInputHistory({ limit });
    for (let i = 0; i < INPUT_HISTORY_DEFAULT_LIMIT + 5; i += 1) h.push(`第${i}条`);
    let count = 0;
    while (h.prev("") !== null) count += 1;
    assert.equal(count, INPUT_HISTORY_DEFAULT_LIMIT, `limit=${limit} 应该退回默认容量`);
  }
});
