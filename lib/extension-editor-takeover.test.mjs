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
const {
  shouldShowEditorTakeover,
  shouldShowEditorTakeoverBar,
  placeEditorText,
  startEditorTakeoverHeartbeat,
  editorTakeoverViewCleanup,
} = await jiti.import("./extension-editor-takeover.ts");

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

/**
 * setEditorText 的落点分流（四轮审查 阻断 2）。
 *
 * 这条事件是**广播**的：收到它的标签里既有正显示接管面板的（输入框不在场，文本属于组件），
 * 也有没在显示的 —— 手机 / 设置关掉 / 用户点过「返回输入框」，那些标签的输入框里是用户
 * 自己正在打的正文。整段替换等于把用户刚敲的字静默删掉。
 */
test("落点：定向交还走替换（TUI 的 editor.setText），指向别人则什么都不做", () => {
  const written = [];
  const target = {
    replaceText: (text) => written.push(["replace", text]),
    insertIfEmpty: (text) => written.push(["insert-if-empty", text]),
  };

  assert.equal(placeEditorText({ clientId: "tab-mine", text: "交还的正文" }, target, "tab-mine"), "replace");
  assert.deepEqual(written, [["replace", "交还的正文"]], "定向交还必须替换（插入会拼成两份）");

  written.length = 0;
  assert.equal(placeEditorText({ clientId: "tab-other", text: "别人的字" }, target, "tab-mine"), "ignore");
  assert.deepEqual(written, [], "指名给别的标签时本页不动");
});

test("落点：广播只填空输入框，绝不替换（用户正在打的字优先）", () => {
  const written = [];
  let text = "用户正在打的字";
  const target = {
    replaceText: (value) => {
      text = value;
      written.push(["replace", value]);
    },
    insertIfEmpty: (value) => {
      if (text.trim()) return;
      text = value;
      written.push(["insert-if-empty", value]);
    },
  };

  assert.equal(placeEditorText({ text: "插件要写的" }, target, "tab-mine"), "insert-if-empty");
  assert.deepEqual(written, [], "输入框非空 ⇒ 一个字节都不写（替换会把用户的字删掉）");
  assert.equal(text, "用户正在打的字");

  text = "";
  assert.equal(placeEditorText({ text: "插件要写的" }, target, "tab-mine"), "insert-if-empty");
  assert.deepEqual(written, [["insert-if-empty", "插件要写的"]], "空输入框才落进去");

  // 没有输入框（正在显示接管面板）：什么都不做，也不抛。
  assert.equal(placeEditorText({ text: "x" }, null, "tab-mine"), "insert-if-empty");
});

/**
 * 心跳（四轮审查 阻断 1）：宿主只把「最近还在心跳」的登记当有效归属者。
 *
 * 这里钉住三件事：按注入的间隔重报、每次读**当前**的 shown（不缓存）、停止时清掉计时器。
 */
test("心跳：按间隔重报、每次读最新的 shown、停止时清表", () => {
  let tick = null;
  let cleared = 0;
  const beats = [];
  let shown = true;
  const stop = startEditorTakeoverHeartbeat({
    intervalMs: 15_000,
    readShown: () => shown,
    report: (value) => beats.push(value),
    setIntervalFn: (fn, ms) => {
      assert.equal(ms, 15_000, "间隔要按传入值（宿主的新鲜度窗口按它算）");
      tick = fn;
      return { fake: true };
    },
    clearIntervalFn: (handle) => {
      assert.deepEqual(handle, { fake: true }, "清掉的必须是这个计时器");
      cleared += 1;
    },
  });

  assert.equal(typeof tick, "function", "要装一个计时器（不靠一次性上报）");
  assert.deepEqual(beats, [], "立刻那次上报由 ChatWindow 另有一个 effect 负责，这里只管心跳");
  tick();
  tick();
  assert.deepEqual(beats, [true, true]);
  shown = false;
  tick();
  assert.deepEqual(beats, [true, true, false], "每次读最新的 shown（用户收起后要如实上报）");
  stop();
  assert.equal(cleared, 1, "卸载/换会话要清掉心跳");
});

/**
 * 切换会话 / 换接管 / 卸载时该向哪条登记发 shown=false（四轮审查 阻断 1 的第一条）。
 *
 * 不注销的话，宿主要在新鲜度窗口里把那个标签当成有效目标：落在窗口里的「插件自己调
 * onSubmit」就会发给一个已经不看这个会话的标签。心跳会让它自然过期（所以注销不是唯一
 * 防线），注销把窗口**立刻**关掉。
 */
test("注销目标：换了会话 / 换了接管 / 卸载才注销；同一条不重复注销", () => {
  const a = { sessionId: "s1", requestId: "t1" };
  const b = { sessionId: "s2", requestId: "t1" };
  const c = { sessionId: "s1", requestId: "t2" };

  assert.deepEqual(editorTakeoverViewCleanup(null, a), null, "第一次上报没有要注销的");
  assert.deepEqual(editorTakeoverViewCleanup(a, a), null, "同一条不重复注销（否则每次展开/收起都多一帧）");
  assert.deepEqual(editorTakeoverViewCleanup(a, b), a, "切到别的会话：注销旧会话上的登记");
  assert.deepEqual(editorTakeoverViewCleanup(a, c), a, "插件换了接管：注销旧接管");
  assert.deepEqual(editorTakeoverViewCleanup(a, null), a, "卸载 / 接管消失：注销");
});
