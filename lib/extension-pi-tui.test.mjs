/**
 * 图片能力挂在**扩展实际使用的那一份 pi-tui** 上（issue #104 审查 P0-1）。
 *
 * 背景：pi-tui 的能力缓存是模块级状态，而磁盘上可能同时存在两份 pi-tui —— 顶层一份与
 * SDK 自带的一份（`node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui`）。
 * 扩展由 SDK 的 loader 加载、走它自己的 pi-tui 别名；宿主若在**顶层那份**上置位，
 * 插件里的 `Image` 读不到，永远只会渲染成一句降级说明。
 *
 * 这里刻意不复用假钩子（`setPiImageCapabilityHooks`），因为那正是当初漏掉这个问题的原因：
 * 假钩子只证明「渲染桥会调用钩子」，证明不了「钩子挂在插件看得见的那份实例上」。
 * 本文件用**独立解析出来的扩展实例**构造真实 `Image`，渲染桥的钩子来自宿主模块的生产接线。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { renderComponentOutput } = await jiti.import("./tui-render-bridge.ts");
const { extensionPiTui } = await jiti.import("./sdk-session-host.ts");

/** 扩展 loader 看到的那份 pi-tui：以 SDK 的 package.json 为基准解析，与生产解析同一条路径。 */
function resolveExtensionInstanceForTest() {
  const sdkRoot = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");
  const requireFromSdk = createRequire(join(sdkRoot, "package.json"));
  return requireFromSdk("@earendil-works/pi-tui");
}

const PNG_8x8 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAhklEQVR4nBXOMREAUQjE0C8FKUhBClKQQrkycLKXK99Mirz35HhyPrme3Hjw4sPvhRwhZ8gVcuPBiy/+IOVIOVOulBsPXnz5ByVHyVlyldx48OKrP2gemofmoXnAgxdf/8HwMDwMD8MDHrz45g+Wh+VheVge8ODFt39wPBwPx8PxgAcvPvwBOiepwejCcHUAAAAASUVORK5CYII=";

function makeRealImage(instance) {
  return new instance.Image(
    PNG_8x8,
    "image/png",
    { fallbackColor: (str) => str },
    { maxWidthCells: 12 },
    { widthPx: 64, heightPx: 64 },
  );
}

test("宿主解析到的 pi-tui 实例 = 扩展 loader 解析到的那份（两份并存时不能是顶层那份）", () => {
  const extensionInstance = resolveExtensionInstanceForTest();
  assert.equal(
    extensionPiTui,
    extensionInstance,
    "能力是模块级状态：宿主必须对扩展看得见的那份实例读写，否则插件的 Image 永远走降级文本",
  );
});

test("真实组件 + 生产接线：渲染期间那份实例拿到 kitty，Image 输出序列而不是降级文本，渲染后还原", () => {
  const extensionInstance = resolveExtensionInstanceForTest();
  const before = extensionInstance.getCapabilities().images;
  const image = makeRealImage(extensionInstance);
  let during = null;
  let ownLines = null;
  const component = {
    render: (width) => {
      during = extensionInstance.getCapabilities().images;
      ownLines = image.render(width);
      return ["QA-BEGIN", ...ownLines, "QA-END"];
    },
  };

  const output = renderComponentOutput(component, 80);

  assert.equal(during, "kitty", "渲染那一刻扩展那份实例必须看到 kitty");
  assert.ok(
    String(ownLines[0]).startsWith("\u001b_G"),
    `组件自己那一帧必须是 Kitty 序列，实际是 ${JSON.stringify(String(ownLines[0]).slice(0, 40))}`,
  );
  assert.doesNotMatch(String(ownLines.join("\n")), /\[Image:/, "不能是 pi-tui 的降级文本");
  assert.equal(extensionInstance.getCapabilities().images, before, "渲染结束必须还原（进程全局）");
  assert.equal(output.images.length, 1, "序列要被摘成一张结构化图片");
  assert.equal(output.images[0].mime, "image/png");
  assert.equal(output.images[0].base64.length, PNG_8x8.length);
  assert.equal(output.lines.join("\n").includes("\u001b_G"), false, "文本侧不再残留序列");
});

test("连续两次渲染：每次都打开、每次都还原（不留成 kitty）", () => {
  const extensionInstance = resolveExtensionInstanceForTest();
  const before = extensionInstance.getCapabilities().images;
  for (let i = 0; i < 2; i += 1) {
    const image = makeRealImage(extensionInstance);
    const output = renderComponentOutput({ render: (width) => image.render(width) }, 80);
    assert.equal(output.images.length, 1, `第 ${i + 1} 次也要摘到图`);
    assert.equal(extensionInstance.getCapabilities().images, before, `第 ${i + 1} 次渲染后要还原`);
  }
});

test("接线契约：宿主的能力钩子读写的就是解析出来的那份实例", () => {
  const source = readFileSync(new URL("./sdk-session-host.ts", import.meta.url), "utf8");
  assert.match(source, /getImages: \(\) => extensionPiTui\.getCapabilities\(\)\.images/, "钩子必须读 extensionPiTui");
  assert.match(source, /extensionPiTui\.setCapabilities\(/, "钩子必须写 extensionPiTui");
  assert.doesNotMatch(
    source,
    /getImages: \(\) => getTuiCapabilities\(\)/,
    "不能再用顶层那份（两份并存时它和扩展看到的不是同一个模块实例）",
  );
});
