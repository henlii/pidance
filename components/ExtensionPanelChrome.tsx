"use client";

import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { CHAT_COLUMN_MAX_WIDTH_CSS } from "@/lib/chat-column";
import { useI18n } from "@/lib/i18n";

/**
 * 扩展面板外壳：左侧箭头是**折叠/展开按钮**，标题区（按钮右侧那一块）是**拖动改高度**的把手。
 *
 * 为什么不再整行可点折叠：整行要留给拖动（用户口径 2026-10-06）。折叠态只留一行标题，
 * 正文与底栏都不渲染；收起时拖动没有意义（没有正文可变高），所以只有展开态收拖动。
 *
 * 高度上限是**会话列的高度**（CSS 里插槽 max-height: 100%），拖到哪算哪、不吸附；
 * 下界是标题行本身（正文被挤到 0，面板内部自己滚）。
 *
 * 为什么没有键盘调高度：面板可见期间 keytrap 是键盘的归属者（焦点离开面板就会被拉回去，
 * 见 ExtensionCustomPanel 的焦点守卫），把手拿不到焦点，加了也是死路。键盘用户靠左侧按钮
 * 折叠/展开 —— 改高度是取悦眼睛的操作，不做也不影响用。
 *
 * 拖动只接鼠标与触控笔：触屏上这块区域还要留给长标题自己的滚动（touch-action 保持默认的
 * pan-y），纵向拖动会被浏览器当成滚动。
 */
export function ExtensionPanelChrome({
  title,
  accessibilityLabel,
  overlay = false,
  extraHeader,
  footerActions,
  footer,
  children,
  panelStyle,
  expanded: expandedProp,
  onExpandedChange,
  height: heightProp,
  onHeightChange,
}: {
  title: ReactNode;
  accessibilityLabel?: string;
  overlay?: boolean;
  extraHeader?: ReactNode;
  /**
   * 底栏**左侧**的动作区（「复制」这类控制按钮）。
   * 与右侧的主按钮（取消/提交）同一排：控制按钮左对齐、主按钮右对齐。
   */
  footerActions?: ReactNode;
  /** 底栏**右侧**的主按钮（取消 / 确认 / 提交）。 */
  footer?: ReactNode;
  children: ReactNode;
  /** 覆盖面板本体尺寸；半屏面板用它落实插件给的 width 差异。 */
  panelStyle?: CSSProperties;
  /**
   * 展开态受控：面板展开时会替代/挤占会话区（见 ChatWindow 的插槽布局），
   * 所以展开与否必须由持有布局的那一层知道。不传则退回组件内部 state。
   */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /**
   * 拖动出来的高度（px）。`null` = 交给内容决定（默认）。
   *
   * 与 expanded 同理必须受控：一次插件流程会连着换面板（/advisor-models 四步里
   * custom 与弹窗交替），外壳组件实例会跟着换，状态留在它里面的话每换一步就被丢掉。
   * 不传则退回组件内部 state。
   */
  height?: number | null;
  onHeightChange?: (height: number | null) => void;
}) {
  const { t } = useI18n();
  const titleText = accessibilityLabel ?? (typeof title === "string" ? title : undefined);
  // 默认展开——上限高不代表一定变高（高度仍由内容决定，短提问不会因此占满屏），
  // 长提问默认就能看全，用户嫌大点一下左侧箭头收起。状态是每个面板自己的，不跨请求记忆。
  const [expandedLocal, setExpandedLocal] = useState(true);
  const expanded = expandedProp ?? expandedLocal;
  const [heightLocal, setHeightLocal] = useState<number | null>(null);
  const height = heightProp !== undefined ? heightProp : heightLocal;
  const shellRef = useRef<HTMLElement>(null);
  /** 拖动起点：起始 Y、起始高度与上下界（界在按下时量一次，拖动期间不再量）。 */
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number; min: number; max: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const toggle = () => {
    const next = !expanded;
    if (onExpandedChange) onExpandedChange(next);
    else setExpandedLocal(next);
  };
  const applyHeight = (next: number | null) => {
    if (onHeightChange) onHeightChange(next);
    else setHeightLocal(next);
  };
  /** 面板能长到多高：会话列的高度（面板落在会话列里的插槽，拖满就是它的高度）。 */
  const availableHeight = () => {
    const box = shellRef.current?.closest("[data-chat-root]") ?? shellRef.current?.parentElement ?? null;
    return box ? box.getBoundingClientRect().height : 0;
  };
  /** 最矮就是标题行本身（正文挤到 0，面板内部自己滚）。 */
  const headerHeight = () =>
    shellRef.current?.querySelector(".extension-panel-header")?.getBoundingClientRect().height ?? 44;
  const clampHeight = (value: number, min: number, max: number) =>
    Math.round(Math.min(Math.max(value, min), Math.max(min, max)));

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 触屏拖动会跟标题自身的滚动打架（见文件头注释），这里只接鼠标与触控笔
    if (event.pointerType === "touch" || event.button !== 0 || !expanded) return;
    const shell = shellRef.current;
    if (!shell) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: shell.getBoundingClientRect().height,
      min: headerHeight(),
      max: availableHeight(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    // 往上拖 = 变高（把手在面板顶部，与终端里拖分隔条的方向感一致）
    applyHeight(clampHeight(drag.startHeight + (drag.startY - event.clientY), drag.min, drag.max));
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const className = [
    "extension-panel-shell",
    overlay ? "extension-panel-shell--overlay" : "",
    expanded ? "extension-panel-shell--expanded" : "",
    dragging ? "is-resizing" : "",
  ].filter(Boolean).join(" ");
  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-label={titleText}
      className={className}
      ref={shellRef}
      style={{
        width: CHAT_COLUMN_MAX_WIDTH_CSS,
        ...panelStyle,
        // 拖动出来的高度压过插件声明的尺寸：这是用户刚做的显式操作。
        // 收起态不套这个高度：那时只渲染标题行，套上去会在下面留一大块空白。
        ...(expanded && height !== null ? { height: `${height}px` } : {}),
      }}
    >
      <header className="extension-panel-header">
        <button
          type="button"
          className="extension-panel-collapse"
          aria-expanded={expanded}
          aria-label={expanded ? t("extension_panelCollapse") : t("extension_panelExpand")}
          title={expanded ? t("extension_panelCollapse") : t("extension_panelExpand")}
          onClick={toggle}
        >
          <span className={`extension-panel-chevron${expanded ? " is-expanded" : ""}`} aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 2.5 7.5 6 4 9.5" />
            </svg>
          </span>
        </button>
        {/* 标题区 = 拖动把手（只接指针；键盘调高度为什么没有，见文件头注释） */}
        <div
          className="extension-panel-title"
          title={expanded ? t("extension_panelResize") : undefined}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {title}
        </div>
        {extraHeader ? <div className="extension-panel-header-actions">{extraHeader}</div> : null}
      </header>
      {/* data-extension-panel-body：尺寸上报选宿主用（面板占屏幕时插件看到的「终端」就是它） */}
      {expanded ? (
        <div className="extension-panel-body" data-extension-panel-body="true">
          {children}
        </div>
      ) : null}
      {expanded && (footer || footerActions) ? (
        <footer className="extension-panel-footer">
          <div className="extension-panel-footer-actions">{footerActions}</div>
          <div className="extension-panel-footer-primary">{footer}</div>
        </footer>
      ) : null}
    </section>
  );
}
