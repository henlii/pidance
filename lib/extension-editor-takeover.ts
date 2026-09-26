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

/**
 * 接管视图的**心跳**（issue #107 四轮审查 阻断 1）。
 *
 * 宿主只把「最近还在心跳」的登记当有效归属者（`EDITOR_TAKEOVER_VIEW_FRESH_MS`）：
 * 插件自己调 `onSubmit`、或卸下接管交还文本时，宿主按登记挑**一个**标签。一个还开着的
 * 标签靠这里持续留下新鲜登记；切走 / 关掉 / 崩溃的标签心跳一停，登记自己过期 ——
 * 不需要再发一条「注销」命令（那要走 agent 命令通道，会对已经不 live 的会话 ensureLive，
 * 为了注销一条登记去唤醒旧宿主并占上写者租约，代价大于收益）。
 *
 * 抽成工厂是为了测得到：计时器与「当前是否显示」的读取都可注入。
 */
export function startEditorTakeoverHeartbeat(options: {
  report: (shown: boolean) => void;
  readShown: () => boolean;
  intervalMs: number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}): () => void {
  const setIntervalFn = options.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = options.clearIntervalFn ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const handle = setIntervalFn(() => options.report(options.readShown() === true), options.intervalMs);
  return () => clearIntervalFn(handle);
}

/**
 * 切换会话 / 换接管 / 卸载时，该向哪条登记发 `shown=false`。
 *
 * 为什么要注销（issue #107 四轮审查 阻断 1）：宿主按「最近还在心跳的标签」挑提交归属者，
 * 切走的标签如果不注销，它最多要在新鲜度窗口里被当成有效目标 —— 落在那个窗口里的
 * 提交就会发给一个已经不看这个会话的标签。心跳会让它自然过期（所以注销不是唯一防线），
 * 但注销把窗口**立刻**关掉。
 *
 * 返回 null 表示没有需要注销的东西（第一次上报、或者本来就是同一条）。
 */
export function editorTakeoverViewCleanup(
  previous: { sessionId: string; requestId: string } | null,
  next: { sessionId: string; requestId: string } | null,
): { sessionId: string; requestId: string } | null {
  if (!previous) return null;
  if (next && next.sessionId === previous.sessionId && next.requestId === previous.requestId) return null;
  return previous;
}

/** 落点只需要这两个方法（ChatInputHandle 的子集，便于单测给假输入框）。 */
export interface EditorTextComposerTarget {
  /** 整段替换（TUI 的 `editor.setText`）。 */
  replaceText?: (text: string) => void;
  /** 只在输入框为空时落进去。 */
  insertIfEmpty?: (text: string) => void;
}

/** 定向交还（`clientId` 指向本标签）时的语义。 */
export type EditorTextPlacement = "replace" | "insert-if-empty" | "ignore";

/**
 * 插件 `ctx.ui.setEditorText(text)` 在本标签上的落点（issue #107 四轮审查 阻断 2）。
 *
 * 为什么不能一律替换：这条事件是**广播**的，收到它的标签里既有「正显示接管面板」的
 * （那时输入框不在场，文本属于组件），也有「没在显示接管」的 —— 手机（窄视口不接管）、
 * 设置里关掉接管、用户点过「返回输入框」。后者的输入框里是**用户自己正在打的正文**，
 * 整段替换等于把用户刚敲的字静默删掉。
 *
 * 所以按有没有 `clientId` 分流：
 * - 有 `clientId`：那是「返回输入框 / 卸下接管」把组件文本交还给**刚才在显示它**的标签，
 *   语义就是 TUI 的 `editor.setText` ⇒ **替换**（那份草稿还是接管前的旧版本，
 *   用插入会把组件全文拼在草稿后面：`hello` + `hello world` ⇒ `hello hello world`）；
 *   指向别的标签时本页什么都不做。
 * - 没有 `clientId`（广播）：只在输入框**为空**时落进去。用户正在打的字永远优先 ——
 *   插件要写的那段文本仍在宿主侧的组件里（`appliedToTakeover` 会说明宿主是否已经写进去），
 *   不会因为这里不覆盖而消失。
 */
export function placeEditorText(
  effect: { clientId?: string; text: string },
  target: EditorTextComposerTarget | null | undefined,
  myClientId: string,
): EditorTextPlacement {
  if (effect.clientId !== undefined) {
    if (effect.clientId !== myClientId) return "ignore";
    target?.replaceText?.(effect.text);
    return "replace";
  }
  target?.insertIfEmpty?.(effect.text);
  return "insert-if-empty";
}
