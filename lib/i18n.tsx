"use client";

import { createElement, useCallback, useEffect, useMemo, useState } from "react";
import { createContext, useContext } from "react";
import { en, type TranslationKey } from "./locales/en";
import { zhCN } from "./locales/zh-CN";
import { ensureServerPrefsLoaded, getServerPref, setServerPref } from "./server-preferences";

export const I18N_STORAGE_KEY = "pidance:i18n:v1";
export type Locale = "en" | "zh-CN";
export type Messages = Record<TranslationKey, string>;

/** 可注入 storage，便于迁移单测。 */
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/**
 * 读取持久化 locale：仅读规范键；损坏输入安全返回 null。
 */
export function readPersistedLocale(storage: StorageLike): Locale | null {
  try {
    const raw = storage.getItem(I18N_STORAGE_KEY);
    if (raw === null) return null;
    return parsePersistedLocale(raw);
  } catch {
    return null;
  }
}

export function normalizeLocale(value: unknown): Locale {
  if (typeof value !== "string") return "en";
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  return normalized === "zh" || normalized === "zh-cn" || normalized === "zh-hans" || normalized.startsWith("zh-")
    ? "zh-CN"
    : "en";
}

export function parsePersistedLocale(value: unknown): Locale | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const locale = typeof parsed === "string"
      ? parsed
      : parsed && typeof parsed === "object" && "locale" in parsed
        ? (parsed as { locale?: unknown }).locale
        : null;
    if (typeof locale !== "string") return null;
    const normalized = locale.trim().toLowerCase().replace(/_/g, "-");
    if (normalized === "en") return "en";
    if (normalized === "zh" || normalized === "zh-cn" || normalized === "zh-hans") return "zh-CN";
  } catch {
    return null;
  }
  return null;
}

export function interpolate(template: string, values: Record<string, unknown> = {}): string {
  return template.replace(/\{([^{}]+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
  );
}

export function getIntlLocale(locale: Locale): string {
  return locale === "zh-CN" ? "zh-CN" : "en-US";
}

export function createTranslator(locale: Locale) {
  const messages: Messages = locale === "zh-CN" ? zhCN : en;
  return (key: TranslationKey, values?: Record<string, unknown>) =>
    interpolate(messages[key] ?? en[key], values);
}

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, values?: Record<string, unknown>) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    let stored: Locale | null = null;
    try {
      stored = readPersistedLocale(window.localStorage);
    } catch {
      // 无法访问存储时继续使用浏览器语言。
    }
    const next = stored ?? normalizeLocale(window.navigator.language);
    setLocaleState(next);
    document.documentElement.lang = next;
    void ensureServerPrefsLoaded().then(() => {
      const remote = getServerPref<unknown>("locale");
      if (typeof remote !== "string") return;
      const normalized = normalizeLocale(remote);
      setLocaleState(normalized);
      document.documentElement.lang = normalized;
    });
  }, []);

  const setLocale = useCallback((next: Locale) => {
    const normalized = normalizeLocale(next);
    setLocaleState(normalized);
    document.documentElement.lang = normalized;
    try {
      window.localStorage.setItem(I18N_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // 隐私模式或禁用存储不应阻止切换语言。
    }
    setServerPref("locale", normalized);
  }, []);
  const t = useMemo(() => createTranslator(locale), [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return createElement(I18nContext.Provider, { value }, children);
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n 必须在 I18nProvider 内使用");
  return context;
}
