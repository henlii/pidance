import assert from "node:assert/strict";
import test from "node:test";

import { buildAttachmentPrompt } from "./attachment-prompt.ts";
import { extractMediaPathsFromText } from "./file-types.ts";

const HEADERS = { files: "文件头：", images: "图片头：" };

test("附件注入块：文件和图片各自成段，都空则不加空行", () => {
  assert.equal(buildAttachmentPrompt({ files: [], images: [] }, HEADERS), "");

  assert.equal(
    buildAttachmentPrompt({ files: ["/tmp/a.pdf"], images: [] }, HEADERS),
    "文件头：\n- path=/tmp/a.pdf",
  );

  assert.equal(
    buildAttachmentPrompt({ files: [], images: ["/home/moss/.pi/agent/pidance-attachments/x.jpg"] }, HEADERS),
    "图片头：\n- path=/home/moss/.pi/agent/pidance-attachments/x.jpg",
  );
});

test("附件注入块：文件和图片同时存在时两段用空行隔开，顺序稳定", () => {
  const block = buildAttachmentPrompt(
    { files: ["/tmp/a.pdf", "/tmp/b.zip"], images: ["/tmp/p.png"] },
    HEADERS,
  );
  assert.equal(
    block,
    "文件头：\n- path=/tmp/a.pdf\n- path=/tmp/b.zip\n\n图片头：\n- path=/tmp/p.png",
  );
});

test("附件注入块：图片路径不会被当成正文路径重复渲染成第二张卡片", () => {
  const imagePath = "/home/moss/.pi/agent/pidance-attachments/x.png";
  const block = buildAttachmentPrompt({ files: [], images: [imagePath] }, HEADERS);

  // 现状：MessageMediaGallery 只认「空行/引号/`- ` 开头的裸路径」，
  // path= 前缀不匹配，所以图片只由二进制块渲染一次。
  assert.deepEqual(extractMediaPathsFromText(block), { images: [], audio: [], video: [] });
  // 反向确认这条约束真的存在：换成裸列表项就会被抓走（会渲染两遍）。
  assert.deepEqual(extractMediaPathsFromText(`图片头：\n- ${imagePath}`).images, [imagePath]);
  // 图片在正文里不出现裸路径，只有 path= 一行。
  assert.equal(block.includes(`- ${imagePath}`), false);
});
