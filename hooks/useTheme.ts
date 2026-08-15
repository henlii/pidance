"use client";

import { useCallback, useSyncExternalStore } from "react";
import { ensureServerPrefsLoaded, getServerPref, setServerPref } from "@/lib/server-preferences";

export type Theme = "light" | "dark";
export type ThemeMode = Theme | "system";
export type ThemeStyle = "chamber" | "fusion";

const THEME_KEY = "pi-theme";
const THEME_STYLE_KEY = "pi-theme-style";
const listeners = new Set<() => void>();
let mediaQuery: MediaQueryList | null = null;

function isThemeMode(value: string | null): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

function isThemeStyle(value: string | null): value is ThemeStyle {
  return value === "chamber" || value === "fusion";
}

function resolveTheme(mode: ThemeMode): Theme {
  if (mode !== "system") return mode;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readMode(): ThemeMode {
  if (typeof document === "undefined") return "light";
  const attribute = document.documentElement.dataset.themeMode;
  const normalizedAttribute = attribute ?? null;
  if (isThemeMode(normalizedAttribute)) return normalizedAttribute;
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (isThemeMode(stored)) return stored;
  } catch {
    // 存储不可用时沿用当前 DOM 的实际明暗。
  }
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function readStyle(): ThemeStyle {
  if (typeof document === "undefined") return "chamber";
  const attribute = document.documentElement.dataset.themeStyle;
  const normalizedAttribute = attribute ?? null;
  if (isThemeStyle(normalizedAttribute)) return normalizedAttribute;
  try {
    const stored = localStorage.getItem(THEME_STYLE_KEY);
    if (isThemeStyle(stored)) return stored;
  } catch {
    // 存储不可用时使用 Chamber。
  }
  return "chamber";
}

function snapshotKey(): string {
  if (typeof document === "undefined") return "light|chamber|light";
  const mode = readMode();
  return `${mode}|${readStyle()}|${document.documentElement.classList.contains("dark") ? "dark" : "light"}`;
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

function handleSystemThemeChange(): void {
  if (readMode() !== "system") return;
  const theme = resolveTheme("system");
  document.documentElement.classList.toggle("dark", theme === "dark");
  notify();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  if (!mediaQuery && typeof window !== "undefined") {
    mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    mediaQuery.addEventListener("change", handleSystemThemeChange);
  }
  return () => {
    listeners.delete(callback);
    if (listeners.size === 0 && mediaQuery) {
      mediaQuery.removeEventListener("change", handleSystemThemeChange);
      mediaQuery = null;
    }
  };
}

type ToggleOrigin = { x: number; y: number };

function applyAppearance(mode: ThemeMode, style: ThemeStyle): void {
  const theme = resolveTheme(mode);
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.dataset.themeMode = mode;
  root.dataset.themeStyle = style;
  try {
    localStorage.setItem(THEME_KEY, mode);
    localStorage.setItem(THEME_STYLE_KEY, style);
  } catch {
    // 隐私模式、配额等存储错误不影响当前页面切换。
  }
  setServerPref("theme", { mode, style });
  notify();
}

if (typeof window !== "undefined") {
  void ensureServerPrefsLoaded().then(() => {
    const remote = getServerPref<{ mode?: unknown; style?: unknown }>("theme");
    const mode = typeof remote?.mode === "string" ? remote.mode : null;
    const style = typeof remote?.style === "string" ? remote.style : null;
    if (isThemeMode(mode)) applyAppearance(mode, isThemeStyle(style) ? style : readStyle());
  });
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, snapshotKey, () => "light|chamber|light");
  const [mode, style, theme] = snapshot.split("|") as [ThemeMode, ThemeStyle, Theme];

  const setAppearance = useCallback((nextMode: ThemeMode, nextStyle: ThemeStyle, origin?: ToggleOrigin) => {
    if (mode === nextMode && style === nextStyle) return;
    const apply = () => applyAppearance(nextMode, nextStyle);
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const supportsViewTransition = typeof document.startViewTransition === "function";
    if (!supportsViewTransition || reduceMotion) {
      apply();
      return;
    }

    const x = origin?.x ?? window.innerWidth / 2;
    const y = origin?.y ?? window.innerHeight / 2;
    const endRadius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const transition = document.startViewTransition(apply);
    transition.ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`] },
        { duration: 450, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)", pseudoElement: "::view-transition-new(root)" },
      );
    }).catch(() => {
      // 过渡被浏览器取消时，主题本身仍已应用。
    });
  }, [mode, style]);

  const setTheme = useCallback((next: ThemeMode, origin?: ToggleOrigin) => {
    setAppearance(next, style, origin);
  }, [setAppearance, style]);

  const setThemeStyle = useCallback((next: ThemeStyle, origin?: ToggleOrigin) => {
    setAppearance(mode, next, origin);
  }, [mode, setAppearance]);

  const toggleTheme = useCallback((origin?: ToggleOrigin) => {
    setTheme(theme === "dark" ? "light" : "dark", origin);
  }, [setTheme, theme]);

  return { theme, mode, themeStyle: style, toggleTheme, setTheme, setThemeStyle, isDark: theme === "dark" };
}
