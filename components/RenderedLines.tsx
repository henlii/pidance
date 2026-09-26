"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { measureCharWidth, measureLineHeight, measurementHostFor } from "@/lib/render-width";
import type { RenderedImage, RenderedImageFallback } from "@/lib/kitty-image";

/**
 * 终端内联图片（Kitty 协议）在 Web 上的呈现（issue #104）。
 *
 * 服务端把 `<img>` 的数据（mime + base64）与**它占的行数**一起下发；这里：
 * - 用真 `<img>` 画（data URL），不是把 ANSI 序列当文本显示；
 * - 按 `rows × 实测行高` 预留高度，行高与正文字体同源（`measureLineHeight` 的探针
 *   量的是同一个 `<pre>` 上下文），这样图片下方的文本不会被顶乱；
 * - `alt` 给无障碍（插件没给说明时用 i18n 的「图片」）。
 *
 * 摘不出图的那些位置由 `RenderedImageFallbackNote` 渲染一句**可见**说明 —— 静默丢成空行
 * 是明确禁止的降级方式。
 */
export function RenderedImageBlock({
  image,
  alt,
}: {
  image: RenderedImage;
  /** 无障碍文本（调用方用 i18n 文案）。 */
  alt: string;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // 量**父级**而不是这个包装节点（它带 `lineHeight: 0`，探针会量出 0 而放弃）：
    // 规则与理由见 lib/render-width.ts 的 measurementHostFor。
    const measureHost = measurementHostFor(host);
    if (!measureHost) return;
    const lineHeight = measureLineHeight(measureHost);
    if (!lineHeight) return;
    const charWidth = measureCharWidth(measureHost);
    setSize({
      height: lineHeight * Math.max(1, image.rows),
      width: charWidth ? charWidth * Math.max(1, image.cols) : 0,
    });
    // id 变化也要重算：同一位置换成另一张图时行数可能不同。
  }, [image.cols, image.id, image.rows]);

  return (
    <span ref={hostRef} style={{ display: "inline-block", lineHeight: 0 }}>
      <img
        src={`data:${image.mime};base64,${image.base64}`}
        alt={alt}
        data-pidance-terminal-image={image.id}
        style={{
          display: "block",
          height: size ? `${size.height}px` : `${Math.max(1, image.rows)}em`,
          width: size && size.width > 0 ? `${size.width}px` : "auto",
          maxWidth: "100%",
          objectFit: "contain",
        }}
      />
    </span>
  );
}

/** 摘不出图的占位说明（可见降级）。 */
export function RenderedImageFallbackNote({ label, reason }: { label: string; reason: string }) {
  return (
    <span role="note" title={reason} style={{ color: "var(--text-muted)" }}>
      {label}
    </span>
  );
}

/**
 * 按 `lineIndex` 把图片/降级说明摆回文本行之间。
 *
 * 被图片覆盖的后续行（`rows-1` 个空行占位）要跳过：pi-tui 的 Image 组件会在序列行
 * 之后补 `rows-1` 个空行来占位，而 `<img>` 自己已经按 `rows` 撑开高度 —— 两边都算
 * 就会把下面的内容推开一倍。
 */
export function RenderedLineBlocks({
  lines,
  images,
  imageFallbacks,
  keyPrefix,
  renderLine,
  imageAlt,
  fallbackLabel,
}: {
  lines: string[];
  images?: RenderedImage[] | null;
  imageFallbacks?: RenderedImageFallback[] | null;
  keyPrefix: string;
  /** 单行的渲染函数（各界面自己的 ANSI 渲染）。 */
  renderLine: (line: string, keyPrefix: string) => ReactNode;
  imageAlt: string;
  fallbackLabel: (reason: string) => string;
}): ReactNode {
  const list = Array.isArray(lines) ? lines : [];
  const imageByLine = new Map<number, RenderedImage>();
  const covered = new Set<number>();
  for (const image of Array.isArray(images) ? images : []) {
    if (typeof image?.lineIndex !== "number") continue;
    imageByLine.set(image.lineIndex, image);
    for (let offset = 1; offset < Math.max(1, image.rows); offset += 1) covered.add(image.lineIndex + offset);
  }
  const fallbackByLine = new Map<number, RenderedImageFallback>();
  for (const fallback of Array.isArray(imageFallbacks) ? imageFallbacks : []) {
    if (typeof fallback?.lineIndex !== "number") continue;
    fallbackByLine.set(fallback.lineIndex, fallback);
  }

  return list.map((line, index) => {
    if (covered.has(index)) return null;
    const image = imageByLine.get(index);
    const fallback = fallbackByLine.get(index);
    if (!image && !fallback) {
      return (
        <Fragment key={`${keyPrefix}-${index}`}>
          {renderLine(line, `${keyPrefix}-${index}`)}
          {index < list.length - 1 ? "\n" : null}
        </Fragment>
      );
    }
    return (
      <Fragment key={`${keyPrefix}-${index}`}>
        {image ? <RenderedImageBlock image={image} alt={imageAlt} /> : null}
        {fallback ? <RenderedImageFallbackNote label={fallbackLabel(fallback.reason)} reason={fallback.reason} /> : null}
        {/* 图片占位行本身是空行：只在它旁边还有文字时才需要补换行。 */}
        {line !== "" ? renderLine(line, `${keyPrefix}-${index}`) : null}
        {index < list.length - 1 ? "\n" : null}
      </Fragment>
    );
  });
}
