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
