/**
 * 附件路径注入块：把「这次消息带上的文件/图片在哪」写进消息正文。
 *
 * 普通附件和图片原图都注入绝对路径 —— agent 要用原图（分辨率、EXIF、裁切、OCR）时
 * 直接读就行，不必先去附件目录里猜文件名，也不会猜错到别的会话的图上。
 *
 * 刻意沿用 `path=` 前缀：lib/file-types.ts 的 extractMediaPathsFromText 只在路径前是
 * 空白、引号或 `- ` 时才把它当作正文路径交给 MessageMediaGallery 渲染；`path=` 后面
 * 不匹配，所以图片不会再被渲染成第二张卡片。
 */
export interface AttachmentPromptLists {
  /** 普通附件（非图片）的落盘路径。 */
  files: readonly string[];
  /** 图片原图路径：内联给模型的只是安全尺寸副本。 */
  images: readonly string[];
}

export interface AttachmentPromptHeaders {
  files: string;
  images: string;
}

/** 拼注入块；两个列表都空时返回空串（调用方据此不加空行）。 */
export function buildAttachmentPrompt(
  lists: AttachmentPromptLists,
  headers: AttachmentPromptHeaders,
): string {
  const blocks: string[] = [];
  const render = (header: string, paths: readonly string[]) => {
    if (paths.length === 0) return;
    blocks.push(`${header}\n${paths.map((path) => `- path=${path}`).join("\n")}`);
  };
  render(headers.files, lists.files);
  render(headers.images, lists.images);
  return blocks.join("\n\n");
}
