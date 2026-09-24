/**
 * 工具名谓词：写入类工具与 apply_patch 的唯一判定处。
 *
 * 判定只看**名字形状**，不看调用参数 —— 参数解析由各自的调用方负责
 * （`lib/turn-written-files.ts` 取写入路径，MessageView 取 diff/预览）。
 * 放在 lib 而不是组件里：工具卡渲染与本轮汇总必须用同一套判定，两处各写一份会漂移。
 */

/** `edit` 系：内置 edit，以及扩展常用的 str_replace / replace_editor 变体。 */
export function isEditToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "edit" ||
    name.startsWith("edit_") ||
    name.endsWith(".edit") ||
    name.endsWith("_edit") ||
    name.includes("str_replace") ||
    name.includes("replace_editor");
}

/** `write` 系：内置 write，以及常见的新建文件变体。 */
export function isWriteToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "write" ||
    name.startsWith("write_") ||
    name.endsWith(".write") ||
    name.endsWith("_write") ||
    name.includes("write_file") ||
    name.includes("create_file");
}

/** `apply_patch`（GPT 系补丁工具），带扩展前缀也算。 */
export function isApplyPatchToolName(toolName: string): boolean {
  return toolName.toLowerCase().includes("apply_patch");
}

/**
 * 写入类工具：调用**成功**后其目标文件属于「本轮写入的文件」。
 *
 * 只覆盖真正改文件正文的三个工具；bash 里 `>` 重定向、`sed -i` 等不在此列 ——
 * 从命令文本里猜写入目标不可靠，宁可少列也不列错。
 */
export function isFileWritingToolName(toolName: string): boolean {
  return isEditToolName(toolName) || isWriteToolName(toolName) || isApplyPatchToolName(toolName);
}
