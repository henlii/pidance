/**
 * 每个浏览器标签页一个客户端 id。
 *
 * 用途：服务端要区分「是哪一个标签在说话」。已用它做多标签的编辑器焦点聚合
 * （`setEditorFocus(focused, clientId)`：任一标签聚焦即聚焦），插件编辑器接管
 * （issue #107）的提交与文本回流也按它定向 —— 否则同一条广播会让**每个**订阅该会话的
 * 标签都提交一次（斜杠命令执行两遍、follow-up 入队两次）。
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
