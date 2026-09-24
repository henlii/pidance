/**
 * 读当前会话输入框（草稿）的文本，供扩展的 `ctx.ui.getEditorText()` 回传。
 *
 * 为什么读偏好文件而不是问客户端（issue #74）：
 * - 浏览器里的输入框是 React 本地状态；扩展调 `getEditorText()` 是**同步**的，
 *   没有可用的往返通道。
 * - 加一条「每次输入都上报」的通道会给普通打字加往返（这个仓库刻意避免的），
 *   只上报焦点那种稀疏事件又不足以回答「现在框里是什么」。
 * - 客户端本来就把草稿镜像到服务端偏好（`/api/preferences`，400ms 防抖，
 *   `lib/draft-store.ts`），草稿键就是会话 id。读这份镜像：**零新增往返**，
 *   代价是一次小文件读（实测 ~0.6ms）。
 *
 * 语义边界（必须知道，不然会把延迟当成 bug）：
 * - 比输入框**滞后**（客户端 400ms 防抖 + 落盘），不是实时值；
 * - 多标签共用同一个草稿键（最后写入者胜出），所以它是「这个会话的草稿」，
 *   不是「某个标签页的编辑器」。
 */
import { readPidancePrefs } from "./pidance-prefs-file";

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
 * 读会话草稿文本。读不到（没有草稿 / 文件不存在 / 解析失败）一律返回空串 ——
 * 这是插件调用的同步 API，不能因为存储问题抛错。
 */
export function readComposerDraftText(sessionId: string, agentDir?: string): string {
  if (!sessionId) return "";
  try {
    return draftTextFromPrefs(readPidancePrefs(agentDir), sessionId);
  } catch (error) {
    console.error("[pidance] readComposerDraftText failed:", error);
    return "";
  }
}
