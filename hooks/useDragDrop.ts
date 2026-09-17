"use client";

import { useState, useCallback, useRef } from "react";

export function useDragDrop(onDrop: (files: File[]) => void) {
  const [isDragOver, setIsDragOver] = useState(false);
  const counterRef = useRef(0);

  // 只认文件拖拽（排除页内文本选区拖拽）；不按 MIME 过滤：拖进来的可能是文档、
  // 压缩包等非图片文件——以前只对 `image/*` 生效，拖文件时连 preventDefault 都
  // 不做，浏览器会直接打开这个文件而离开页面。
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    counterRef.current += 1;
    setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
  }, []);

  const handleDragLeave = useCallback(() => {
    counterRef.current -= 1;
    if (counterRef.current <= 0) {
      counterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    counterRef.current = 0;
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    onDrop(files);
  }, [onDrop]);

  return { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop };
}