/**
 * 会话侧栏项目拖放的守卫断言。
 *
 * 为什么用源码形状而不是渲染测试：拖放行为散在「行挂载点 → 指针引擎 → 落定偏好」
 * 三处，任何一处退回旧实现都不会报错，只会让手机端又拖不动、或桌面端落点偏一格。
 * 这里把三条关键接线钉住：不用 HTML5 draggable、拖拽中拦 touchmove、浮动标签走 portal。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("项目行不再用 HTML5 draggable（触摸端根本不触发）", () => {
  const sections = read("../components/session-sidebar/sections.tsx");
  assert.ok(!/draggable=\{/.test(sections), "项目行仍挂 HTML5 draggable：手机端拖不动");
  assert.ok(!/onDragStart/.test(sections), "项目行仍挂 dragstart");
  assert.match(sections, /data-project-root=\{project\.root\}/, "项目行缺少落点标记 data-project-root");
  assert.match(sections, /data-project-section=\{project\.root\}/, "项目区缺少归属标记 data-project-section");
  assert.match(sections, /onPointerDown=\{drag \?/, "项目行未接指针拖拽");
  assert.match(
    sections,
    /aria-keyshortcuts=\{drag \? "Alt\+ArrowUp Alt\+ArrowDown"/,
    "缺少键盘换位快捷键声明",
  );
  assert.match(sections, /if \(drag\?\.shouldSuppressClick\(\)\) return;/, "拖拽结束后的补发 click 未吞掉");
});

test("拖放引擎：触摸长按激活、移动即判滚动、拖拽中拦 touchmove、松手按落点提交", () => {
  const hook = read("./useProjectDrag.ts");
  assert.match(hook, /pointerType === "touch"[\s\S]{0,400}LONG_PRESS_MS/, "触摸端未按长按激活");
  assert.match(hook, /distance > TOUCH_CANCEL_PX\) finishDrag\(\)/, "触摸端未在移动超阈值时放弃拖拽");
  assert.match(
    hook,
    /container\.addEventListener\("touchmove", listener, NON_PASSIVE\)/,
    "拖拽中未在列表容器上拦 touchmove（页面会跟着滚）",
  );
  assert.match(hook, /if \(pendingRef\.current\?\.active\) event\.preventDefault\(\)/, "touchmove 未在拖拽中 preventDefault");
  assert.match(
    hook,
    /if \(target && target\.root !== from\) \{[\s\S]{0,80}onMoveRef\.current\(from, target\.root, target\.side\)/,
    "松手未按落点侧提交顺序",
  );
  assert.match(hook, /data-project-root/, "落点命中未走 data-project-root");
  // 会话区里固定「该项目之后」：否则最近行距会在上下两个项目之间给出两种指示线。
  assert.match(hook, /\[data-project-section\]/, "会话区未按项目区归属定落点");
  assert.match(hook, /sectionRoot === draggingRootRef\.current[\s\S]{0,120}setDropTarget\(null\)/, "拖回自己会话区时应无落点");
  assert.match(hook, /side: "after"\s*\}/, "会话区内部未固定为「该项目之后」");
  assert.match(hook, /requestAnimationFrame\(tick\)/, "缺少贴边自动滚动");
});

test("侧栏接线：绑定交给 ProjectSection，浮动标签 portal 到 body，顺序写回偏好并播报", () => {
  const sidebar = read("../components/SessionSidebar.tsx");
  assert.match(sidebar, /drag=\{searchActive \? undefined : projectDrag\}/, "ProjectSection 未接拖放绑定");
  assert.match(
    sidebar,
    /createPortal\([\s\S]{0,400}sidebar-project-drag-ghost/,
    "浮动标签未 portal 到 body（会被侧栏 transform 裁切）",
  );
  assert.match(sidebar, /projectOrder: nextOrder/, "落定顺序未写回偏好");
  assert.match(sidebar, /sidebar_projectMoved/, "缺少换位播报文案");
});

test("项目行仍保留竖向滚动：touch-action 只放开 pan-y", () => {
  const css = read("../app/globals.css");
  assert.match(css, /\.sidebar-project-row \{[^}]*touch-action: pan-y;/, "项目行未设置 touch-action: pan-y（列表滚不动）");
  assert.match(css, /\.sidebar-project-row\.is-drop-target\[data-drop-side="before"\]::after/, "缺少插入位置指示线");
});

test("拖放动画：起落动画与落定高亮都接上了（不做行位移让位）", () => {
  const hook = read("./useProjectDrag.ts");
  const sections = read("../components/session-sidebar/sections.tsx");
  const sidebar = read("../components/SessionSidebar.tsx");
  const css = read("../app/globals.css");
  assert.match(sections, /is-settled/, "行未接落定高亮");
  assert.match(sidebar, /is-dropping/, "浮动标签未接放下动画");
  assert.match(css, /@keyframes project-drag-lift/, "缺少起拖动画");
  assert.match(css, /@keyframes project-drag-drop/, "缺少放下动画");
  assert.match(css, /prefers-reduced-motion: reduce/, "未尊重减少动效设置");
});
