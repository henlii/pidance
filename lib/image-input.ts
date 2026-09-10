"use client";

/** 图片只在发送给模型前生成安全副本；原文件始终单独上传并保留。 */
export const MODEL_IMAGE_MAX_WIDTH = 2_000;
export const MODEL_IMAGE_MAX_HEIGHT = 2_000;
/** Base64 字节数上限；JSON 外壳和多图请求仍留有余量。 */
export const MODEL_IMAGE_MAX_BASE64_BYTES = 4 * 1024 * 1024;

export interface PreparedModelImage {
  data: string;
  mimeType: string;
  /** 用于上传小尺寸预览，避免历史消息缩略图再次读取原图。 */
  blob: Blob;
}

const DIRECT_MODEL_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      if (!value) reject(new Error("image data is empty"));
      else resolve(value);
    };
    reader.onerror = () => reject(reader.error ?? new Error("image read failed"));
    reader.readAsDataURL(blob);
  });
}

function splitDataUrl(value: string): { mimeType: string; data: string } | null {
  const comma = value.indexOf(",");
  if (comma < 0) return null;
  const header = value.slice(0, comma);
  const data = value.slice(comma + 1);
  const match = /^data:(image\/[a-z0-9.+-]+);base64$/i.exec(header);
  if (!match || !data) return null;
  return { mimeType: match[1]!.toLowerCase(), data };
}

function loadImage(file: File): Promise<HTMLImageElement> {
  const objectUrl = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const image = new Image();
    const cleanup = () => URL.revokeObjectURL(objectUrl);
    image.onload = () => {
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      cleanup();
      reject(new Error("image decode failed"));
    };
    image.src = objectUrl;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("image encode failed")),
      "image/jpeg",
      quality,
    );
  });
}

function targetDimensions(width: number, height: number, scale: number): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * 生成发送给模型的图片副本：限制尺寸和 Base64 体积，但不改动原文件。
 * 如果浏览器无法解码/编码，直接失败而不是退回发送可能截断的大 JSON。
 */
export async function prepareImageForModel(file: File): Promise<PreparedModelImage> {
  const mimeType = file.type.toLowerCase();
  const image = await loadImage(file);
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  if (!sourceWidth || !sourceHeight) throw new Error("image has no dimensions");

  if (
    DIRECT_MODEL_MIME_TYPES.has(mimeType)
    && sourceWidth <= MODEL_IMAGE_MAX_WIDTH
    && sourceHeight <= MODEL_IMAGE_MAX_HEIGHT
  ) {
    const dataUrl = await readBlobAsDataUrl(file);
    const split = splitDataUrl(dataUrl);
    if (split && split.data.length <= MODEL_IMAGE_MAX_BASE64_BYTES) {
      return { ...split, blob: file };
    }
  }

  if (typeof document === "undefined") throw new Error("image canvas is unavailable");
  const canvas = document.createElement("canvas");
  let scale = Math.min(
    1,
    MODEL_IMAGE_MAX_WIDTH / sourceWidth,
    MODEL_IMAGE_MAX_HEIGHT / sourceHeight,
  );
  const qualities = [0.84, 0.74, 0.64, 0.54, 0.44];

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const dimensions = targetDimensions(sourceWidth, sourceHeight, scale);
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("image canvas is unavailable");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, dimensions.width, dimensions.height);
    context.drawImage(image, 0, 0, dimensions.width, dimensions.height);

    for (const quality of qualities) {
      const blob = await canvasToBlob(canvas, quality);
      const dataUrl = await readBlobAsDataUrl(blob);
      const split = splitDataUrl(dataUrl);
      if (split && split.data.length <= MODEL_IMAGE_MAX_BASE64_BYTES) {
        return { ...split, blob };
      }
    }

    scale *= 0.75;
  }

  throw new Error("image is too large to prepare for the selected model");
}
