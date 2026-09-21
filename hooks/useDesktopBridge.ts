"use client";

import { useState } from "react";
import { readDesktopBridge, type DesktopBridge } from "@/lib/desktop-bridge";

/**
 * 桌面壳桥（#51）：`window.pidanceDesktop` 只在 Electron 壳里存在（由 preload 注入），
 * Web 上恒为 null。读一次即可 —— preload 在页面脚本之前注入，不会中途出现或消失。
 */
export function useDesktopBridge(): DesktopBridge | null {
  const [bridge] = useState<DesktopBridge | null>(() => readDesktopBridge());
  return bridge;
}
