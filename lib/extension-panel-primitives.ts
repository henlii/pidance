/**
 * 面板组件树的**原语识别**（issue #116，即 #114 的第 1 层）。
 *
 * 为什么值得单独做：行级识别（第 2 层）只能「合成方向键」，点第 N 项 = 发 ↓ ×N 再回车 —— 中间
 * 面板一旦重渲染就可能点错项（只能靠发键前后的自校验兜底）。而插件用的 pi-tui 原语**公开**了
 * 直接设置状态的接口：`SelectList.setSelectedIndex(index)`、`SelectList.getSelectedItem()`、
 * `Input.getValue()/setValue()`。所以只要能走一遍组件树认出它们，就能「直接设置」，不再模拟按键。
 *
 * 只走**公开面**：`Container.children` 与 `Box.children` 都是公开数组（pi-tui dist/tui.js:72-77），
 * 识别用鸭子类型（有 getSelectedItem + setSelectedIndex 就是 SelectList），不碰 private 字段
 * （`SelectList.items`、`Text.text` 都是 private —— 选项清单与正文原文仍由第 2 层的渲染行承担）。
 */

/** 树很深时也要有界：插件面板通常几层，这里给足余量即可。 */
const MAX_WALK_NODES = 200;
const MAX_WALK_DEPTH = 12;

type AnyComponent = {
  children?: unknown;
  getSelectedItem?: unknown;
  setSelectedIndex?: unknown;
} & Record<string, unknown>;

/** 子节点：只认公开的 children 数组（Container / Box 同形）。 */
function childComponents(node: AnyComponent): AnyComponent[] {
  const children = node.children;
  if (!Array.isArray(children)) return [];
  return children.filter((child): child is AnyComponent => Boolean(child) && typeof child === "object");
}

/** 广度优先遍历组件树（有界）。 */
export function walkPanelComponents(root: unknown): AnyComponent[] {
  const start = root as AnyComponent | undefined;
  if (!start || typeof start !== "object") return [];
  const out: AnyComponent[] = [];
  const queue: { node: AnyComponent; depth: number }[] = [{ node: start, depth: 0 }];
  while (queue.length > 0 && out.length < MAX_WALK_NODES) {
    const { node, depth } = queue.shift() as { node: AnyComponent; depth: number };
    out.push(node);
    if (depth >= MAX_WALK_DEPTH) continue;
    for (const child of childComponents(node)) queue.push({ node: child, depth: depth + 1 });
  }
  return out;
}

/** 鸭子类型：同时具备 getSelectedItem 与 setSelectedIndex 就当成可选列表。 */
export function isSelectListLike(node: unknown): boolean {
  const candidate = node as AnyComponent | undefined;
  if (!candidate || typeof candidate !== "object") return false;
  return typeof candidate.getSelectedItem === "function" && typeof candidate.setSelectedIndex === "function";
}

/** 鸭子类型：具备 getValue 与 setValue 就当成单行/多行输入。 */
export function isInputLike(node: unknown): boolean {
  const candidate = node as AnyComponent | undefined;
  if (!candidate || typeof candidate !== "object") return false;
  return typeof candidate.getValue === "function" && typeof candidate.setValue === "function";
}

/** 树里第一个可选列表（没有就是 null）。 */
export function findPanelSelectList(root: unknown): AnyComponent | null {
  for (const node of walkPanelComponents(root)) {
    if (isSelectListLike(node)) return node;
  }
  return null;
}

/** 树里第一个输入原语（没有就是 null）。 */
export function findPanelInput(root: unknown): AnyComponent | null {
  for (const node of walkPanelComponents(root)) {
    if (isInputLike(node)) return node;
  }
  return null;
}

/**
 * 直接设置选中项。返回是否真的设置了 —— 非法索引、原语不认、抛错都返回 false，
 * 由调用方回退到第 2 层的合成按键路径（宁可用旧办法，也不能点错）。
 */
export function applySelectListIndex(selectList: unknown, index: number): boolean {
  if (!isSelectListLike(selectList)) return false;
  if (!Number.isInteger(index) || index < 0) return false;
  try {
    (selectList as { setSelectedIndex: (value: number) => void }).setSelectedIndex(index);
    return true;
  } catch {
    return false;
  }
}
