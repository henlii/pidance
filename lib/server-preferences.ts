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

const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DRAFT_MAX_KEEP = 30;

/**
 * 服务端偏好读时 GC：草稿只保留活跃（30 天内更新）且最多 DRAFT_MAX_KEEP 条，
 * 防止跨客户端同步把桌面端长期残留的草稿全部带到手机/新浏览器。
 */
export function pruneServerPrefs(prefs: ServerPrefs): ServerPrefs {
  const drafts = prefs.drafts;
  if (!drafts || typeof drafts !== "object" || Array.isArray(drafts)) return prefs;
  const now = Date.now();
  const entries = Object.entries(drafts as Record<string, unknown>)
    .filter(([, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const updatedAt = (value as { updatedAt?: unknown }).updatedAt;
      if (typeof updatedAt !== "number") return true; // 旧格式保留待下轮更新
      return now - updatedAt <= DRAFT_MAX_AGE_MS;
    })
    .sort((a, b) => {
      const ta = (a[1] as { updatedAt?: number }).updatedAt ?? 0;
      const tb = (b[1] as { updatedAt?: number }).updatedAt ?? 0;
      return tb - ta;
    });
  const kept = Object.fromEntries(entries.slice(0, DRAFT_MAX_KEEP));
  if (Object.keys(kept).length === Object.keys(drafts as Record<string, unknown>).length) return prefs;
  return { ...prefs, drafts: kept };
}

/** 确保已从服务端加载（并发调用合并为一次请求）。 */
export function ensureServerPrefsLoaded(): Promise<ServerPrefs> {
  if (singletonLoaded && singletonPrefs) return Promise.resolve(singletonPrefs);
  if (!loadPromise) {
    loadPromise = fetchPrefs()
      .then((prefs) => {
        singletonPrefs = pruneServerPrefs(prefs);
        singletonLoaded = true;
        loadPromise = null;
        notify();
        return singletonPrefs;
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
/** 激活同步的 in-flight：连续激活（focus + visibilitychange）合并成一次 GET。 */
let syncPromise: Promise<void> | null = null;

/**
 * 尚未送达服务端的改动点路径（脏键）。
 *
 * 为什么需要它：偏好写入原本是**整包 PUT**（把整份内存快照发出去），而共享偏好里既有
 * 「本机偏好」也有「跨端共享」的字段。一份过期的整包会把没改过的字段一起写回——实测把
 * 用户的 `locale` 从 zh-CN 写成 en，以及把共享的项目列表清成 `[]`（见 issue #62 / #63）。
 * 现在只发本次真正改动过的点路径，服务端一层深合并正好支持这个粒度。
 */
const dirtyPaths = new Set<string>();

/**
 * 脏路径的生效粒度：服务端 `mergePidancePrefs` 只做「顶层键 + 一层子键」的合并，
 * 更深的路由会退化成整值替换并吃掉兄弟键，所以超过两段的路径收敛到其一级父键。
 */
function effectiveDirtyPath(path: string): string {
  const parts = path.split(".");
  return parts.length <= 2 ? path : `${parts[0]}.${parts[1]}`;
}

function getByDottedPath(prefs: ServerPrefs, path: string): unknown {
  let node: unknown = prefs;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** 把「值」写进 patch 的嵌套位置；`null` 必须原样保留（服务端把 null 当墓碑删除）。 */
function setPatchValue(patch: ServerPrefs, path: string, value: unknown): void {
  const parts = path.split(".");
  let node: ServerPrefs = patch;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    const next = node[part];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      const created: ServerPrefs = {};
      node[part] = created;
      node = created;
      continue;
    }
    node = next as ServerPrefs;
  }
  node[parts[parts.length - 1]] = value;
}

/** 由脏键构造「一层子对象」patch；`sessionQueue*` 是宿主独占键，永不回写。 */
export function buildDirtyPrefPatch(prefs: ServerPrefs, paths: readonly string[]): ServerPrefs {
  const patch: ServerPrefs = {};
  for (const path of new Set(paths.map(effectiveDirtyPath))) {
    const top = path.split(".")[0];
    if (top === "sessionQueue" || top.startsWith("sessionQueue.")) continue;
    setPatchValue(patch, path, getByDottedPath(prefs, path) ?? null);
  }
  return patch;
}

/**
 * 整包 PUT 的载荷：剥掉宿主持有的 `sessionQueue`。
 *
 * 本地快照可能停在投递前，而任何一次偏好写入（草稿/hold）都会带着整包快照回写；
 * 把旧队列连带旧版本号写回去会让「已投递」的条目变回 `waiting` 并被再投一次。
 * 队列由 Host 独占写入（客户端只能通过 agent 命令 API 写）。
 */
function queueFreePrefsSnapshot(prefs: ServerPrefs): ServerPrefs {
  const body: ServerPrefs = {};
  for (const [key, value] of Object.entries(prefs)) {
    if (key === "sessionQueue" || key.startsWith("sessionQueue.")) continue;
    body[key] = value;
  }
  return body;
}

/** 发送累积的脏键；**成功才清**，失败保留等下一次（丢更新比多写一次严重得多）。 */
async function sendDirtyPrefs(): Promise<void> {
  if (dirtyPaths.size === 0) return;
  const paths = [...dirtyPaths];
  const patch = buildDirtyPrefPatch(readPrefs(), paths);
  if (Object.keys(patch).length === 0) {
    for (const path of paths) dirtyPaths.delete(path);
    return;
  }
  try {
    const res = await fetch("/api/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefs: patch }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    for (const path of paths) dirtyPaths.delete(path);
  } catch (err) {
    console.error("[pidance] failed to save server preferences:", err);
  }
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void sendDirtyPrefs();
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
    // 墓碑语义：PUT 整包 patch 缺键会被服务端 merge 当成「未改动」保留，删除
    // 必须以显式 null 表达（服务端 merge null = 删键）。
    target[last] = null;
  } else {
    target[last] = value;
  }
  dirtyPaths.add(key);
  notify();
  scheduleSave();
}

/**
 * 内存 prefs 的删除以 null 墓碑表达；读侧统一归一为 undefined，
 * 调用方无需区分「键不存在」与「已删除」。
 */
export function getServerPref<T = unknown>(key: string): T | undefined {
  const parts = key.split(".");
  let target: unknown = readPrefs();
  for (const part of parts) {
    if (typeof target !== "object" || target === null) return undefined;
    target = (target as ServerPrefs)[part];
  }
  return (target ?? undefined) as T | undefined;
}

/** 强制立即同步（页面隐藏/卸载时调用可减少丢失窗口）。 */
export function flushServerPrefs(): void {
  // 有计时器就取消它，但**无论有没有计时器都要发**：上一次 PUT 失败时计时器已被清，
  // 此时脏键还在，不能在「没有待发计时器」时静默什么都不做。
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  void sendDirtyPrefs();
}

/** 收集对象深层所有值为 null 的点路径（如 drafts.abc → ["drafts.abc"]）。 */
function collectNullPaths(value: unknown, prefix: string, out: string[]): string[] {
  if (value === null) {
    out.push(prefix);
    return out;
  }
  if (typeof value !== "object" || value === undefined || Array.isArray(value)) return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    collectNullPaths(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

/**
 * 按点路径在目标对象上置 null。**沿途逐层浅拷贝（copy-on-write）**：
 * 直接把 null 写进共享的中间对象会改到调用方的输入（例如刚拉取的远端快照），
 * 合并函数必须是纯的。
 */
function setPathNull(target: Record<string, unknown>, key: string): void {
  const parts = key.split(".");
  let node = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    const next = node[part];
    const copy = typeof next === "object" && next !== null && !Array.isArray(next)
      ? { ...(next as Record<string, unknown>) }
      : {};
    node[part] = copy;
    node = copy;
  }
  node[parts[parts.length - 1]] = null;
}


/**
 * 把服务端快照合并进内存：远端为准，但本地墓碑（null）与本地未读状态优先。
 *
 * 墓碑优先的原因：删除的 PUT 可能仍在途/未发出，被 sync 覆盖会让服务端残留
 * （例如已发送草稿）拉回本地复活。未读状态只按 mergeUnreadSessionState 并集合并。
 */
export function mergeSyncedServerPrefs(
  local: ServerPrefs | null,
  remote: ServerPrefs,
): ServerPrefs {
  const merged: ServerPrefs = { ...remote };
  if (!local) return merged;
  merged.unreadSessionState = mergeUnreadSessionState(
    parseUnreadSessionState(local.unreadSessionState),
    parseUnreadSessionState(remote.unreadSessionState ?? remote.unreadSessionIds),
  );
  for (const path of collectNullPaths(local, "", [])) {
    setPathNull(merged, path);
  }
  return merged;
}

/**
 * 网页激活同步（focus / visibilitychange(visible)）：重新拉取服务端偏好。
 *
 * - **模块级单例**：无论多少组件用 useServerPreferences，一个标签页只注册一对
 *   focus/visibilitychange 监听与一个 beforeunload；最后一个订阅者退订时全部移除。
 * - 注册与移除用同一组具名引用（原先 beforeunload 用两个匿名箭头，永远删不掉）。
 * - 并发/连续激活合并为一次请求（见 syncServerPrefsFromServer 的 in-flight 复用）。
 */
export interface ActivationSyncTargets {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface ActivationSyncController {
  /** 登记一个使用者；返回退订函数（幂等）。返回的退订函数负责配对解除监听。 */
  retain(): () => void;
  /** 当前是否已挂上监听（测试断言用）。 */
  isAttached(): boolean;
  /** 当前使用者数量（测试断言用）。 */
  refCount(): number;
}

export function createActivationSyncController(deps: {
  /** window：focus + beforeunload */
  windowTarget: ActivationSyncTargets;
  /** document：visibilitychange */
  documentTarget: ActivationSyncTargets;
  isVisible: () => boolean;
  syncNow: () => void;
  flushNow: () => void;
}): ActivationSyncController {
  const onActivate = (): void => {
    if (!deps.isVisible()) return;
    deps.syncNow();
  };
  const onBeforeUnload = (): void => {
    deps.flushNow();
  };
  let count = 0;
  let attached = false;
  const attach = (): void => {
    if (attached) return;
    attached = true;
    deps.windowTarget.addEventListener("focus", onActivate);
    deps.documentTarget.addEventListener("visibilitychange", onActivate);
    deps.windowTarget.addEventListener("beforeunload", onBeforeUnload);
  };
  const detach = (): void => {
    if (!attached) return;
    attached = false;
    deps.windowTarget.removeEventListener("focus", onActivate);
    deps.documentTarget.removeEventListener("visibilitychange", onActivate);
    deps.windowTarget.removeEventListener("beforeunload", onBeforeUnload);
  };
  return {
    retain() {
      count += 1;
      if (count === 1) attach();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        count = Math.max(0, count - 1);
        if (count === 0) detach();
      };
    },
    isAttached: () => attached,
    refCount: () => count,
  };
}

/**
 * 服务端偏好是否已经加载过一次（含成功的激活同步）。
 * 供「只在拿到服务端状态后才做决定」的迁移逻辑用：服务端已经是新模型时，
 * 本地旧列表不该把共享列表覆盖掉。
 */
export function isServerPrefsLoaded(): boolean {
  return singletonLoaded;
}

/** 从服务端重新拉取并合并到内存（并发调用合并为一次 GET）。 */
export function syncServerPrefsFromServer(): Promise<void> {
  if (syncPromise) return syncPromise;
  syncPromise = fetchPrefs()
    .then((remote) => {
      const before = singletonPrefs;
      const merged = mergeSyncedServerPrefs(before, remote);
      // 未 flush 的脏键以合并**前**的本地值为准：脏键已记、PUT 还在防抖里时切回前台，
      // GET 会把本地刚改的值盖回旧值，随后按被盖过的内存发 patch —— 用户的改动就静默丢了。
      for (const path of new Set([...dirtyPaths].map(effectiveDirtyPath))) {
        setPatchValue(merged, path, (before ? getByDottedPath(before, path) : undefined) ?? null);
      }
      singletonPrefs = merged;
      singletonLoaded = true;
      notify();
    })
    .catch(() => undefined)
    .finally(() => {
      syncPromise = null;
    });
  return syncPromise;
}

/** 浏览器侧的激活同步单例（懒建：只在有订阅者时触碰 window/document）。 */
let activationSync: ActivationSyncController | null = null;

function getActivationSync(): ActivationSyncController | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  if (!activationSync) {
    activationSync = createActivationSyncController({
      windowTarget: window,
      documentTarget: document,
      isVisible: () => document.visibilityState === "visible",
      syncNow: () => {
        void syncServerPrefsFromServer();
      },
      flushNow: flushServerPrefs,
    });
  }
  return activationSync;
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
    // 激活同步是模块级单例：首个订阅者挂监听，最后一个退订时移除（不再每实例各挂一套）。
    const release = getActivationSync()?.retain();
    void ensureServerPrefsLoaded().then((loaded) => {
      // 加载完成后若有本地已应用值（接入点在加载前写入），保留内存值避免闪回
      if (singletonPrefs === loaded || Object.keys(loaded).length === 0) {
        setPrefs(readPrefs());
      }
    });
    return () => {
      subscribers.delete(sub);
      release?.();
    };
  }, []);

  return prefs;
}

/** 测试用：清空脏键集合与防抖计时器，避免用例之间互相影响。 */
export function resetServerPrefsDirtyStateForTests(): void {
  dirtyPaths.clear();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}
