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

test("MessageImage：实现了上方预览块、缩放/移动和原图下载契约", () => {
  const source = readFileSync(fileURLToPath(new URL("./MessageImage.tsx", import.meta.url)), "utf8");
  assert.ok(source.includes("ImagePreviewPanel"));
  assert.ok(source.includes("openImagePreview"));
  assert.ok(source.includes("onPointerMove"));
  assert.ok(source.includes("onWheel"));
  assert.ok(source.includes("download={preview.downloadName}"));
});
