/**
 * 读当前会话输入框（草稿）的文本，供扩展的 `ctx.ui.getEditorText()` 回传。
 *
 * 为什么读偏好文件而不是问客户端（issue #74）：
 * - 浏览器里的输入框是 React 本地状态；扩展调 `getEditorText()` 是**同步**的，
 *   没有可用的往返通道。
 * - 加一条「每次输入都上报」的通道会给普通打字加往返（这个仓库刻意避免的），
 *   只上报焦点那种稀疏事件又不足以回答「现在框里是什么」。
 * - 客户端本来就把草稿镜像到服务端偏好（`/api/preferences`，400ms 防抖，
 *   `lib/draft-store.ts`）。读这份镜像：**零新增往返**，代价是一次小文件读
 *   （本机偏好文件 42KB / 148 条草稿时，readFileSync + JSON.parse 实测约 0.5ms）。
 *
 * 语义边界（必须知道，不然会把延迟当成 bug）：
 * - 比输入框**滞后**（客户端 400ms 防抖 + 落盘），不是实时值。用户清空输入框走的是
 *   立即 flush（`lib/draft-store.ts` 的 setDraft/clearDraft），但仍要等一次 PUT 到达，
 *   所以「刚清空」那一瞬间这里还读得到旧文本 —— 消费方若拿它当激活门槛（pi-subagents
 *   的 fleet 就是 `getEditorText() === ""`），那一下按键会不生效。
 * - 多标签共用同一个草稿键（最后写入者胜出），所以它是「这个会话的草稿」，
 *   不是「某个标签页的编辑器」。
 * - 键是**已存在会话**的 id。会话还没创建时客户端用的是 `new:${cwd}` /
 *   `new:${intentId}` / `"new"`（`hooks/useAgentSession.ts` 的 draftKey），
 *   而宿主传的是已落盘的会话 id，所以那一段文本这里读不到。
 */
import { statSync } from "node:fs";
import { getPidancePrefsPath, readPidancePrefs } from "./pidance-prefs-file";

/**
 * 偏好文件的字节上限：超过就当作读不到（空串）。
 *
 * 这是插件**同步**调用路径上的一次整文件读，不能对文件大小没有任何上界
 * （`/api/preferences` 只限制单次 patch ≤1MB，文件本身可以长得更大）。
 * 超限降级为空串而不是抛错：这条路必须可预期，而空串与「没有草稿」同义。
 * 本机真实文件 42KB，4MB 约是它的 100 倍。
 */
const COMPOSER_DRAFT_MAX_BYTES = 4 * 1024 * 1024;

/** 从偏好快照里取出某个会话的草稿文本；形状不对就是空串。 */
function draftTextFromPrefs(prefs: Record<string, unknown>, sessionId: string): string {
  const drafts = prefs.drafts;
  if (typeof drafts !== "object" || drafts === null || Array.isArray(drafts)) return "";
  const draft = (drafts as Record<string, unknown>)[sessionId];
  if (typeof draft !== "object" || draft === null || Array.isArray(draft)) return "";
  const value = (draft as Record<string, unknown>).value;
  return typeof value === "string" ? value : "";
}

/**
 * 读会话草稿文本。读不到（没有草稿 / 文件不存在 / 解析失败 / 超过字节上限）一律返回空串 ——
 * 这是插件调用的同步 API，不能因为存储问题抛错。
 */
export function readComposerDraftText(sessionId: string, agentDir?: string): string {
  if (!sessionId) return "";
  try {
    // 先看大小再解析：一份异常大的偏好不该被整份读进内存。文件不存在时 statSync 返回
    // undefined（throwIfNoEntry），与「读不到」同义，不当作错误。
    const stats = statSync(getPidancePrefsPath(agentDir), { throwIfNoEntry: false });
    if (!stats || stats.size > COMPOSER_DRAFT_MAX_BYTES) return "";
    return draftTextFromPrefs(readPidancePrefs(agentDir), sessionId);
  } catch (error) {
    console.error("[pidance] readComposerDraftText failed:", error);
    return "";
  }
}
