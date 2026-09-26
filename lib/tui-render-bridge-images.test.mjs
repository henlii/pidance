/**
 * 渲染桥的图片路径（issue #104）：
 * 1) 渲染期间临时打开图片能力、渲染后**还原**（进程全局，不能长期置位）；
 * 2) **先摘图、再过文本上限** —— 否则一张图的 base64 会把整段渲染（含正常文本）判成超限丢掉。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  renderComponentOutput,
  renderComponentLines,
  setPiImageCapabilityHooks,
  getPiImageCapabilityForTests,
  RENDER_MAX_LINE_LENGTH,
} = await jiti.import("./tui-render-bridge.ts");

const ESC = "\u001b";
const sequence = (params, payload) => `${ESC}_G${params};${payload}${ESC}\\`;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGZ0Z2QAAAAAElFTkSuQmCC";

function installHooks(initial) {
  const calls = [];
  let current = initial;
  setPiImageCapabilityHooks({
    getImages: () => current,
    setImages: (value) => {
      calls.push(value);
      current = value;
    },
  });
  return { calls, read: () => current };
}

test("渲染期间打开图片能力，渲染后还原成原值（不能长期置位）", () => {
  const hooks = installHooks(null);
  try {
    const seen = [];
    const component = {
      render: () => {
        seen.push(getPiImageCapabilityForTests());
        return ["文本"];
      },
    };
    const output = renderComponentOutput(component);
    assert.deepEqual(output.lines, ["文本"]);
    assert.deepEqual(seen, ["kitty"], "渲染那一刻能力必须是 kitty（插件的 Image 才会编码序列）");
    assert.equal(hooks.read(), null, "渲染结束必须还原（进程全局，不能留成 kitty）");
    assert.deepEqual(hooks.calls, ["kitty", null]);
  } finally {
    setPiImageCapabilityHooks(null);
  }
});

test("原本已是 kitty 时：还原成 kitty（不把宿主自己的设定抹掉）", () => {
  const hooks = installHooks("kitty");
  try {
    renderComponentOutput({ render: () => ["x"] });
    assert.equal(hooks.read(), "kitty");
    assert.deepEqual(hooks.calls, ["kitty", "kitty"]);
  } finally {
    setPiImageCapabilityHooks(null);
  }
});

test("渲染抛错也要还原能力（finally 语义）", () => {
  const hooks = installHooks(null);
  try {
    const output = renderComponentOutput({
      render: () => {
        throw new Error("boom");
      },
    });
    assert.equal(output, null);
    assert.equal(hooks.read(), null, "抛错路径同样必须还原");
  } finally {
    setPiImageCapabilityHooks(null);
  }
});

test("先摘图后校验：一张超长 base64 不会把同段的正常文本一起丢掉", () => {
  const huge = "A".repeat(RENDER_MAX_LINE_LENGTH + 5000);
  const component = {
    render: () => ["正常文本", sequence("a=T,f=100,i=1,c=8,r=3", huge), "", ""],
  };
  const output = renderComponentOutput(component);
  assert.ok(output, "摘走图片后这份渲染是合法的（旧行为会整段判超限返回 null）");
  assert.equal(output.lines[0], "正常文本");
  assert.equal(output.lines[1], "", "图片那条序列被摘走后留空行");
  assert.equal(output.images.length, 1);
  assert.equal(output.images[0].lineIndex, 1);
  assert.equal(output.images[0].rows, 3);
});

test("旧接口（string[]）仍然可用：图片位置换成可见说明，而不是空白", () => {
  const component = { render: () => [`前置${sequence("a=T,f=100,i=2,c=4,r=1", PNG)}`] };
  const lines = renderComponentLines(component);
  assert.deepEqual(lines, ["前置 [image: image/png]"], "同行文字要保留（只追加说明，不整行覆盖）");
});

test("没有注入钩子时渲染照常（能力不动），且不再吞掉正常文本", () => {
  setPiImageCapabilityHooks(null);
  try {
    const output = renderComponentOutput({ render: () => ["文本仍在这一行"] });
    assert.deepEqual(output.lines, ["文本仍在这一行"]);
    assert.deepEqual(output.images, []);
  } finally {
    setPiImageCapabilityHooks(null);
  }
});
