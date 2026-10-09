/**
 * 虚拟模型路由的显示（TUI 页脚那行 `auto • high → gpt-5.6-luna • medium` 的右半边）。
 *
 * 语义：`selected` 是用户在模型下拉里选的那个（可能是虚拟模型），`routed` 是**实际派发**给
 * 供应商的物理模型 + 档位（SDK 的 `session.routedModel`，只有虚拟模型路由过才有）。
 * 两者一样（普通模型）时什么都不显示 —— 免得每张卡片都挂一条没有信息量的尾巴。
 */

export type ModelRouteView = {
  id: string;
  provider: string;
  thinkingLevel?: string;
};

export type SelectedModelView = {
  provider: string;
  modelId: string;
} | null | undefined;

/**
 * 需要显示「实际派发」时返回 `{ id, thinkingLevel }`，否则 null。
 *
 * 判据：有 routed、且它的 (provider,id) 与选中的 (provider,modelId) 不同。
 * 缺 selected 时（还没选过模型）也显示 —— 那时候「实际用的是哪个」更有用。
 */
export function routedModelSuffix(
  routed: ModelRouteView | null | undefined,
  selected: SelectedModelView,
): { id: string; thinkingLevel: string | null } | null {
  if (!routed || typeof routed.id !== "string" || routed.id === "") return null;
  if (selected && selected.provider === routed.provider && selected.modelId === routed.id) return null;
  return {
    id: routed.id,
    thinkingLevel: typeof routed.thinkingLevel === "string" && routed.thinkingLevel ? routed.thinkingLevel : null,
  };
}
