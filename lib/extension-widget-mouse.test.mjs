/**
 * widget 鼠标换算与触摸手势的纯函数测试（issue #103）。
 *
 * 这里只测数学与判定：DOM 取值在 ChatWindow 的 ExtensionWidgetBody 里，
 * 像素→单元格的除法、夹边界、量不出时不转发、tap/长按/滚动的区分都在这层锁住。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  buildWidgetClickEvent,
  consumeTapClick,
  INITIAL_WIDGET_TOUCH_STATE,
  isScrollGesture,
  markLongPressFired,
  mouseButtonName,
  shouldFireLongPress,
  touchCancel,
  touchEnd,
  touchMove,
  touchStart,
  widgetCellFromMetrics,
  WIDGET_LONG_PRESS_MS,
  WIDGET_LONG_PRESS_MOVE_PX,
} = await jiti.import("./extension-widget-mouse.ts");

/** 一份能量出字符宽/行高的基准度量：8px/字符、16px/行。 */
function metrics(overrides = {}) {
  return {
    offsetX: 0,
    offsetY: 0,
    charWidth: 8,
    lineHeight: 16,
    bodyWidth: 80,
    bodyHeight: 48,
    ...overrides,
  };
}

test("像素→单元格：整除取格位，不整除向下取（点在第 2 个字符中间算第 1 列）", () => {
  assert.deepEqual(widgetCellFromMetrics(metrics({ offsetX: 0, offsetY: 0 })), { x: 0, y: 0, width: 10, height: 3 });
  // 8px/字符：x=8 是第 1 列，x=15 仍是第 1 列（还没进第 2 列）
  assert.equal(widgetCellFromMetrics(metrics({ offsetX: 8 }))?.x, 1);
  assert.equal(widgetCellFromMetrics(metrics({ offsetX: 15 }))?.x, 1);
  assert.equal(widgetCellFromMetrics(metrics({ offsetX: 16 }))?.x, 2);
  // 行高 16：y=32 是第 2 行
  assert.equal(widgetCellFromMetrics(metrics({ offsetY: 32 }))?.y, 2);
  assert.equal(widgetCellFromMetrics(metrics({ offsetY: 31 }))?.y, 1);
});

test("像素→单元格：负偏移（padding 区 / 反向滚动）夹到 0，不产生负坐标", () => {
  const point = widgetCellFromMetrics(metrics({ offsetX: -12, offsetY: -5 }));
  assert.deepEqual(point, { x: 0, y: 0, width: 10, height: 3 });
});

test("像素→单元格：字符宽或行高量不出时返回 null（调用方据此不转发）", () => {
  assert.equal(widgetCellFromMetrics(metrics({ charWidth: null })), null);
  assert.equal(widgetCellFromMetrics(metrics({ lineHeight: null })), null);
  assert.equal(widgetCellFromMetrics(metrics({ charWidth: 0 })), null);
  assert.equal(widgetCellFromMetrics(metrics({ lineHeight: 0 })), null);
  assert.equal(widgetCellFromMetrics(metrics({ charWidth: Number.NaN })), null);
  assert.equal(widgetCellFromMetrics(metrics({ offsetX: Number.NaN })), null);
});

test("像素→单元格：正文区尺寸不足一格时宽高至少为 1（插件不会拿到 0 宽）", () => {
  const point = widgetCellFromMetrics(metrics({ bodyWidth: 3, bodyHeight: 4 }));
  assert.equal(point?.width, 1);
  assert.equal(point?.height, 1);
});

test("像素→单元格：width/height 量的是**可见正文盒**的格数，不是 render(width) 的列数", () => {
  // 盒子 800px、字符宽 8px → 100 格。但这是「盒子能放多少格」，不是「服务端按几列渲染」：
  // 盒子更宽时给的就是更宽的值（若有人改成用某个 renderWidth 常量算，这一条会变红）。
  assert.equal(widgetCellFromMetrics(metrics({ bodyWidth: 800 }))?.width, 100);
  assert.equal(widgetCellFromMetrics(metrics({ bodyWidth: 880 }))?.width, 110);
  // 高度同理：可见盒 80px、行高 16px → 5 行（不是组件内容的总行数）。
  // pi-tui 的 Container.handleMouse 用 `y >= event.height` 丢掉可见区以下的点击，
  // 所以这里要给的正是「用户能点到的那块区域」。
  assert.equal(widgetCellFromMetrics(metrics({ bodyHeight: 80 }))?.height, 5);
});

test("DOM button 数值 → pi-tui 按钮名", () => {
  assert.equal(mouseButtonName(0), "left");
  assert.equal(mouseButtonName(1), "middle");
  assert.equal(mouseButtonName(2), "right");
  assert.equal(mouseButtonName(3), "right", "浏览器里的 3/4 号键归到 right");
});

test("组装 click 事件：类型/坐标/尺寸/修饰键齐备（pi-tui 的 TuiMouseEvent 形状）", () => {
  const point = widgetCellFromMetrics(metrics({ offsetX: 9, offsetY: 17 }));
  const event = buildWidgetClickEvent(point, {
    button: "left",
    clickCount: 2,
    shift: true,
    alt: false,
    ctrl: true,
  });
  assert.deepEqual(event, {
    type: "click",
    button: "left",
    x: 1,
    y: 1,
    screenX: 1,
    screenY: 1,
    width: 10,
    height: 3,
    shift: true,
    alt: false,
    ctrl: true,
    clickCount: 2,
  });
});

test("触摸：tap（未长按）照常转发一次点击", () => {
  const press = touchStart();
  const ended = touchEnd(press);
  const tap = consumeTapClick(ended);
  assert.equal(tap.send, true, "普通点击要转发");
  assert.deepEqual(tap.state, INITIAL_WIDGET_TOUCH_STATE, "转发后状态清空，不影响下一次触摸");
});

test("长按：按着不动超过阈值才成立，已派发过就不再重复", () => {
  const press = touchStart();
  assert.equal(shouldFireLongPress(press, WIDGET_LONG_PRESS_MS - 1), false, "没到时间不算长按");
  assert.equal(shouldFireLongPress(press, WIDGET_LONG_PRESS_MS), true);
  const fired = markLongPressFired(press);
  assert.equal(shouldFireLongPress(fired, WIDGET_LONG_PRESS_MS * 3), false, "同一次触摸只派发一次");
});

test("滚动：超过阈值取消长按，松手后补发的 click 也必须吃掉", () => {
  const press = touchStart();
  assert.equal(isScrollGesture(WIDGET_LONG_PRESS_MOVE_PX, 0), false, "阈值内不算滚动");
  assert.equal(isScrollGesture(WIDGET_LONG_PRESS_MOVE_PX + 1, 0), true);
  assert.equal(isScrollGesture(0, -(WIDGET_LONG_PRESS_MOVE_PX + 4)), true, "反向滑动同样是滚动");

  const scrolled = touchMove(press, 0, WIDGET_LONG_PRESS_MOVE_PX + 6);
  assert.equal(scrolled.pressing, false, "滚动后不再按着 → 长按作废");
  assert.equal(scrolled.scrolled, true, "要记下「这次手势是滚动」");
  assert.equal(shouldFireLongPress(scrolled, WIDGET_LONG_PRESS_MS * 2), false, "翻页/滚动不该触发右键");

  // 浏览器滑动后**通常**不补 click，但不是保证。正文区是内滚容器（touch-action: pan-y），
  // 手机上滑一下再松手很常见；补发的那次若被当成 tap，插件会看成「点了第 0 行」。
  const tap = consumeTapClick(touchEnd(scrolled));
  assert.equal(tap.send, false, "滑动松手后补发的 click 必须吃掉");
  assert.deepEqual(tap.state, INITIAL_WIDGET_TOUCH_STATE, "吃掉之后复位");

  // 下一次点击照常（不能因为上次滑动而永久吞点击）
  assert.equal(consumeTapClick(touchEnd(touchStart())).send, true);
});

test("系统取消（长按菜单 / 文本选择 / 手势导航）之后补发的 click 也不能转发", () => {
  const fired = markLongPressFired(touchStart());
  const cancelled = touchCancel(fired);
  assert.equal(cancelled.pressing, false, "取消后不再按着");
  assert.equal(cancelled.longPressFired, true, "cancel 不能抹掉「已派发右键」的标记");
  const tap = consumeTapClick(cancelled);
  assert.equal(tap.send, false, "长按已作为右键派发，cancel 之后补发的 click 同样要吃掉");
  assert.deepEqual(tap.state, INITIAL_WIDGET_TOUCH_STATE, "吃掉之后复位");

  // 滚动中途被打断也一样：scrolled 标记要活到这次 click 之后
  const scrolledCancel = touchCancel(touchMove(touchStart(), 0, WIDGET_LONG_PRESS_MOVE_PX + 6));
  assert.equal(consumeTapClick(scrolledCancel).send, false, "滚动中被打断同样不转发");

  // 标记不跨手势存活：取消之后的下一次点击照常
  assert.equal(consumeTapClick(touchEnd(touchStart())).send, true);
});

test("长按之后的补发 click 被吃掉，之后的下一次点击恢复正常", () => {
  const press = touchStart();
  const fired = markLongPressFired(press);
  const ended = touchEnd(fired);
  const suppressed = consumeTapClick(ended);
  assert.equal(suppressed.send, false, "长按已作为右键派发过，补发的 click 必须吃掉");
  assert.deepEqual(suppressed.state, INITIAL_WIDGET_TOUCH_STATE, "吃掉之后状态复位");

  // 再点一次：不能因为上一次的长按而永久吞掉点击
  const second = consumeTapClick(touchEnd(touchStart()));
  assert.equal(second.send, true);

  // 下一次触摸（新的按下序列）仍然可以长按：标记不能跨触摸存活
  const nextPress = touchStart();
  assert.equal(shouldFireLongPress(nextPress, WIDGET_LONG_PRESS_MS), true, "第二次长按照常成立");
});

test("touchEnd 不会把长按标记带进下一次触摸（状态复位）", () => {
  const fired = markLongPressFired(touchStart());
  const ended = touchEnd(fired);
  assert.equal(ended.pressing, false);
  const next = touchStart();
  assert.equal(next.longPressFired, false, "新触摸不带旧标记");
  assert.equal(shouldFireLongPress(next, 0), false);
});
