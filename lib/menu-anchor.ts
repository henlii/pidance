/** 侧栏固定菜单：聊天区自动滚动不应关掉菜单；触发器位移（侧栏滚动）才关。 */

export type MenuAnchorPoint = {
  top: number;
  right: number;
};

export function didMenuAnchorMove(
  prev: MenuAnchorPoint | null | undefined,
  next: MenuAnchorPoint | null | undefined,
  slop = 2,
): boolean {
  if (!prev || !next) return false;
  return Math.abs(prev.top - next.top) >= slop || Math.abs(prev.right - next.right) >= slop;
}
