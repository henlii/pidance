/**
 * P1-2 模型手动覆盖保留（#17）。
 *
 * 用户手动选择的模型不得被内部消息覆盖。固定优先级（高→低）：
 *   1. 当前 session 内用户明确选择的 provider/model（override / pending）
 *   2. session 已持久化的 model change（磁盘 context.model，Pi 原生 model_change）
 *   3. agent/default 配置
 *   4. 全局默认模型
 *
 * extension 通知、subagent 完成提示、activity、自定义消息均不得被当成用户
 * 模型选择；它们只可能经 loadSession 读取磁盘 model_change，而 settleModelOverride
 * 的吸附逻辑保证磁盘未同步（写盘竞态 / fork 后新会话无 model_change）时
 * 用户选择仍然优先，不被内部刷新覆盖。
 */

export interface SelectedModel {
  provider: string;
  modelId: string;
}

/** 两个模型选择是否相同（null/undefined 一律视为空值，空值之间相等）。 */
export function sameModel(
  a: SelectedModel | null | undefined,
  b: SelectedModel | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return a.provider === b.provider && a.modelId === b.modelId;
}

/**
 * 按固定优先级解析当前显示的模型：
 * - override：当前 session 内用户明确选择的模型（最高）
 * - pending：新会话发送中携带的用户选择
 * - persisted：session 磁盘 model_change（context.model）
 * - fallback：agent/default 配置或全局默认（最低，通常为 null 表示未定）
 */
export function resolveDisplayModel(
  override: SelectedModel | null | undefined,
  persisted: SelectedModel | null | undefined,
  fallback: SelectedModel | null | undefined = null,
): SelectedModel | null {
  return override ?? persisted ?? fallback ?? null;
}

/**
 * loadSession 后 override 的「吸附」决策：
 * - 无 override → 保持 null
 * - 磁盘相对上次观察发生了新变化 → 这是外部（另一实例/标签页）的写入，
 *   磁盘优先，清除 override。否则本页既会显示旧模型，又会在下次发送时
 *   把对方的选择主动写回去。
 * - override 与磁盘 persisted 一致（set_model 已落盘）→ 清除 override，由磁盘
 *   model_change 权威接管
 * - override 存在但磁盘缺失/不一致（写盘竞态、fork 后新会话无 model_change）→
 *   保留 override，用户选择优先，防止被内部 loadSession 覆盖
 */
export function settleModelOverride(input: {
  override: SelectedModel | null | undefined;
  persisted: SelectedModel | null | undefined;
  /**
   * 上一次由**磁盘上下文**观察到的值（不得混入 hot/live 投影）：
   * 只有它变化才说明磁盘被外部改动过。null/undefined = 尚无观察基线。
   */
  lastDiskObserved?: SelectedModel | null | undefined;
}): SelectedModel | null {
  const { override, persisted, lastDiskObserved } = input;
  if (!override) return null;
  if (persisted && lastDiskObserved && !sameModel(persisted, lastDiskObserved)) {
    return null;
  }
  return sameModel(override, persisted) ? null : override;
}

/**
 * fork / through-leaf 新建会话是否需要继承父会话模型：
 * 新文件已含持久化 model_change 时无需继承（Pi 原生已复制）；源会话无模型时
 * 无从继承。
 */
export function shouldInheritModel(
  hasPersistedModelChange: boolean,
  sourceModel: SelectedModel | null | undefined,
): boolean {
  return !hasPersistedModelChange && Boolean(sourceModel);
}
