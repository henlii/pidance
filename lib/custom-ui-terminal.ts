export const DEFAULT_CUSTOM_UI_COLUMNS = 92;
export const DEFAULT_CUSTOM_UI_ROWS = 40;

export interface HeadlessCustomUiTerminal {
  readonly columns: number;
  readonly rows: number;
  readonly kittyProtocolActive: false;
}

/**
 * 鸭子类型的「主编辑器」探针。
 *
 * 插件无法用 `instanceof` 判断 pi-tui 的编辑器（jiti 模块边界会让类身份不一致），
 * 它们按形状自检：同时具备 render / invalidate / handleInput / getText / setText
 * 才算「编辑器有焦点」（pi-subagents 的 fleet 状态 widget 就是这么判的，见其
 * `tui/fleet-status.ts` 的 `editorHasFocus()`）。所以这里提供一个只有这五个成员、
 * 其余行为全为 no-op 的探针 —— 形状对了，但不会替插件做任何事。
 */
export interface HeadlessCustomUiEditorProbe {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
  getText(): string;
  setText(text: string): void;
}

export function createEditorFocusProbe(): HeadlessCustomUiEditorProbe {
  return Object.freeze({
    render: () => [] as string[],
    invalidate: () => {},
    handleInput: () => {},
    // Web 输入区的真实文本由客户端把守（焦点与空文本都按客户端状态判定），
    // 探针只回答形状问题，不假装知道内容。
    getText: () => "",
    setText: () => {},
  });
}

export interface HeadlessCustomUiTuiOptions {
  /**
   * 主编辑器（Web 输入框）当前是否有焦点。省略即恒无焦点（`focusedComponent`
   * 为 undefined），与注入前的行为一致。
   */
  isEditorFocused?: () => boolean;
}

export interface HeadlessCustomUiTui {
  readonly terminal: HeadlessCustomUiTerminal;
  /**
   * 主编辑器有焦点时是那个鸭子类型探针，否则 undefined。
   *
   * 用 getter 而不是快照：焦点会随用户点击变化，插件在 render()/handleInput()
   * 里随时读到的必须是当前值。
   */
  readonly focusedComponent?: HeadlessCustomUiEditorProbe;
  requestRender(force?: boolean): void;
  /**
   * 插件用它在把终端让给外部编辑器前后做停/启（如 Ctrl+G 外部编辑器路径）。
   * Web 端没有可让出的终端，所以是 no-op；但**必须存在**——缺失会让插件在调用点
   * 抛 TypeError。
   *
   * no-op 不等于「编辑器一定失败」：插件随后 spawn 的编辑器若退出码为 0，会被它
   * 当成编辑成功；若那个进程挂住（继承来的 stdin 不是 tty），面板会一直等下去。
   * 这条路径在 Web 上没有等价语义。
   */
  stop(): void;
  start(): void;
}

export function createHeadlessCustomUiTui(
  requestRender: (force?: boolean) => void,
  columns: number | (() => number) = DEFAULT_CUSTOM_UI_COLUMNS,
  rows = DEFAULT_CUSTOM_UI_ROWS,
  options: HeadlessCustomUiTuiOptions = {},
): HeadlessCustomUiTui {
  const readColumns = typeof columns === "function" ? columns : () => columns;
  // 尺寸用 getter：插件是在 render() 里读 tui.terminal.columns 做布局判断的
  // （如 rpiv-ask-user 的 dialog-builder），视口变化后它必须与下一次 render(width)
  // 的参数一致。此前是冻结的常量，宽度变了这边还是旧值。
  const terminal = {
    get columns() {
      return readColumns();
    },
    get rows() {
      return rows;
    },
    kittyProtocolActive: false as const,
  };

  const probe = createEditorFocusProbe();
  const readFocused = options.isEditorFocused;
  const tui = {
    terminal: Object.freeze(terminal),
    requestRender,
    stop() {},
    start() {},
  } as HeadlessCustomUiTui & { focusedComponent?: HeadlessCustomUiEditorProbe };
  Object.defineProperty(tui, "focusedComponent", {
    enumerable: true,
    get: () => (readFocused?.() === true ? probe : undefined),
  });
  return Object.freeze(tui);
}
