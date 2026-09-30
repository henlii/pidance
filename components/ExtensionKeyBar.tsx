"use client";

import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/locales/en";
import {
  EXTENSION_KEY_BAR_KEYS,
  EXTENSION_KEY_BAR_LABEL_KEYS,
  keyBarKeyData,
  type ExtensionKeyBarKey,
} from "@/lib/extension-key-bar";

/** 按键条自身高度（px）：上 8 + 按钮 44 + 下 8。面板要按它让出底部空间。 */
export const EXTENSION_KEY_BAR_HEIGHT = 60;

/** 键面字符（方向键用箭头，Enter/Esc 用文字缩写 —— 与终端习惯一致）。 */
const BUTTON_GLYPHS: Record<ExtensionKeyBarKey, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Enter: "⏎",
  Escape: "Esc",
};

/**
 * 窄视口下的「屏幕按键条」（issue #113）。
 *
 * 只在插件界面占着键盘时出现（判定在 lib/extension-key-bar.ts）：手机软键盘产不出方向键，
 * 问卷/选择这类面板在手机上本来是按不动的。这里只发**按键序列**，和物理键盘走同一条通道。
 *
 * 样式只取 app/globals.css 的主题变量；触摸目标按 44px 给足。
 */
export function ExtensionKeyBar({ onKey }: { onKey: (key: ExtensionKeyBarKey, data: string) => void }) {
  const { t } = useI18n();
  // 固定在屏幕底部（用户要求：扩展按钮放下面，拇指够得着）。流里补一块等高的占位，
  // 免得挡住面板正文/状态栏；高度 = 上下 padding 8+8 + 按钮 44 + 安全区。
  return (
    <>
      <div aria-hidden="true" style={{ flexShrink: 0, height: `calc(${EXTENSION_KEY_BAR_HEIGHT}px + env(safe-area-inset-bottom))` }} />
      <KeyBarBody onKey={onKey} />
    </>
  );
}

function KeyBarBody({ onKey }: { onKey: (key: ExtensionKeyBarKey, data: string) => void }) {
  const { t } = useI18n();
  return (
    <div
      data-extension-key-bar="true"
      role="toolbar"
      aria-label={t("keyBar_title")}
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 40,
        flexShrink: 0,
        display: "flex",
        justifyContent: "center",
        gap: 8,
        padding: "8px 12px calc(8px + env(safe-area-inset-bottom))",
        borderTop: "1px solid var(--border)",
        background: "var(--bg-panel)",
      }}
    >
      {EXTENSION_KEY_BAR_KEYS.map((key) => {
        const data = keyBarKeyData(key);
        const label = t(EXTENSION_KEY_BAR_LABEL_KEYS[key] as TranslationKey);
        return (
          <button
            key={key}
            type="button"
            // 量不出键序列就不显示这个键（可预期的降级：宁缺勿错）
            disabled={data === null}
            aria-label={label}
            title={label}
            onClick={() => {
              if (data !== null) onKey(key, data);
            }}
            style={{
              minWidth: 44,
              height: 44,
              padding: "0 10px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text)",
              fontFamily: "var(--font-mono)",
              fontSize: 13,
            }}
          >
            {BUTTON_GLYPHS[key]}
          </button>
        );
      })}
    </div>
  );
}
