/**
 * 工具原始输出（partialResult / result）到展示文本的唯一投影。
 *
 * **宿主和客户端必须共用这一份**：宿主拿它算增量帧（只发新增那段），客户端拿它把增量接回
 * 正文 —— 两边算出来的字符串只要差一个字符，增量帧就会被客户端的 from 校验丢掉，实时输出
 * 会一直停在上一帧。所以它既不能各写一份，也不能在中间再加工（比如再 strip 一次）。
 *
 * 投影规则：
 * - 字符串原样保留（\r 去掉，保留真实换行）；
 * - AgentToolResult 形 `{ content: [{ type: "text", text }] }` 提取 text 拼接
 *   （bash / advisor 的实时 update 都是这个形状；切勿 JSON.stringify，否则真实换行会变成
 *   字面量 \n）；
 * - 其它对象/数组 JSON 序列化；序列化失败（循环引用）降级 String()，绝不抛错。
 */
export function partialResultToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.replace(/\r/g, "");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      const texts: string[] = [];
      for (const block of record.content) {
        if (typeof block === "string") {
          texts.push(block.replace(/\r/g, ""));
          continue;
        }
        if (typeof block !== "object" || block === null) continue;
        const item = block as Record<string, unknown>;
        if (item.type === "text" && typeof item.text === "string") {
          texts.push(item.text.replace(/\r/g, ""));
        }
      }
      // 有 text 块或 content 为空数组时都走文本路径，避免回落成 "{}" / "[]"。
      if (texts.length > 0 || record.content.length === 0) {
        return texts.join("\n");
      }
    }
    if (typeof record.text === "string") return record.text.replace(/\r/g, "");
  }
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    // 循环引用等无法序列化的场景：降级为 String()，绝不抛错。
    return String(value);
  }
}
