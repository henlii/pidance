import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageImage } = await jiti.import("./MessageImage.tsx");
const { BinaryMessageView, DIRECT_MEDIA_PLAY_MAX_BYTES } = await jiti.import("./BinaryMessageView.tsx");
const { MessageView } = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("../lib/i18n.tsx");

function render(component) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null, component),
  );
}

test("MessageImage：缩略图可打开输入框上方的预览块", () => {
  const html = render(React.createElement(MessageImage, {
    src: "data:image/png;base64,QUJD",
    fullSrc: "/original.png",
    downloadHref: "/original.png?type=download",
    downloadName: "original.png",
    alt: "original",
  }));

  assert.match(html, /<button[^>]*aria-label="Open image"/);
  assert.ok(html.includes('aria-label="Open image"'));
  assert.ok(html.includes("data:image/png;base64,QUJD"));
  assert.ok(!html.includes('download="original.png"'), "dialog closed时不应提前渲染下载层");
});

test("MessageView：user/assistant 原生图片块都接入可点击预览", () => {
  const image = { type: "image", data: "QUJD", mimeType: "image/png" };
  const userHtml = render(React.createElement(MessageView, {
    message: { role: "user", content: [image], timestamp: Date.now() },
  }));
  const assistantHtml = render(React.createElement(MessageView, {
    message: {
      role: "assistant",
      content: [image],
      provider: "test",
      model: "test-model",
      stopReason: "stop",
    },
  }));
  assert.equal((userHtml.match(/aria-label="Open image"/g) || []).length, 1);
  assert.equal((assistantHtml.match(/aria-label="Open image"/g) || []).length, 1);
});

test("BinaryMessageView：超过 25 MB 的音视频不创建直播放器，但保留原文件下载", () => {
  const html = render(React.createElement(BinaryMessageView, {
    binary: {
      type: "binary",
      version: 1,
      kind: "video",
      path: "/tmp/pidance-attachments/movie.mp4",
      name: "movie.mp4",
      mimeType: "video/mp4",
      size: DIRECT_MEDIA_PLAY_MAX_BYTES + 1,
    },
  }));

  assert.ok(html.includes("movie.mp4"));
  assert.ok(html.includes("media is over 25 MB"));
  assert.ok(html.includes("type=download"));
  assert.ok(!html.includes("<video"));
});

test("MessageImage：全屏遮罩查看原图 + 缩放/拖动/下载契约", () => {
  const source = readFileSync(fileURLToPath(new URL("./MessageImage.tsx", import.meta.url)), "utf8");
  // 查看器改为全屏遮罩：不再有输入区上方的内嵌面板。
  assert.ok(source.includes("ImagePreviewOverlay"), "应导出全屏遮罩组件");
  assert.ok(!source.includes("ImagePreviewPanel"), "不得再保留上方内嵌面板");
  assert.ok(source.includes("createPortal"), "遮罩应 portal 到 body，不受聊天容器裁剪");
  assert.ok(source.includes("openImagePreview"));
  // fullSrc 才是原图：遮罩必须显示原图而不是缩略图。
  assert.ok(source.includes("src: resolvedFullSrc"), "打开时应使用原图地址");
  // 高度不再被 vh 常量限制（旧实现是 min(34vh, 360px)）。
  assert.ok(!/maxHeight:\s*"min\(34vh/.test(source), "不得再有内嵌面板的高度上限");
  assert.ok(source.includes("onPointerMove"));
  assert.ok(source.includes("onWheel"));
  assert.ok(source.includes("download={preview.downloadName}"));
  // 视觉视口定位：软键盘/缩放时不跑偏。
  assert.ok(source.includes("readDialogViewportRect"));
});

test("图片查看器：缩小/拖动后必须收敛平移量（缩回 100% 即居中）", () => {
  const source = readFileSync(fileURLToPath(new URL("./MessageImage.tsx", import.meta.url)), "utf8");
  // transform 是 translate 在外层、不受 scale 影响，所以改 zoom 必须显式收敛 offset。
  assert.ok(source.includes("clampOffset"), "应有平移量收敛函数");
  assert.ok(
    /setOffset\(\(current\) => clampOffset\(current, next\)\)/.test(source),
    "缩放变化时必须同步收敛平移量",
  );
  // 允许位移 =(渲染尺寸 × 缩放 − 可视区) / 2，下限 0；缩回 MIN_ZOOM 时直接归零。
  assert.ok(/zoomLevel <= MIN_ZOOM\) return \{ x: 0, y: 0 \}/.test(source), "100% 时必须归零居中");
  assert.ok(
    /Math\.max\(0, \(img\.offsetWidth \* zoomLevel - availWidth\) \/ 2\)/.test(source),
    "上限按图片渲染尺寸与可视区之差计算",
  );
  // 拖动过程同样受限，避免把图拖出可视区。
  assert.ok(/setOffset\(clampOffset\(\{ x: drag\.offsetX \+ dx/.test(source), "拖动时应受限");
  // 视口变化（旋转/软键盘）后重新收敛。
  assert.ok(/setOffset\(\(current\) => clampOffset\(current, zoom\)\)/.test(source), "视口变化后应重新收敛");
});
