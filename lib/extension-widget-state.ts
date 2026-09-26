/**
 * 扩展 widget 状态的两步纯逻辑（issue #104 审查 P0-2）。
 *
 * 为什么单独成模块：这两步以前散在宿主里 —— `trackExtensionSideEffects` 用整对象覆盖同一张
 * widgets 表、`projectState` 再逐字段窄化一次。两处都容易「字段少了就抹掉」，而漏掉的后果是
 * 静默的：适配器**未变时刻意省略** base64（避免每帧重发几百 KB），镜像写或投影少带一项，
 * 图就会在对账/刷新之后消失，只剩被摘空的那一行。抽成纯函数是为了能用测试把这条约定钉住。
 */
import type { ExtensionRenderedImage, ExtensionRenderedImageFallback } from "./types";

/** 适配器内部 widgets 表的条目（字段都是未知类型，来自事件）。 */
export interface WidgetFrame {
  lines: unknown;
  images?: unknown;
  imageFallbacks?: unknown;
  placement?: unknown;
  interactive?: unknown;
}

/**
 * 一条 `setWidget` 帧合并进 widgets 表的结果。
 *
 * 约定的核心：**图片字段缺省 = 沿用表里已有的**，**显式空数组 = 清空**。
 * 因为适配器图片没变时会把 `widgetImages` 省略掉（值就是 `undefined`），
 * 用 `?? []` 之类的写法会把上一帧的图当成「没了」。
 *
 * `interactive` 不适用这条：适配器**每一帧都发** `widgetInteractive`（字符串数组也会发 false），
 * 所以它一律以帧为准 —— 否则组件换成字符串数组时会把上一帧的 true 留下来。
 */
export interface MergedWidgetEntry {
  lines: unknown;
  images?: unknown;
  imageFallbacks?: unknown;
  placement?: unknown;
  interactive: boolean;
}

/** 合并一帧 widget 更新；`lines` 为空表示删除该 widget（返回 null）。 */
export function mergeWidgetFrame(previous: unknown, frame: WidgetFrame): MergedWidgetEntry | null {
  if (frame.lines == null) return null;
  const prior = (previous && typeof previous === "object" ? previous : {}) as {
    images?: unknown;
    imageFallbacks?: unknown;
  };
  return {
    lines: frame.lines,
    images: frame.images === undefined ? prior.images : frame.images,
    imageFallbacks: frame.imageFallbacks === undefined ? prior.imageFallbacks : frame.imageFallbacks,
    placement: frame.placement,
    interactive: frame.interactive === true,
  };
}

/** 投影给客户端的一条 widget（水合/对账与 SSE 帧同形）。 */
export interface ProjectedWidget {
  key: string;
  lines: string[];
  images: ExtensionRenderedImage[];
  imageFallbacks: ExtensionRenderedImageFallback[];
  placement: "aboveEditor" | "belowEditor";
  interactive: boolean;
}

/** 把 widgets 表投影成客户端形状（逐字段窄化，图片与降级说明一并带上）。 */
export function projectWidgetEntries(entries: Iterable<[string, unknown]>): ProjectedWidget[] {
  const out: ProjectedWidget[] = [];
  for (const [key, content] of entries) {
    const widget = (content && typeof content === "object" ? content : null) as {
      lines?: unknown;
      images?: unknown;
      imageFallbacks?: unknown;
      placement?: unknown;
      interactive?: unknown;
    } | null;
    out.push({
      key,
      lines: Array.isArray(widget?.lines) ? (widget.lines as string[]) : [],
      images: Array.isArray(widget?.images) ? (widget.images as ExtensionRenderedImage[]) : [],
      imageFallbacks: Array.isArray(widget?.imageFallbacks)
        ? (widget.imageFallbacks as ExtensionRenderedImageFallback[])
        : [],
      placement: widget?.placement === "belowEditor" ? "belowEditor" : "aboveEditor",
      interactive: widget?.interactive === true,
    });
  }
  return out;
}
