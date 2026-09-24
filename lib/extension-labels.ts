/**
 * 扩展提供的机器标识（widget key / customType / 工具名）→ 可读标题。
 *
 * **通用规则**：所有插件共用，不为个别插件写特例（AGENTS.md「产品原则」第 3 条）。
 * 插件给的标识是 kebab/snake 形式（`subagent-async`、`subagent-notify`），直接显示
 * 对用户没有意义；美化后仍然看得出原标识，可搜索、可对应。
 *
 * 想要更好的名字时，正确做法是插件在自己的内容里给出（或上游给 API 加显示名字段），
 * 而不是由宿主为某个插件硬编码 —— 那对生态里其它插件不公平，也会随插件改名失效。
 */
export function humanizeExtensionIdentifier(identifier: string): string {
  const words = identifier.split(/[-_./]+/).filter(Boolean);
  if (words.length === 0) return identifier;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}
