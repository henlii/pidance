/**
 * 图片查看器的双指缩放计算（纯函数，便于单测）。
 *
 * 为什么单独放这里：捏合是「按两指间距的比例」缩放，不是按绝对位移 —— 手指一开始离得远
 * 时同样的移动量应该缩得更多。这段算术是手势里唯一容易写错的部分，抽出来才钉得住。
 */

/** 捏合基线：开始时两指间距与当时的倍数。 */
export interface PinchBase {
  /** 起始两指间距（px）；0 或负数视为无效基线。 */
  distance: number;
  /** 起始倍数。 */
  zoom: number;
}

/**
 * 按当前两指间距算出新的倍数，并夹在 [min, max] 内。
 *
 * @param base 捏合基线（起始间距与倍数）
 * @param distance 当前两指间距（px）
 * @param min 最小倍数
 * @param max 最大倍数
 * @returns 夹紧后的倍数；基线无效时返回 `base.zoom`（宁可不缩放，也不跳变）
 */
export function pinchZoom(base: PinchBase, distance: number, min: number, max: number): number {
  if (!Number.isFinite(base.distance) || base.distance <= 0) return base.zoom;
  if (!Number.isFinite(distance) || distance < 0) return base.zoom;
  const next = base.zoom * (distance / base.distance);
  if (!Number.isFinite(next)) return base.zoom;
  return Math.min(max, Math.max(min, Number(next.toFixed(2))));
}
