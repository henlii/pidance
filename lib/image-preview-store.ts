"use client";

import { useSyncExternalStore } from "react";

export interface ImagePreviewState {
  id: string;
  src: string;
  downloadHref: string;
  downloadName: string;
  mimeType?: string;
  alt: string;
  title?: string;
}

let snapshot: ImagePreviewState | null = null;
const listeners = new Set<() => void>();

/**
 * 已经点过「下载原图」的图片（按下载 href 记）。
 *
 * 只活在这个页面里：按钮要从「下载原图」变成「另存为」，这是同一张图的一次性动作，
 * 刷新后重来一遍没有副作用（浏览器下载本来就落在它自己的下载目录）。
 */
const downloadedHrefs = new Set<string>();

export function markImageDownloaded(href: string): void {
  if (href) downloadedHrefs.add(href);
}

export function isImageDownloaded(href: string): boolean {
  return Boolean(href) && downloadedHrefs.has(href);
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function openImagePreview(input: Omit<ImagePreviewState, "id">): void {
  snapshot = {
    ...input,
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
  notify();
}

export function closeImagePreview(): void {
  if (snapshot === null) return;
  snapshot = null;
  notify();
}

export function useImagePreview(): ImagePreviewState | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => null,
  );
}
