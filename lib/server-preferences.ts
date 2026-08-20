/**
 * 服务端持久化偏好（跨客户端同步）。
 *
 * - 内存单例 store；首次读取/网页激活时 GET /api/preferences 拉取。
 * - setPref 修改内存并防抖合并 PUT；后写者胜出。
 * - 草稿、文件展开状态、每模型思考深度等接入点共用。
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { mergeUnreadSessionState, parseUnreadSessionState } from "./unread-sessions-storage";

export type ServerPrefs = Record<string, unknown>;

const SYNC_DEBOUNCE_MS = 400;

/** 模块级单例（跨组件共享，避免多实例重复拉取）。 */
let singletonPrefs: ServerPrefs | null = null;
let singletonLoaded = false;
let loadPromise: Promise<ServerPrefs> | null = null;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) fn();
}

async function fetchPrefs(): Promise<ServerPrefs> {
  const res = await fetch("/api/preferences", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { prefs?: ServerPrefs };
  return body.prefs && typeof body.prefs === "object" && !Array.isArray(body.prefs)
    ? body.prefs
    : {};
}

/** 确保已从服务端加载（并发调用合并为一次请求）。 */
export function ensureServerPrefsLoaded(): Promise<ServerPrefs> {
  if (singletonLoaded && singletonPrefs) return Promise.resolve(singletonPrefs);
  if (!loadPromise) {
    loadPromise = fetchPrefs()
      .then((prefs) => {
        singletonPrefs = prefs;
        singletonLoaded = true;
        loadPromise = null;
        notify();
        return prefs;
      })
      .catch((err) => {
        // 加载失败：用空对象继续（可降级），下次激活再试
        console.error("[pidance] failed to load server preferences:", err);
        singletonPrefs = singletonPrefs ?? {};
        singletonLoaded = true;
        loadPromise = null;
        notify();
        return singletonPrefs;
      });
  }
  return loadPromise;
}

function readPrefs(): ServerPrefs {
  return singletonPrefs ?? {};
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const prefs = readPrefs();
    void fetch("/api/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefs }),
    }).catch((err) => {
      console.error("[pidance] failed to save server preferences:", err);
    });
  }, SYNC_DEBOUNCE_MS);
}

/** 修改偏好：路径写法 key 支持 "a.b" 点路径（浅层）。 */
export function setServerPref(key: string, value: unknown): void {
  if (!singletonLoaded) {
    // 未加载完成：加载后再写入（避免「思考深度」等选择被静默丢弃）
    void ensureServerPrefsLoaded().then(() => setServerPref(key, value));
    return;
  }
  const parts = key.split(".");
  const prefs = readPrefs();
  let target = prefs;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const next = target[part];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      target[part] = {};
    }
    target = target[part] as ServerPrefs;
  }
  const last = parts[parts.length - 1];
  if (value === undefined || value === null) {
    delete target[last];
  } else {
    target[last] = value;
  }
  notify();
  scheduleSave();
}

export function getServerPref<T = unknown>(key: string): T | undefined {
  const parts = key.split(".");
  let target: unknown = readPrefs();
  for (const part of parts) {
    if (typeof target !== "object" || target === null) return undefined;
    target = (target as ServerPrefs)[part];
  }
  return target as T;
}

/** 强制立即同步（页面隐藏/卸载时调用可减少丢失窗口）。 */
export function flushServerPrefs(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    const prefs = readPrefs();
    void fetch("/api/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefs }),
    }).catch(() => undefined);
  }
}

/**
 * React 绑定：挂载时加载；visibilitychange/focus 时从服务端刷新
 * （多客户端同步）。返回最新 prefs 快照（变更时触发重渲染）。
 */
export function useServerPreferences(): ServerPrefs {
  const [prefs, setPrefs] = useState<ServerPrefs>(readPrefs());
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useEffect(() => {
    const sub = () => setPrefs(readPrefs());
    subscribers.add(sub);
    void ensureServerPrefsLoaded().then((loaded) => {
      // 加载完成后若有本地已应用值（接入点在加载前写入），保留内存值避免闪回
      if (singletonPrefs === loaded || Object.keys(loaded).length === 0) {
        setPrefs(readPrefs());
      }
    });
    return () => {
      subscribers.delete(sub);
    };
  }, []);

  // 网页激活同步：focus / visibilitychange(visible) 时重新拉取
  useEffect(() => {
    const sync = () => {
      if (document.visibilityState !== "visible") return;
      void fetchPrefs()
        .then((remote) => {
          const local = singletonPrefs;
          const merged: ServerPrefs = { ...remote };
          if (local) {
            merged.unreadSessionState = mergeUnreadSessionState(
              parseUnreadSessionState(local.unreadSessionState),
              parseUnreadSessionState(remote.unreadSessionState ?? remote.unreadSessionIds),
            );
          }
          singletonPrefs = merged;
          singletonLoaded = true;
          notify();
        })
        .catch(() => undefined);
    };
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("beforeunload", () => flushServerPrefs());
    return () => {
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("beforeunload", () => flushServerPrefs());
    };
  }, []);

  return prefs;
}
