"use client";

import { useEffect, useState } from "react";
import { subscribeLiveStreamRestore } from "@/lib/live-event-sources";

/**
 * bfcache 恢复计数器（#91）：文档从 bfcache 回来时 +1，否则恒为 0。
 *
 * 用途：长期 SSE 在 `pagehide` 时被 `lib/live-event-sources` 集中关掉（把同源连接让给
 * 新文档，否则旧文档会一直占着 6 条连接里的若干条）。文档若被 bfcache 恢复，这些连接必须
 * 重建 —— 把这个计数放进 effect 依赖即可（组件卸载时自动退订）。
 *
 * 与 #86 的可见性关流不同：那是「文档还在跑但切到后台」，回前台由既有激活路径重连；
 * 这里是「文档走了又回来」。
 */
export function useLiveStreamRestoreNonce(): number {
  const [nonce, setNonce] = useState(0);
  useEffect(
    () => subscribeLiveStreamRestore(() => setNonce((value) => value + 1)),
    [],
  );
  return nonce;
}
