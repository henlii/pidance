/**
 * 插件编辑器接管（`ctx.ui.setEditorComponent`）的显示判据（issue #107）。
 *
 * 单独成模块的理由：这几条门槛（手机不接管、设置可关、用户收起过、只读 / 被对端持有 /
 * 扩展对话框占着输入区）**就是**这个功能的验收项，而它们住在 ChatWindow 的一大段 JSX 里，
 * 只有抽成纯函数才测得到 —— 在组件里写一堆内联条件只能靠「源码里有没有这段字符」来"测"。
 */

export interface EditorTakeoverGateInput {
  /** 服务端是否有接管内容（插件设了工厂且组件渲染出了内容）。 */
  hasTakeover: boolean;
  /** 设置里的开关（localStorage，默认开）。 */
  enabled: boolean;
  /** 用户点了「返回输入框」（本页收起，插件那边照旧）。 */
  dismissed: boolean;
  /** 窄视口：插件画的是终端界面，手机保持我们自己的真输入框。 */
  isMobile: boolean;
  isReadOnly: boolean;
  lockedByOther: boolean;
  /** 扩展对话框打开时输入区整块让位（与接管互斥）。 */
  hasDialog: boolean;
}

/** 是否用插件编辑器接管输入框（接管面板取代我们自己的输入框）。 */
export function shouldShowEditorTakeover(input: EditorTakeoverGateInput): boolean {
  if (!input.hasTakeover) return false;
  if (!input.enabled || input.dismissed || input.isMobile) return false;
  if (input.isReadOnly || input.lockedByOther || input.hasDialog) return false;
  return true;
}

/**
 * 是否显示「插件编辑器已收起」的细条（用户主动收起后用它回去）。
 *
 * 与接管面板互斥：面板显示时不显示细条，反之亦然。只读 / 被锁 / 对话框时两者都不显示
 * （那时输入区本来就被别的提示条或面板占着，再加一条只会更乱）。
 */
export function shouldShowEditorTakeoverBar(input: EditorTakeoverGateInput): boolean {
  if (!input.hasTakeover || !input.dismissed) return false;
  if (!input.enabled || input.isMobile) return false;
  if (input.isReadOnly || input.lockedByOther || input.hasDialog) return false;
  return true;
}
