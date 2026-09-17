"use client";

/**
 * 附件上传与引用（issue #42 / A11 后续）。
 *
 * 规则：附件**进入输入框就先上传**，输入框与队列都只持引用（见 lib/types.ts 的
 * AttachedImageMedia）。好处是入队不必携带 base64、草稿/回执小、删除输入框附件
 * 就能真的把字节回收掉，而不是留一堆无人引用的文件。
 *
 * 失败一律抛出，由 UI 决定「阻塞发送 + 重试」——静默降级成「只发文字」正是
 * issue #42 要消灭的行为。
 */

import { prepareImageForModel, prepareImagePreview } from "./image-input";
import { encodeFilePathForApi } from "./file-paths";
import type {
  AttachedImage,
  AttachedImageMedia,
  BinaryMessageInput,
  UploadedMedia,
} from "./types";
import type { QueuedMediaRef } from "./session-queue";
import type { PromptImageInput } from "./agent-commands";

/** 落盘文件名的扩展名由 MIME 决定：服务端下发的 Content-Type 跟它一致。 */
const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

export function mediaExtension(mimeType: string): string {
  const normalized = mimeType.split(";")[0]!.trim().toLowerCase();
  return MIME_EXTENSIONS[normalized] ?? "bin";
}

/** 上传到 Pidance 附件目录（不依赖项目 cwd）。 */
export async function uploadMessageMedia(
  body: Blob,
  name: string,
  mimeType: string,
): Promise<UploadedMedia> {
  const contentType = mimeType || body.type || "application/octet-stream";
  const res = await fetch("/api/message-media", {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "X-Pidance-Filename": encodeURIComponent(name || "file"),
    },
    body,
  });
  const data = (await res.json().catch(() => ({}))) as Partial<UploadedMedia> & { error?: string };
  if (
    !res.ok ||
    typeof data.path !== "string" ||
    typeof data.storedName !== "string" ||
    typeof data.size !== "number" ||
    typeof data.name !== "string"
  ) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return {
    path: data.path,
    name: data.name,
    storedName: data.storedName,
    size: data.size,
    mimeType: data.mimeType || contentType,
  };
}

/** 回收附件字节（用户从输入框移除附件 / 清草稿）。失败不抛：GC 会兜底。 */
export async function deleteAttachmentMedia(paths: readonly string[]): Promise<void> {
  const unique = [...new Set(paths.filter((path) => typeof path === "string" && path.length > 0))];
  if (unique.length === 0) return;
  try {
    await fetch("/api/message-media", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: unique }),
    });
  } catch {
    // 忽略：文件留在盘上由兜底回收处理，不能因为清理失败影响交互
  }
}

/** 附件目录内的文件 → 可直接当 <img src> 用的读取 URL（目录在授权根内）。 */
export function attachmentReadUrl(path: string, mimeType?: string): string {
  const params = new URLSearchParams({ type: "read" });
  if (mimeType) params.set("mime", mimeType);
  return `/api/files/${encodeFilePathForApi(path)}?${params.toString()}`;
}

/**
 * 输入框图片 → 提交给 Host 的图片输入。
 *
 * 优先用已上传的模型副本引用：Host 自己从盘上回读字节，客户端不必重新读回
 * base64（草稿/取回的图在浏览器内存里已经没字节了）。内联 base64 只在没有
 * 引用可用时当兼容路径。
 */
export function promptImageInputs(images: readonly AttachedImage[] | undefined): PromptImageInput[] | undefined {
  if (!images?.length) return undefined;
  const inputs: PromptImageInput[] = [];
  for (const image of images) {
    if (image.media) {
      inputs.push({ type: "ref", path: image.media.model.path, mimeType: image.media.model.mimeType });
      continue;
    }
    if (image.data) {
      inputs.push({ type: "image", data: image.data, mimeType: image.mimeType });
      continue;
    }
    if (image.original) {
      inputs.push({ type: "ref", path: image.original.path, mimeType: image.original.mimeType });
    }
  }
  return inputs.length ? inputs : undefined;
}

/** 一张图片的显示 URL：优先内联预览文件，否则回落到原图。 */
export function attachmentPreviewUrl(image: AttachedImage): string {
  if (image.previewUrl) return image.previewUrl;
  const preview = image.media?.preview ?? image.media?.original;
  if (preview) return attachmentReadUrl(preview.path, preview.mimeType);
  if (image.original) {
    return attachmentReadUrl(image.original.previewPath ?? image.original.path, image.original.mimeType);
  }
  return "";
}

/** 一张图的全部副本：原图、内联预览、模型副本。
 *
 * 任一步失败都把本次已上传的文件回收掉再抛出，不留孤儿（GC 是兜底，不是替代）。
 */
export async function uploadImageAttachment(file: File, previewUrl?: string): Promise<AttachedImage> {
  const uploaded: UploadedMedia[] = [];
  const cleanup = () => deleteAttachmentMedia(uploaded.map((media) => media.path));
  try {
    // 原图走二进制流，模型副本才可能随请求内联，避免 8MB 图片被 Base64 放大后
    // 撞上 Next.js 的请求体截断。
    const [prepared, original] = await Promise.all([
      prepareImageForModel(file),
      uploadMessageMedia(file, file.name, file.type),
    ]);
    uploaded.push(original);
    // 模型副本始终落盘：队列只存引用，投递时由 Host 回读字节。
    const model = await uploadMessageMedia(
      prepared.blob,
      `${file.name}.model.${mediaExtension(prepared.mimeType)}`,
      prepared.mimeType,
    );
    uploaded.push(model);

    // 内联预览必须小：原图直接当预览会按原图下载（实测 1.9 MB 截图在历史里
    // 拉满 1.9 MB）。给「原图即预览」加字节上限，超过则另存缩小副本。
    const shrink = prepared.blob === file ? await prepareImagePreview(file) : null;
    const preview = prepared.blob === file && !shrink
      ? original
      : await uploadMessageMedia(
        shrink?.blob ?? prepared.blob,
        `${file.name}.preview.${mediaExtension(shrink?.mimeType ?? prepared.mimeType)}`,
        shrink?.mimeType ?? prepared.mimeType,
      );
    if (preview !== original) uploaded.push(preview);

    return {
      data: prepared.data,
      mimeType: prepared.mimeType,
      previewUrl: previewUrl ?? URL.createObjectURL(file),
      media: { model, original, preview },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** 一条媒体引用涉及的所有文件（含预览副本）：删除时要一起回收。 */
export function mediaRefPaths(ref: QueuedMediaRef): string[] {
  return ref.previewPath ? [ref.path, ref.previewPath] : [ref.path];
}

/** 一张图的队列引用：模型副本 + 原图（预览与原图同一文件时省略）。 */
export function imageMediaRefs(image: AttachedImage): QueuedMediaRef[] {
  if (image.media) {
    const { model, original, preview } = image.media;
    return [
      { role: "model", path: model.path, name: model.name, mimeType: model.mimeType, size: model.size },
      {
        role: "original",
        path: original.path,
        name: original.name,
        mimeType: original.mimeType,
        size: original.size,
        ...(preview.path !== original.path ? { previewPath: preview.path } : {}),
      },
    ];
  }
  // 兼容：历史消息/旧草稿只有原图元数据（没有模型副本文件）。
  const original = image.original;
  if (!original) return [];
  return [
    {
      role: "original",
      path: original.path,
      name: original.name,
      mimeType: original.mimeType,
      size: original.size,
      ...(original.previewPath ? { previewPath: original.previewPath } : {}),
    },
  ];
}

/** 输入框里已上传好的附件 → 二进制消息卡片数据（原图 + 预览都在盘上）。 */
export function attachmentBinaryBlocks(
  images: readonly AttachedImage[],
  uploads: readonly BinaryMessageInput[],
): BinaryMessageInput[] {
  return [...images.flatMap(imageOriginalBlock), ...uploads];
}

function imageOriginalBlock(image: AttachedImage): BinaryMessageInput[] {
  if (image.media) return [toBinaryBlock(image.media)];
  return image.original ? [image.original] : [];
}

function toBinaryBlock(media: AttachedImageMedia): BinaryMessageInput {
  const { original, preview } = media;
  return {
    path: original.path,
    name: original.name,
    mimeType: original.mimeType,
    size: original.size,
    ...(preview.path !== original.path ? { previewPath: preview.path } : {}),
  };
}

/** 队列媒体引用按图片分组（一组 = 一张图的模型副本 + 原图）。 */
export interface QueueMediaGroup {
  model: QueuedMediaRef | null;
  original: QueuedMediaRef;
}

/**
 * 引用顺序由客户端写入决定（每张图先 model 再 original），但分组不依赖顺序：
 * 看到 original 就开一组新的，model 归给当前组（只有 model 时不成立，丢弃）。
 */
export function groupQueueMedia(refs: readonly QueuedMediaRef[]): QueueMediaGroup[] {
  const groups: QueueMediaGroup[] = [];
  let pendingModel: QueuedMediaRef | null = null;
  for (const ref of refs) {
    if (ref.role === "model") {
      // 写入方（imageMediaRefs）按「同一张图的 model 紧跟在它的 original 之前」输出。
      // 旧实现把 model 配到**上一条** original 上：两张图时 B 的模型副本被配到 A 的
      // 原图上，A 的模型副本丢失；单张图时模型的 original 还没出现，模型直接丢掉（F2）。
      pendingModel = ref;
      continue;
    }
    groups.push({ model: pendingModel, original: ref });
    pendingModel = null;
  }
  // 仅有 model、没有 original 的引用无法构成一张可显示的图（缺原图元数据）：
  // 丢弃而不是拿模型副本冒充原图。
  return groups;
}

/** 一组队列引用 → 输入框图片（队列取回 / 草稿恢复都用它）。
 *
 * 不需要回读模型字节：再次发送时交给 Host 按引用回读。
 */
export function attachedImageFromQueueMedia(group: QueueMediaGroup): AttachedImage {
  const uploaded = (ref: QueuedMediaRef): UploadedMedia => ({
    path: ref.path,
    name: ref.name,
    storedName: ref.path.split(/[\\/]/).pop() ?? ref.name,
    size: ref.size,
    mimeType: ref.mimeType,
  });
  const original = uploaded(group.original);
  const preview = group.original.previewPath
    ? uploaded({ ...group.original, path: group.original.previewPath })
    : original;
  const model = group.model ? uploaded(group.model) : null;
  const image: AttachedImage = {
    mimeType: group.model?.mimeType ?? group.original.mimeType,
    previewUrl: attachmentReadUrl(preview.path, preview.mimeType),
    original: {
      path: original.path,
      name: original.name,
      mimeType: original.mimeType,
      size: original.size,
      ...(preview === original ? {} : { previewPath: preview.path }),
    },
  };
  // 取回的图仍然只存引用：再次入队/发送时不需要重新上传（模型副本也还在）。
  if (model) image.media = { model, original, preview };
  return image;
}
