/**
 * TUI 渲染桥单测：node:test + 内存场景，不触碰真实 ~/.pi/agent。
 * 伪造 ToolDefinition，验证 renderResult/renderCall 渲染器 → Component 契约
 * （render(width) → string[]）→ ANSI 行数组的输出、行数、压缩字段名兼容与容错路径。
 *
 * 不依赖 @earendil-works/pi-tui 包：渲染桥只消费组件的 render(width) 接口，
 * 测试用最小契约 stub（接口等价，行为由断言固定）。
 */

import assert from "node:assert/strict";
import test from "node:test";

/** 最小 pi-tui Component 契约 stub：render(width) → ANSI 行数组。 */
class Text {
  constructor(text) {
    this.text = String(text ?? "");
  }
  render() {
    // 契约：上下各 1 行 padding
    return ["", this.text, ""];
  }
}

class Container {
  constructor() {
    this.children = [];
  }
  addChild(child) {
    this.children.push(child);
  }
  render() {
    return this.children.flatMap((c) => c.render());
  }
}

async function loadSubject() {
  return import("./tui-render-bridge.ts");
}

const CONTEXT = {
  toolCallId: "abc123",
  args: {},
  cwd: process.cwd(),
  isPartial: false,
  expanded: true,
  showImages: false,
  isError: false,
};

test("renderResult 返回 Text 组件 → 输出含预期文本的 ANSI 行数组、行数正确", async () => {
  const { renderToolResultLines, RENDER_WIDTH } = await loadSubject();
  const def = {
    name: "fake-tool",
    renderResult: (result, options, theme, context) => new Text("hello tui"),
  };
  const lines = renderToolResultLines(
    def,
    { content: [], details: {} },
    { expanded: true, isPartial: false },
    CONTEXT,
  );
  assert.ok(Array.isArray(lines), "应返回行数组");
  assert.ok(lines.some((line) => line.includes("hello tui")), "应包含渲染文本");
  assert.equal(lines.length, 3, "Text 渲染为 3 行（上下 padding）");
  assert.ok(lines.every((line) => line.length <= RENDER_WIDTH), "每行不超渲染宽度");
});

test("renderResult 返回 Container 组件 → 拼接子组件行", async () => {
  const { renderToolResultLines } = await loadSubject();
  const def = {
    name: "fake-container",
    renderResult: () => {
      const container = new Container();
      container.addChild(new Text("child-a"));
      container.addChild(new Text("child-b"));
      return container;
    },
  };
  const lines = renderToolResultLines(
    def,
    { content: [], details: {} },
    { expanded: true, isPartial: false },
    CONTEXT,
  );
  assert.ok(Array.isArray(lines), "应返回行数组");
  assert.ok(lines.some((line) => line.includes("child-a")), "应包含第一个子组件文本");
  assert.ok(lines.some((line) => line.includes("child-b")), "应包含第二个子组件文本");
});

test("renderCall 渲染器 → 输出调用渲染行", async () => {
  const { renderToolCallLines } = await loadSubject();
  const def = {
    name: "fake-call",
    renderCall: (args, theme, context) => new Text(`call ${args.query}`),
  };
  const lines = renderToolCallLines(def, { query: "search" }, CONTEXT);
  assert.ok(Array.isArray(lines), "应返回行数组");
  assert.ok(lines.some((line) => line.includes("call search")), "应包含调用渲染文本");
});

test("无渲染器（definition 无 renderResult/renderCall）→ null", async () => {
  const { renderToolResultLines, renderToolCallLines, getToolRenderResultRenderer, getToolRenderCallRenderer } = await loadSubject();
  const def = { name: "no-renderer", execute: () => {} };
  assert.equal(getToolRenderResultRenderer(def), undefined);
  assert.equal(getToolRenderCallRenderer(def), undefined);
  assert.equal(
    renderToolResultLines(def, {}, { expanded: true, isPartial: false }, CONTEXT),
    null,
  );
  assert.equal(renderToolCallLines(def, {}, CONTEXT), null);
});

test("非对象 definition → 返回 null（不抛）", async () => {
  const { renderToolResultLines, renderToolCallLines } = await loadSubject();
  assert.equal(renderToolResultLines(null, {}, { expanded: true, isPartial: false }, CONTEXT), null);
  assert.equal(renderToolCallLines(undefined, {}, CONTEXT), null);
});

test("渲染器抛错 → null（不向上抛）", async () => {
  const { renderToolResultLines, renderToolCallLines } = await loadSubject();
  const throwingDef = {
    name: "throws",
    renderResult: () => {
      throw new Error("render exploded");
    },
    renderCall: () => {
      throw new Error("call exploded");
    },
  };
  assert.doesNotThrow(() => {
    assert.equal(renderToolResultLines(throwingDef, {}, { expanded: true, isPartial: false }, CONTEXT), null);
    assert.equal(renderToolCallLines(throwingDef, {}, CONTEXT), null);
  });
});

test("渲染器返回非对象（无 render 方法）→ null", async () => {
  const { renderToolResultLines } = await loadSubject();
  const def = {
    name: "not-component",
    renderResult: () => ({ not: "a component" }),
  };
  assert.equal(renderToolResultLines(def, {}, { expanded: true, isPartial: false }, CONTEXT), null);
});

test("渲染器返回 null → null", async () => {
  const { renderToolResultLines } = await loadSubject();
  const def = {
    name: "null-component",
    renderResult: () => null,
  };
  assert.equal(renderToolResultLines(def, {}, { expanded: true, isPartial: false }, CONTEXT), null);
});

test("renderResult 字段为 ln（压缩字段名兼容）也能取到并渲染", async () => {
  const { getToolRenderResultRenderer, renderToolResultLines } = await loadSubject();
  const compressedDef = {
    name: "compressed",
    ln: (result, options, theme, context) => new Text("compressed render"),
  };
  assert.equal(typeof getToolRenderResultRenderer(compressedDef), "function", "ln 应被识别");
  const lines = renderToolResultLines(
    compressedDef,
    {},
    { expanded: true, isPartial: false },
    CONTEXT,
  );
  assert.ok(lines && lines.some((line) => line.includes("compressed render")), "ln 渲染器应产出行");
});

test("loadPiTheme 返回非 null Theme（dark.json 副本可加载）", async () => {
  const { loadPiTheme } = await loadSubject();
  const theme = loadPiTheme();
  assert.ok(theme, "主题副本应能加载");
  assert.equal(typeof theme.fg, "function");
  // 真实 ANSI 上色（truecolor 模式）：fg("text", "x") 应含 ESC 序列
  assert.match(theme.fg("text", "x"), /\x1b\[38;2;/);
});

test("渲染器收到的 theme/context 与签名一致（renderResult 4 参 / renderCall 3 参）", async () => {
  const { renderToolResultLines, renderToolCallLines } = await loadSubject();
  let seen = null;
  const resultDef = {
    name: "sig",
    renderResult: (result, options, theme, context) => {
      seen = { result, options, theme, context };
      return new Text("sig");
    },
  };
  renderToolResultLines(resultDef, { content: [], details: { ok: true } }, { expanded: true, isPartial: true }, CONTEXT);
  assert.deepEqual(seen.options, { expanded: true, isPartial: true });
  assert.deepEqual(seen.context, CONTEXT);
  assert.ok(seen.theme, "theme 应为非 null");
  assert.equal(seen.result.details.ok, true);

  let callSeen = null;
  const callDef = {
    name: "sig-call",
    renderCall: (args, theme, context) => {
      callSeen = { args, theme, context };
      return new Text("sig");
    },
  };
  renderToolCallLines(callDef, { query: "x" }, CONTEXT);
  assert.deepEqual(callSeen.args, { query: "x" });
  assert.deepEqual(callSeen.context, CONTEXT);
  assert.ok(callSeen.theme);
});

test("组件工厂返回 Text(theme.fg(...)) → 行含预期文本与 ANSI 码", async () => {
  const { renderWidgetFactoryLines, loadPiTheme } = await loadSubject();
  const theme = loadPiTheme();
  const factory = (_tui, th) => new Text(th.fg("accent", "Async agents"), 0, 0);
  const lines = renderWidgetFactoryLines(factory, theme);
  assert.ok(Array.isArray(lines), "应返回行数组");
  assert.ok(lines.some((line) => line.includes("Async agents")), "应包含工厂渲染文本");
  assert.ok(lines.some((line) => /\x1b\[/.test(line)), "应含 ANSI 转义码");
});

test("组件工厂返回 Container+多 Text → 多行", async () => {
  const { renderWidgetFactoryLines, loadPiTheme } = await loadSubject();
  const theme = loadPiTheme();
  const factory = (_tui, th) => {
    const container = new Container();
    container.addChild(new Text(th.fg("accent", "job-a")));
    container.addChild(new Text(th.fg("muted", "job-b")));
    return container;
  };
  const lines = renderWidgetFactoryLines(factory, theme);
  assert.ok(Array.isArray(lines), "应返回行数组");
  assert.ok(lines.some((line) => line.includes("job-a")), "应包含第一个子组件文本");
  assert.ok(lines.some((line) => line.includes("job-b")), "应包含第二个子组件文本");
  assert.ok(lines.length >= 2, "Container 子组件应产出多行");
});

test("组件工厂调用签名 (undefined, theme)", async () => {
  const { renderWidgetFactoryLines, loadPiTheme } = await loadSubject();
  const theme = loadPiTheme();
  let seen = null;
  const factory = (...args) => {
    seen = args;
    return new Text("sig");
  };
  renderWidgetFactoryLines(factory, theme);
  assert.equal(seen[0], undefined, "tui 参数应为 undefined");
  assert.equal(seen[1], theme, "theme 参数应为渲染桥主题");
});

test("工厂非函数（字符串/对象/undefined）→ null", async () => {
  const { renderWidgetFactoryLines, loadPiTheme } = await loadSubject();
  const theme = loadPiTheme();
  assert.equal(renderWidgetFactoryLines("not-a-factory", theme), null);
  assert.equal(renderWidgetFactoryLines({ render: () => [] }, theme), null);
  assert.equal(renderWidgetFactoryLines(undefined, theme), null);
});

test("工厂返回 null → null", async () => {
  const { renderWidgetFactoryLines, loadPiTheme } = await loadSubject();
  const theme = loadPiTheme();
  assert.equal(renderWidgetFactoryLines(() => null, theme), null);
});

test("工厂返回无 render 方法对象 → null", async () => {
  const { renderWidgetFactoryLines, loadPiTheme } = await loadSubject();
  const theme = loadPiTheme();
  assert.equal(renderWidgetFactoryLines(() => ({ not: "a component" }), theme), null);
});

test("工厂抛错 → null（不向上抛）", async () => {
  const { renderWidgetFactoryLines, loadPiTheme } = await loadSubject();
  const theme = loadPiTheme();
  assert.doesNotThrow(() => {
    assert.equal(
      renderWidgetFactoryLines(() => {
        throw new Error("factory exploded");
      }, theme),
      null,
    );
  });
});

test("theme 为 null → null", async () => {
  const { renderWidgetFactoryLines } = await loadSubject();
  assert.equal(renderWidgetFactoryLines(() => new Text("x"), null), null);
});

// ---------------------------------------------------------------------------
// 自定义消息渲染器（阶段 C）：registerMessageRenderer → headless ANSI 行
// ---------------------------------------------------------------------------

test("自定义消息渲染器：new Text(theme.fg(\"warning\", ...)) → 行含文本与 ANSI", async () => {
  const { renderCustomMessageLines, loadPiTheme } = await loadSubject();
  const theme = loadPiTheme();
  const renderer = (message, options, th) =>
    new Text(th.fg("warning", `⚠ Subagent paused: ${message.customType}`), 0, 0);
  const lines = renderCustomMessageLines(
    renderer,
    { customType: "subagent-control", content: [], display: true },
    theme,
  );
  assert.ok(Array.isArray(lines), "应返回行数组");
  assert.ok(
    lines.some((line) => line.includes("⚠ Subagent paused: subagent-control")),
    "应包含渲染文本",
  );
  assert.ok(lines.some((line) => /\x1b\[/.test(line)), "应含 ANSI 转义码");
});

test("自定义消息渲染器：undefined / 非函数 / 非组件 / 抛错 / theme null → null", async () => {
  const { renderCustomMessageLines, loadPiTheme } = await loadSubject();
  const theme = loadPiTheme();
  const message = { customType: "x", content: [] };
  assert.equal(renderCustomMessageLines(undefined, message, theme), null);
  assert.equal(renderCustomMessageLines("not-a-function", message, theme), null);
  assert.equal(renderCustomMessageLines({ render: () => [] }, message, theme), null);
  assert.equal(renderCustomMessageLines(() => undefined, message, theme), null);
  assert.equal(renderCustomMessageLines(() => null, message, theme), null);
  assert.equal(
    renderCustomMessageLines(() => ({ not: "a component" }), message, theme),
    null,
  );
  assert.doesNotThrow(() => {
    assert.equal(
      renderCustomMessageLines(
        () => {
          throw new Error("renderer exploded");
        },
        message,
        theme,
      ),
      null,
    );
  });
  assert.equal(
    renderCustomMessageLines(() => new Text("x"), message, null),
    null,
  );
});

test("自定义消息渲染器调用签名：message 原样传入、options.expanded === true、theme 为桥主题", async () => {
  const { renderCustomMessageLines, loadPiTheme } = await loadSubject();
  const theme = loadPiTheme();
  const message = {
    customType: "subagent-control",
    content: [{ type: "text", text: "hi" }],
    details: { status: "paused" },
  };
  let seen = null;
  const renderer = (...args) => {
    seen = args;
    return new Text("sig");
  };
  renderCustomMessageLines(renderer, message, theme);
  assert.equal(seen[0], message, "message 应原样传入（同一引用）");
  assert.deepEqual(seen[1], { expanded: true }, "options.expanded 应为 true");
  assert.equal(seen[2], theme, "theme 应为渲染桥主题");
});

// ---------------------------------------------------------------------------
// P1-6 / P2-8：渲染输出严格校验与上限
// ---------------------------------------------------------------------------

test("P2-8：混合数组（含非字符串元素）→ null（不再过滤后当成功）", async () => {
  const { renderToolResultLines } = await loadSubject();
  const def = {
    name: "mixed",
    renderResult: () => ({ render: () => ["合法", 42, "也合法"] }),
  };
  assert.equal(renderToolResultLines(def, {}, { expanded: true, isPartial: false }, CONTEXT), null);
});

test("P2-8：空数组 → null", async () => {
  const { renderToolResultLines } = await loadSubject();
  const def = {
    name: "empty",
    renderResult: () => ({ render: () => [] }),
  };
  assert.equal(renderToolResultLines(def, {}, { expanded: true, isPartial: false }, CONTEXT), null);
});

test("P1-6：超最大行数 → null（走原始回退，不截断）", async () => {
  const { renderToolResultLines, RENDER_MAX_LINES } = await loadSubject();
  const def = {
    name: "many-lines",
    renderResult: () => ({ render: () => Array(RENDER_MAX_LINES + 1).fill("x") }),
  };
  assert.equal(renderToolResultLines(def, {}, { expanded: true, isPartial: false }, CONTEXT), null);
});

test("P1-6：单行超最大长度 → null", async () => {
  const { renderToolResultLines, RENDER_MAX_LINE_LENGTH } = await loadSubject();
  const def = {
    name: "long-line",
    renderResult: () => ({ render: () => ["y".repeat(RENDER_MAX_LINE_LENGTH + 1)] }),
  };
  assert.equal(renderToolResultLines(def, {}, { expanded: true, isPartial: false }, CONTEXT), null);
});

test("P1-6：总字符超上限 → null", async () => {
  const { renderToolResultLines, RENDER_MAX_TOTAL_CHARS, RENDER_MAX_LINES } = await loadSubject();
  const def = {
    name: "big-total",
    renderResult: () => ({
      render: () => Array(RENDER_MAX_LINES).fill("z".repeat(Math.ceil(RENDER_MAX_TOTAL_CHARS / RENDER_MAX_LINES) + 1)),
    }),
  };
  assert.equal(renderToolResultLines(def, {}, { expanded: true, isPartial: false }, CONTEXT), null);
});

test("P1-6：边界内输出正常通过（行数/单行/总字符均在限内）", async () => {
  const { renderToolResultLines, RENDER_MAX_LINES, RENDER_MAX_LINE_LENGTH, RENDER_MAX_TOTAL_CHARS } = await loadSubject();
  // 总字符恰好不超上限：用 sqrt 组合保证在界内
  const chunk = "a".repeat(100);
  const count = Math.floor(RENDER_MAX_TOTAL_CHARS / chunk.length / 10);
  const def = {
    name: "within-limits",
    renderResult: () => ({
      render: () => Array(Math.min(count, RENDER_MAX_LINES)).fill(chunk.repeat(1)),
    }),
  };
  const lines = renderToolResultLines(def, {}, { expanded: true, isPartial: false }, CONTEXT);
  assert.ok(Array.isArray(lines), "界内输出应通过");
  assert.ok(lines.every((l) => l.length <= RENDER_MAX_LINE_LENGTH), "单行不超限");
});

// ---------------------------------------------------------------------------
// P0-1：onComponent 回调（上层记录「上一组件」用）
// ---------------------------------------------------------------------------

test("P0-1：renderToolResultLines 渲染器返回组件时回调 onComponent（组件原样传入）", async () => {
  const { renderToolResultLines } = await loadSubject();
  const component = { render: () => ["line"] };
  const def = {
    name: "cb",
    renderResult: () => component,
  };
  let seen = null;
  const lines = renderToolResultLines(
    def,
    {},
    { expanded: true, isPartial: false },
    CONTEXT,
    (c) => {
      seen = c;
    },
  );
  assert.ok(Array.isArray(lines), "渲染行应产出");
  assert.equal(seen, component, "onComponent 应收到渲染器返回的组件");
});

test("P0-1：渲染器返回 undefined / 非对象时不回调 onComponent", async () => {
  const { renderToolResultLines } = await loadSubject();
  let called = 0;
  const def = {
    name: "cb-none",
    renderResult: () => undefined,
  };
  renderToolResultLines(
    def,
    {},
    { expanded: true, isPartial: false },
    CONTEXT,
    () => {
      called += 1;
    },
  );
  assert.equal(called, 0, "无组件不回调");
});
