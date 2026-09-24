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
import { subscribeLiveStreamRestore, trackLiveEventSource } from "./live-event-sources";

export type AppEventPayload = unknown;
export type AppEventListener = (payload: AppEventPayload) => void;

let source: EventSource | null = null;
let untrackSource: (() => void) | null = null;
let restoreSubscribed = false;
const listeners = new Set<AppEventListener>();

function openStream(): void {
  const stream = new EventSource("/api/agent/running/events");
  source = stream;
  // 登记到 live-event-sources：pagehide（文档进 bfcache / 要走了）会集中让出连接（#91）。
  // 不登记的话，bfcache 里的旧文档会继续占着这条连接，新文档的普通请求被挤在队里。
  untrackSource = trackLiveEventSource(stream);
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

function closeStream(): void {
  source?.close();
  untrackSource?.();
  untrackSource = null;
  source = null;
}

/**
 * bfcache 恢复后重建：pagehide 已经把连接关掉，但订阅者还在（文档又活了），
 * 不重建就等于静默失去运行集/偏好变更推送。
 */
function ensureRestoreSubscription(): void {
  if (restoreSubscribed) return;
  restoreSubscribed = true;
  subscribeLiveStreamRestore(() => {
    if (listeners.size === 0) return;
    // pagehide 关掉的是底层 EventSource，本模块持有的引用还在 —— 必须按 readyState 判断
    // 「已经关了」，否则恢复时会被 !source 的守卫挡掉，运行集/偏好变更静默停更。
    // CLOSED = 2（EventSource.close() 会把 readyState 置为 2）。
    if (source && source.readyState !== 2) return;
    closeStream();
    openStream();
  });
}

/** 订阅应用级事件；返回退订函数（最后一个订阅者退订时关闭连接）。 */
export function subscribeAppEvents(listener: AppEventListener): () => void {
  if (typeof EventSource === "undefined") return () => undefined;
  listeners.add(listener);
  ensureRestoreSubscription();
  if (!source) openStream();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) closeStream();
  };
}

/** 测试用：当前是否已建立连接。 */
export function appEventsConnected(): boolean {
  return source !== null;
}

/** 测试用：当前订阅者数量。 */
export function appEventSubscriberCount(): number {
  return listeners.size;
}
