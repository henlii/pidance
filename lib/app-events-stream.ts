/**
 * 全应用共用的一条 SSE 通道（浏览器侧）。
 *
 * 为什么需要「共用」：页面里长连接是稀缺资源 —— 浏览器对同一个源（HTTP/1.1）只有 6 条并发
 * 连接，而重载页面时**旧连接还没关新连接就要建**，再各开一条（运行集、偏好广播、文件监听…）
 * 就会把 `/api/sessions/<id>/state` 这类普通请求挤在队里，于是「刷新后导入在跑的 run」会失败
 * （实测踩过：新增偏好广播后，A2 用例稳定失败，去掉第二条连接即恢复）。
 *
 * 所以：一个页面**只有一条应用级流**（`/api/agent/running/events`），运行集与偏好变更都从它分发。
 */
export type AppEventPayload = unknown;
export type AppEventListener = (payload: AppEventPayload) => void;

let source: EventSource | null = null;
const listeners = new Set<AppEventListener>();

/** 订阅应用级事件；返回退订函数（最后一个订阅者退订时关闭连接）。 */
export function subscribeAppEvents(listener: AppEventListener): () => void {
  if (typeof EventSource === "undefined") return () => undefined;
  listeners.add(listener);
  if (!source) {
    const stream = new EventSource("/api/agent/running/events");
    source = stream;
    stream.onmessage = (event) => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      for (const current of [...listeners]) {
        try {
          current(payload);
        } catch {
          // 单个订阅者出错不影响其它订阅者
        }
      }
    };
    stream.onerror = () => {
      // EventSource 自己会重连；不主动重建，避免叠加多条流。
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      source?.close();
      source = null;
    }
  };
}

/** 测试用：当前订阅者数量。 */
export function appEventSubscriberCount(): number {
  return listeners.size;
}
