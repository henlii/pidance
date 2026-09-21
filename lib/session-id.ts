/**
 * 会话 id 的占位约定（浏览器与服务端共用，纯常量 + 纯函数，不引入任何依赖）。
 *
 * 新会话在启动期只有临时 key（`__new__<uuid>`，真正 id 由 Pi 生成，见
 * `session-service` 的 startLockedSession）；它会被 rekey 成真实 id。所以任何「按会话
 * 记账」的逻辑都必须把占位键排除在外，否则会留下永远不存在的会话条目
 * （未读时钟、桌面通知标题都踩过：通知标题曾显示成 `__new__…`）。
 */
export const PLACEHOLDER_SESSION_ID_PREFIX = "__new__";

export function isPlaceholderSessionId(id: string): boolean {
  return id.startsWith(PLACEHOLDER_SESSION_ID_PREFIX);
}
