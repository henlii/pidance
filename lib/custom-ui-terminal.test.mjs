import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./custom-ui-terminal.ts");
}

test("headless custom UI exposes stable terminal dimensions", async () => {
  const { createHeadlessCustomUiTui, DEFAULT_CUSTOM_UI_COLUMNS, DEFAULT_CUSTOM_UI_ROWS } = await loadSubject();
  const tui = createHeadlessCustomUiTui(() => {});

  assert.deepEqual(tui.terminal, {
    columns: DEFAULT_CUSTOM_UI_COLUMNS,
    rows: DEFAULT_CUSTOM_UI_ROWS,
    kittyProtocolActive: false,
  });
  assert.equal(Object.isFrozen(tui), true);
  assert.equal(Object.isFrozen(tui.terminal), true);
});

test("headless custom UI supports plugin rendering and render requests", async () => {
  const { createHeadlessCustomUiTui } = await loadSubject();
  let renders = 0;
  const tui = createHeadlessCustomUiTui(() => { renders += 1; }, 80, 24);
  const pluginComponent = {
    render: (width) => [`${width}:${tui.terminal.columns}x${tui.terminal.rows}`],
  };

  assert.deepEqual(pluginComponent.render(80), ["80:80x24"]);
  tui.requestRender();
  assert.equal(renders, 1);
});

// 插件的外部编辑器路径（Ctrl+G）会在让出终端前后调 stop/start，
// Web 端没有可让出的终端，但成员必须存在，否则调用点直接 TypeError。
test("headless custom UI exposes stop/start placeholders", async () => {
  const { createHeadlessCustomUiTui } = await loadSubject();
  const tui = createHeadlessCustomUiTui(() => {});

  assert.equal(typeof tui.stop, "function");
  assert.equal(typeof tui.start, "function");
  assert.doesNotThrow(() => {
    tui.stop();
    tui.start();
  });
});

// 插件在 render() 里读 tui.terminal.columns/rows 做布局判断（rpiv-ask-user 就是这样），
// 视口变化后它必须与下一次 render(width) 的参数一致。
test("headless custom UI：terminal 尺寸是 getter，能反映最新宽度", async () => {
  const { createHeadlessCustomUiTui } = await loadSubject();
  let width = 80;
  const tui = createHeadlessCustomUiTui(() => {}, () => width, 24);

  assert.equal(tui.terminal.columns, 80);
  assert.equal(tui.terminal.rows, 24);
  width = 60;
  assert.equal(tui.terminal.columns, 60, "视口变了，插件读到的必须是新值");
});

// ---------------------------------------------------------------------------
// 焦点探针：插件（pi-subagents 的 fleet widget）用「形状」判断主编辑器有没有焦点：
// 对象且 render / invalidate / handleInput / getText / setText 五个都是函数。
// ---------------------------------------------------------------------------
test("焦点探针只提供鸭子类型需要的五个成员，且不替插件做事", async () => {
  const { createEditorFocusProbe } = await loadSubject();
  const probe = createEditorFocusProbe();

  for (const member of ["render", "invalidate", "handleInput", "getText", "setText"]) {
    assert.equal(typeof probe[member], "function", member);
  }
  // 插件会读它们的返回值当布局/文本用：必须是安全值，不能抛。
  assert.deepEqual(probe.render(80), []);
  assert.equal(probe.getText(), "");
  assert.doesNotThrow(() => {
    probe.invalidate();
    probe.handleInput("\x1b[B");
    probe.setText("x");
  });
});

test("headless custom UI：focusedComponent 随焦点动态变化，默认 undefined", async () => {
  const { createHeadlessCustomUiTui } = await loadSubject();
  let focused = false;
  const tui = createHeadlessCustomUiTui(() => {}, 80, 24, { isEditorFocused: () => focused });

  assert.equal(tui.focusedComponent, undefined, "无焦点时不能给探针");
  focused = true;
  assert.equal(typeof tui.focusedComponent, "object", "聚焦后必须给鸭子类型探针");
  assert.equal(typeof tui.focusedComponent.handleInput, "function");
  focused = false;
  assert.equal(tui.focusedComponent, undefined, "失焦后回到 undefined");
});

test("headless custom UI：不传焦点回调时行为与注入前一致", async () => {
  const { createHeadlessCustomUiTui } = await loadSubject();
  const tui = createHeadlessCustomUiTui(() => {});
  assert.equal(tui.focusedComponent, undefined);
  assert.equal(Object.isFrozen(tui), true);
});
