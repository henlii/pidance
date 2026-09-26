/**
 * 「插件 ANSI 主题刚变过」的浏览器侧信号（issue #109）。
 *
 * 为什么需要：插件渲染出来的行（`renderedLines`）是**服务端按当时的主题**渲染后下发、
 * 由浏览器留在手里的；切主题不会让手里那份自己变色。widget / custom 面板 / 状态条 /
 * 工具行都由宿主重渲并经 SSE 覆盖，**已投影的消息行**只能让当前会话重拉一页才会带上新色值。
 *
 * 信号从哪里来：**服务端广播**，不是本地那次乐观写入。
 * - 用户在设置里切明暗 → 客户端先本地生效，PUT 落到服务端后
 *   `app/api/preferences/route.ts` 先同步插件主题、**再**广播变更；
 * - 插件 `ctx.ui.setTheme` → `lib/web-extension-ui.ts` 的 `applyShellTheme` 同样是
 *   「先切进程内主题，再写偏好 + 广播」。
 * 两条路都保证「广播到达时插件主题已经换好了」，所以刷新投影只能挂在这条广播上：
 * 挂在本地 `setServerPref` 那一刻会早于服务端切换（PUT 还防抖 400ms），拉回来仍是旧色。
 *
 * 只认 dark/light：服务端只把 `theme.mode` 的这两个值映射到插件主题
 * （见 `lib/theme-preference-sync.ts`），`system` 与用户自定义主题名**不动**插件主题
 * ——通知了只会白拉一次请求。
 *
 * 本模块不读盘、不碰 DOM：纯函数 + 进程内订阅表，可直接在 node 测试里驱动。
 */

export type PiShellThemeName = "dark" | "light";

/** 有壳侧对应外观、且服务端会同步给插件主题的档位。 */
export function isShellThemeName(value: unknown): value is PiShellThemeName {
  return value === "dark" || value === "light";
}

/**
 * 远程偏好广播的载荷里，这次是否改了「壳的明暗」；是则返回新的档位，否则 null。
 *
 * 两种载荷形状都要认（服务端与客户端各写一种）：
 * - `{ theme: { mode, style } }`：客户端整包 patch 的形态（点路径 `theme`）；
 * - `{ "theme.mode": "dark" }`：插件 `setTheme` 走 `applyShellTheme` 广播的形态。
 * 只改 `theme.style`（皮肤）返回 null —— 皮肤与插件 ANSI 无关，不该触发重拉。
 */
export function piThemeModeInPrefsPatch(changed: unknown): PiShellThemeName | null {
  if (!changed || typeof changed !== "object" || Array.isArray(changed)) return null;
  const patch = changed as Record<string, unknown>;
  const flat = patch["theme.mode"];
  if (isShellThemeName(flat)) return flat;
  const nested = patch.theme;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const mode = (nested as { mode?: unknown }).mode;
    if (isShellThemeName(mode)) return mode;
  }
  return null;
}

/** 本次页面会话里最后一次通知过的档位（null = 还没通知过）。 */
let lastNotified: PiShellThemeName | null = null;
const listeners = new Set<(mode: PiShellThemeName) => void>();

/**
 * 通知一次「插件主题已应用」。返回是否真的通知了。
 *
 * 同名重复不通知：同一个档位会因为「本地写入 + 服务端广播回显」以及别的偏好变更
 * 反复到达，每次重拉都是白拉的请求。
 */
export function notifyPiThemeApplied(mode: unknown): boolean {
  if (!isShellThemeName(mode) || mode === lastNotified) return false;
  lastNotified = mode;
  for (const listener of [...listeners]) {
    try {
      listener(mode);
    } catch {
      // 单个订阅者出错不影响其它订阅者（与 pidance-prefs-bus 同一处理）
    }
  }
  return true;
}

/**
 * 应用级 SSE 收到一次偏好广播时调用（`lib/server-preferences.ts` 的流处理里）。
 * 返回是否因此通知了订阅者。**只认远程广播**：本地乐观写入不走这里。
 */
export function notifyPiThemeAppliedFromPrefsPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const event = payload as { type?: unknown; changed?: unknown };
  if (event.type !== "prefs") return false;
  return notifyPiThemeApplied(piThemeModeInPrefsPatch(event.changed));
}

export function subscribePiThemeApplied(listener: (mode: PiShellThemeName) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试用：清掉去重记忆与订阅者。 */
export function resetPiThemeSignalForTests(): void {
  lastNotified = null;
  listeners.clear();
}
