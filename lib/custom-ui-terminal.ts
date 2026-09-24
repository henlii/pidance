export const DEFAULT_CUSTOM_UI_COLUMNS = 92;
export const DEFAULT_CUSTOM_UI_ROWS = 40;

export interface HeadlessCustomUiTerminal {
  readonly columns: number;
  readonly rows: number;
  readonly kittyProtocolActive: false;
}

export interface HeadlessCustomUiTui {
  readonly terminal: HeadlessCustomUiTerminal;
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

  return Object.freeze({
    terminal: Object.freeze(terminal),
    requestRender,
    stop() {},
    start() {},
  });
}
