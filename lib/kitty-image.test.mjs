/**
 * Kitty 图形序列解析（issue #104）：纯函数边界。
 *
 * 覆盖协议的两条形态（单块 / 分块）以及**降级**路径 —— 降级必须是可见的
 * （要么是 `<img>`，要么是一句说明），不能静默丢成空行。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  extractKittyImages,
  withImageFallbackLines,
  MAX_KITTY_IMAGE_BASE64,
  MAX_KITTY_TOTAL_BASE64,
  collectImageLineIndexes,
  remapImageLineIndexes,
} = await jiti.import("./kitty-image.ts");

const ESC = "\u001b";
const seq = (params, payload) => `${ESC}_G${params}${payload === undefined ? "" : ";" + payload}${ESC}\\`;

/** 一张小图（PNG 的 base64 前缀是 iVBORw0KGgo）。 */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGZ0Z2QAAAAAElFTkSuQmCC";

test("单块 a=T：摘出图片，原位置留空行", () => {
  const line = seq("a=T,f=100,q=2,i=7,c=12,r=4", PNG);
  const out = extractKittyImages(["before", line, "", "", ""]);

  assert.equal(out.images.length, 1);
  assert.equal(out.fallbacks.length, 0);
  const image = out.images[0];
  assert.equal(image.id, "7");
  assert.equal(image.mime, "image/png");
  assert.equal(image.base64, PNG);
  assert.equal(image.cols, 12);
  assert.equal(image.rows, 4);
  assert.equal(image.lineIndex, 1, "图片要留在原来那一行的位置");
  assert.equal(out.lines[1], "", "序列被摘走后该行是空行（后续 rows-1 行本来就是空行）");
  assert.equal(out.lines[0], "before");
});

test("分块 m=1…m=0：按 i= 拼接成一张图", () => {
  const first = seq("a=T,f=100,q=2,i=9,c=20,r=10,m=1", "AAAA");
  const middle = seq("m=1", "BBBB");
  const last = seq("m=0", "CCCC");
  const out = extractKittyImages([first + middle + last]);

  assert.equal(out.images.length, 1);
  assert.equal(out.images[0].base64, "AAAABBBBCCCC");
  assert.equal(out.images[0].cols, 20);
  assert.equal(out.images[0].rows, 10);
  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0], "");
});

test("缺 c= / r= 时按 1×1 处理（组件没写尺寸的兜底）", () => {
  const out = extractKittyImages([seq("a=T,f=100,i=3", PNG)]);
  assert.equal(out.images.length, 1);
  assert.equal(out.images[0].cols, 1);
  assert.equal(out.images[0].rows, 1);
});

test("非 PNG 的 f=：不支持 → 记一条可见降级（不发不可显示的载荷）", () => {
  const out = extractKittyImages([seq("a=T,f=24,i=4,c=2,r=2", "AAAA")]);
  assert.equal(out.images.length, 0);
  assert.deepEqual(out.fallbacks, [{ lineIndex: 0, reason: "unsupported-format" }]);
});

test("分块不完整（没有 m=0）：不显示半张图", () => {
  const out = extractKittyImages([seq("a=T,f=100,i=5,m=1", "AAAA")]);
  assert.equal(out.images.length, 0);
  assert.equal(out.fallbacks.length, 1);
  assert.equal(out.fallbacks[0].reason, "incomplete");
});

test("删除指令 a=d 与只放置 a=p 不产出图片", () => {
  const out = extractKittyImages([seq("a=d,d=I,i=6,q=2"), seq("a=p,i=6", "")]);
  assert.equal(out.images.length, 0);
  assert.equal(out.fallbacks.length, 0);
  assert.deepEqual(out.lines, ["", ""]);
});

test("超单张上限 → 降级为可见说明，不抛错也不吞掉同段文本", () => {
  const huge = "A".repeat(MAX_KITTY_IMAGE_BASE64 + 8);
  const out = extractKittyImages(["文本仍在", seq(`a=T,f=100,i=8,m=1`, huge.slice(0, 2 * 1024 * 1024)) + seq("m=0", huge.slice(2 * 1024 * 1024))]);
  assert.equal(out.images.length, 0);
  assert.equal(out.fallbacks[0].reason, "too-large");
  assert.equal(out.lines[0], "文本仍在", "同一次渲染里的普通文本不受影响");
});

test("超合计上限 → 后面的图降级（前面的仍保留）", () => {
  const half = "A".repeat(MAX_KITTY_IMAGE_BASE64);
  const out = extractKittyImages([
    seq("a=T,f=100,i=1,r=2", half),
    seq("a=T,f=100,i=2,r=2", half),
    seq("a=T,f=100,i=3,r=2", half),
  ]);
  assert.equal(MAX_KITTY_TOTAL_BASE64, MAX_KITTY_IMAGE_BASE64 * 2);
  assert.deepEqual(out.images.map((i) => i.id), ["1", "2"]);
  assert.deepEqual(out.fallbacks, [{ lineIndex: 2, reason: "too-large" }]);
  assert.equal(out.lines.length, 3);
});

test("空载荷 / 坏 base64 → 降级而不是发坏数据", () => {
  const empty = extractKittyImages([seq("a=T,f=100,i=1", "")]);
  assert.deepEqual(empty.fallbacks, [{ lineIndex: 0, reason: "empty" }]);

  const bad = extractKittyImages([seq("a=T,f=100,i=2", "not base64!!")]);
  assert.equal(bad.images.length, 0);
  assert.equal(bad.fallbacks[0].reason, "unsupported-format");
});

test("同一行里序列前后的文字都保留（序列不在行首也不丢内容）", () => {
  const out = extractKittyImages([`前置${seq("a=T,f=100,i=1", PNG)}后置`]);
  assert.equal(out.lines[0], "前置后置");
  assert.equal(out.images.length, 1);
});

test("没有序列的行原样返回（快路径不复制、不改内容）", () => {
  const lines = ["普通一行", "", "另一行"];
  const out = extractKittyImages(lines);
  assert.deepEqual(out.lines, lines);
  assert.equal(out.images.length, 0);
  assert.equal(out.fallbacks.length, 0);
});

test("没有终止符的半截序列按文本保留（不吞内容）", () => {
  const out = extractKittyImages([`${ESC}_Ga=T,f=100,i=1;AAAA`]);
  assert.equal(out.lines[0], `${ESC}_Ga=T,f=100,i=1;AAAA`);
  assert.equal(out.images.length, 0);
});

test("withImageFallbackLines：不支持图片的消费方拿到可见说明，且行数不变", () => {
  const out = extractKittyImages([seq("a=T,f=100,i=1", PNG), "", seq("a=T,f=24,i=2", "AAAA")]);
  const lines = withImageFallbackLines(out);
  assert.equal(lines.length, out.lines.length);
  assert.equal(lines[0], "[image: image/png]");
  assert.equal(lines[2], "[image: unsupported-format]");
});

test("withImageFallbackLines：没有图片时原样返回同一份引用（不白复制）", () => {
  const out = extractKittyImages(["a", "b"]);
  assert.equal(withImageFallbackLines(out), out.lines);
});

// issue #104 审查 P0-3：面板会在显示前删框线/裁首尾空白行，而图片按**原文行号**标注，
// 所以既要保护锚点行不被裁掉，又要把行号重排到归一化后的位置。
test("collectImageLineIndexes：锚点与它铺开的 rows-1 行都要保护", () => {
  const kept = collectImageLineIndexes(
    [{ lineIndex: 2, rows: 3 }],
    [{ lineIndex: 7 }],
  );
  assert.deepEqual([...kept].sort((a, b) => a - b), [2, 3, 4, 7], "锚点 + 覆盖行 + 降级说明位置");
});

test("collectImageLineIndexes：坏数据不抛错也不产生非法行号", () => {
  const kept = collectImageLineIndexes(
    [{ lineIndex: -1, rows: 2 }, { lineIndex: 1.5, rows: 4 }, { rows: 2 }],
    null,
  );
  assert.deepEqual([...kept], [], "负数/非有限/缺失行号一律忽略");
});

test("remapImageLineIndexes：按映射改行号，映射不到的被丢弃并计数", () => {
  const remapped = remapImageLineIndexes(
    [{ lineIndex: 2, id: "a" }, { lineIndex: 9, id: "b" }],
    [2, 3, 5],
  );
  assert.deepEqual(remapped.items, [{ lineIndex: 0, id: "a" }], "原文第 2 行现在是第 0 行");
  assert.equal(remapped.dropped, 1, "原文第 9 行没映射到 → 丢弃并计数");
});

test("remapImageLineIndexes：恒等映射时原样返回（常规路径不受影响）", () => {
  const items = [{ lineIndex: 0, id: "a" }, { lineIndex: 2, id: "b" }];
  const remapped = remapImageLineIndexes(items, [0, 1, 2]);
  assert.deepEqual(remapped.items, items);
  assert.equal(remapped.dropped, 0);
});

test("缺 f= 不能被当成 PNG（Kitty 默认是 f=32 的 RGBA）：走可见降级", () => {
  const out = extractKittyImages([seq("a=T,i=42", PNG)]);
  assert.equal(out.images.length, 0, "不能当成 PNG 发下去");
  assert.deepEqual(out.fallbacks, [{ lineIndex: 0, reason: "unsupported-format" }]);
});

test("未收尾的分块把降级说明记在它自己那一行（不是最后一行）", () => {
  const out = extractKittyImages([
    seq("a=T,f=100,i=1,m=1", "AAAA"),
    "中间的正文",
    seq("a=T,f=100,i=2,m=1", "BBBB"),
  ]);
  assert.deepEqual(out.fallbacks.map((f) => f.lineIndex).sort((a, b) => a - b), [0, 2], "两张未完成图各记在自己那行");
});

// 防漂移：新增一个降级原因却忘了补文案时，界面会退回显示英文码值。
test("每个降级原因都有中英文案（imageFallbackReasonKey 不允许有落空的码值）", async () => {
  const { imageFallbackReasonKey } = await jiti.import("./kitty-image.ts");
  const { en } = await jiti.import("./locales/en.ts");
  const { zhCN } = await jiti.import("./locales/zh-CN.ts");
  const reasons = ["too-large", "unsupported-format", "incomplete", "empty"];
  for (const reason of reasons) {
    const key = imageFallbackReasonKey(reason);
    assert.ok(key, `${reason} 必须有 i18n 键`);
    assert.equal(typeof en[key], "string", `en 缺 ${key}`);
    assert.equal(typeof zhCN[key], "string", `zh-CN 缺 ${key}`);
  }
  assert.equal(imageFallbackReasonKey("future-reason"), null, "未知原因返回 null（调用方退回显示码值）");
});
