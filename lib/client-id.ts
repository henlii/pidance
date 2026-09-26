/**
 * 每个浏览器标签页一个客户端 id。
 *
 * 用途：服务端要区分「是哪一个标签在说话」。三处共用**同一个** id（所以它只有一个来源）：
 * - 编辑器焦点聚合（`setEditorFocus(focused, clientId)`：任一标签聚焦即聚焦，issue #83）；
 * - 插件编辑器接管（issue #107）的提交归属、文本回流定向；
 * - 接管视图上报（`editor_takeover_view`：本页是否正在显示这个接管）。
 *
 * 为什么是**内存级**（每个文档一个）而不是 sessionStorage（issue #107 三轮审查 次要 7）：
 * - 那条建议的理由是「刷新后 id 变了，在途的 `editorComponentSubmit` 会对不上来源标签而被丢」。
 *   可是这条事件**只能经会话 SSE 流送达**：刷新会拆掉 EventSource，落在刷新窗口里的那一帧
 *   本来就不会到达新文档（`lib/stream-snapshot.ts` 的 `remember()` 也不缓存
 *   `extension_ui_request`，重连不重放）。所以持久化 id 换不来这次投递。
 * - 反过来有代价：Chrome 等浏览器**复制标签页时会连 sessionStorage 一起复制**，于是两个
 *   活着的标签会共用一个 id —— 而这条链正是用来防止「同一个提交被执行两次」的，
 *   别名会让两个标签都认为自己是来源，重新引入斜杠命令执行两遍、follow-up 重复入队。
 *   挑一个更坏的失败模式不值得。
 *
 * 模块级缓存：同一页里的所有消费者必须是同一个 id，各自生成就配不上对了。
 */
let cached: string | null = null;

export function getClientId(): string {
  if (cached) return cached;
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  cached = cryptoApi && typeof cryptoApi.randomUUID === "function"
    ? cryptoApi.randomUUID()
    : `client-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  return cached;
}

/** 测试用：清掉模块级缓存（同一进程里模拟「新文档」）。 */
export function resetClientIdForTests(): void {
  cached = null;
}
