"use client";

import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/locales/en";
import type { PanelView } from "@/lib/extension-panel-view";

/** 在视图里按内容找某一行（从 fromLine 起，按原文顺序）。 */
function findLineIndex(view: PanelView, line: string, fromLine: number): number {
  let lineNo = -1;
  for (const block of view.blocks) {
    for (const candidate of block.lines) {
      lineNo += 1;
      if (lineNo < fromLine) continue;
      if (candidate === line) return lineNo;
    }
  }
  return -1;
}

/**
 * 插件面板正文的「网页化」视图（issue #114 第 2 层）。
 *
 * 只换样式与交互外壳，**不改内容**：每一行的文本仍由调用方按既有 ANSI 机制渲染
 * （`renderLine`），这里只决定「这一块用什么元素包住」：
 * - 边框块 → CSS 细线（本次要的观感变化；原始字符形态由「切回原样」随时可见）
 * - 标题块 → 标题字号/字重
 * - 选项块 → 可点行（点它 = 合成方向键 + 回车，由调用方发送）
 * - 其余正文 → 等宽正文行（**保持等宽**：插件靠它对齐表格与方框）
 */
export function ExtensionPanelWebView({
  view,
  renderLine,
  onSelectOption,
}: {
  view: PanelView;
  renderLine: (line: string, key: string) => ReactNode;
  onSelectOption?: (index: number) => void;
}) {
  const { t } = useI18n();
  const optionLineIndexes = new Map<number, { index: number; cursor: boolean; label: string }>();
  if (view.options) {
    // 选项行在原文里的行号：按内容顺序匹配（同一行文本可能重复，按先后取）
    let searchFrom = 0;
    for (const item of view.options.items) {
      const at = findLineIndex(view, item.line, searchFrom);
      if (at >= 0) {
        optionLineIndexes.set(at, { index: item.index, cursor: item.cursor, label: item.label });
        searchFrom = at + 1;
      }
    }
  }

  let lineNo = -1;
  return (
    <>
      {view.blocks.map((block, blockIndex) => {
        if (block.kind === "border") {
          return (
            <div
              key={`panel-block-${blockIndex}`}
              data-panel-block="border"
              // 边框行换成一条细线：不再画字符，但高度接近原来的行高（不塌陷）
              style={{ borderTop: "1px solid var(--border)", height: 2, margin: "2px 0" }}
            />
          );
        }
        return (
          <div
            key={`panel-block-${blockIndex}`}
            data-panel-block={block.kind}
            style={
              block.kind === "heading"
                ? { fontSize: 15, fontWeight: 600, lineHeight: 1.5, margin: "2px 0 4px" }
                : undefined
            }
          >
            {block.lines.map((line) => {
              lineNo += 1;
              const option = optionLineIndexes.get(lineNo);
              if (option && onSelectOption) {
                return (
                  <button
                    key={`panel-line-${lineNo}`}
                    type="button"
                    data-panel-option={option.index}
                    aria-selected={option.cursor}
                    aria-label={t("panel_selectOption" as TranslationKey, { label: option.label })}
                    onClick={() => onSelectOption(option.index)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "6px 8px",
                      borderRadius: 6,
                      border: 0,
                      cursor: "pointer",
                      font: "inherit",
                      // 选中项用应用风格高亮（跟随明暗），而不是插件的 RGB 反显
                      background: option.cursor ? "var(--bg-selected)" : "transparent",
                      color: "var(--text)",
                    }}
                  >
                    {renderLine(line, `panel-line-${lineNo}`)}
                  </button>
                );
              }
              return (
                <div key={`panel-line-${lineNo}`} data-panel-line={lineNo}>
                  {renderLine(line, `panel-line-${lineNo}`)}
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}
