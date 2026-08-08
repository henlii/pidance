/**
 * Pidance session activity → HTML 导出投影。
 *
 * 在 Pi exporter 生成 HTML 后注入；不修改 JSONL、不伪造 custom_message。
 * 仅投影当前导出分支上的合法 pidance.activity。
 */

import {
  isPidanceActivityEntry,
  parseActivityData,
  type SessionActivity,
} from "./session-activity";
import { SessionExportError } from "./session-export";
import { openSessionFile } from "./session-file";

/** 单条可渲染的 activity（已校验）。 */
export type ActivityExportItem = {
  entryId: string;
  timestamp?: string;
  activity: SessionActivity;
};

/** 只读分支源：与 SessionManager.getBranch / getEntry 对齐。 */
export type ActivityExportSource = {
  getEntry(id: string):
    | {
        id: string;
        type?: string;
        customType?: string;
        data?: unknown;
        timestamp?: string;
      }
    | undefined;
  getBranch(fromId?: string): Array<{
    id: string;
    type?: string;
    customType?: string;
    data?: unknown;
    timestamp?: string;
  }>;
};

export type CollectBranchActivitiesOptions = {
  /** 显式 leaf；省略时使用源当前 leaf（getBranch() 无参）。 */
  leafId?: string | null;
};

/**
 * 从分支路径收集合法 pidance.activity，保持 root→leaf 顺序。
 * 非法 / 未知版本 / 其它 customType 跳过。
 */
export function collectBranchActivities(
  source: ActivityExportSource,
  options: CollectBranchActivitiesOptions = {},
): ActivityExportItem[] {
  const rawLeaf = options.leafId;
  const leafId =
    typeof rawLeaf === "string" && rawLeaf.length > 0 ? rawLeaf : undefined;

  if (leafId !== undefined && !source.getEntry(leafId)) {
    throw new SessionExportError(`Invalid leafId: ${leafId}`);
  }

  const branch =
    leafId !== undefined ? source.getBranch(leafId) : source.getBranch();

  const items: ActivityExportItem[] = [];
  for (const entry of branch) {
    if (!isPidanceActivityEntry(entry)) continue;
    const activity = parseActivityData(entry.data);
    if (!activity) continue;
    const item: ActivityExportItem = {
      entryId: entry.id,
      activity,
    };
    if (typeof entry.timestamp === "string" && entry.timestamp.length > 0) {
      item.timestamp = entry.timestamp;
    }
    items.push(item);
  }
  return items;
}

/**
 * 打开会话文件并收集指定 leaf 分支上的 activity（只读，无 AgentSession）。
 */
export function collectSessionFileActivities(
  filePath: string,
  options: CollectBranchActivitiesOptions = {},
): ActivityExportItem[] {
  const sm = openSessionFile(filePath);
  return collectBranchActivities(sm, options);
}

/** HTML 文本转义（title/content/source/requestId/timestamp）。 */
export function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 自包含静态样式；语义色、无运行时 JS。 */
const ACTIVITY_SECTION_STYLES = `
.pidance-activity{margin:1.5rem 0;padding:1rem 1.25rem;border:1px solid #ccc;border-radius:8px;background:#fafafa;color:#222;font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.45}
.pidance-activity h2{margin:0 0 0.75rem;font-size:1.1rem;font-weight:600}
.pidance-activity-card{margin:0.75rem 0;padding:0.75rem 1rem;border:1px solid #ddd;border-radius:6px;background:#fff}
.pidance-activity-card[data-kind="result"]{border-left:4px solid #2e7d32}
.pidance-activity-card[data-kind="warning"]{border-left:4px solid #ed6c02}
.pidance-activity-card[data-kind="error"]{border-left:4px solid #d32f2f}
.pidance-activity-card[data-kind="output"]{border-left:4px solid #1565c0}
.pidance-activity-meta{display:flex;flex-wrap:wrap;gap:0.5rem 1rem;margin:0 0 0.5rem;color:#555;font-size:12px}
.pidance-activity-kind{display:inline-block;padding:0.1rem 0.45rem;border-radius:4px;background:#eee;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;font-size:11px}
.pidance-activity-card h3{margin:0 0 0.5rem;font-size:1rem;font-weight:600;word-break:break-word}
.pidance-activity-content{margin:0;padding:0.5rem 0.65rem;border-radius:4px;background:#f5f5f5;color:#111;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;overflow-x:auto}
`.trim();

/**
 * 渲染 Session activity section HTML（已转义，无 script / 事件属性）。
 * items 为空时返回空串。
 */
export function renderActivitySectionHtml(items: ActivityExportItem[]): string {
  if (items.length === 0) return "";

  const cards = items
    .map((item) => {
      const { activity, entryId, timestamp } = item;
      const kind = escapeHtmlText(activity.kind);
      const title = escapeHtmlText(activity.title);
      const content = escapeHtmlText(activity.content);
      const metaParts: string[] = [
        `<span class="pidance-activity-kind">${kind}</span>`,
      ];
      if (timestamp !== undefined) {
        metaParts.push(
          `<time datetime="${escapeHtmlText(timestamp)}">${escapeHtmlText(timestamp)}</time>`,
        );
      }
      if (activity.source !== undefined) {
        metaParts.push(
          `<span class="pidance-activity-source">source: ${escapeHtmlText(activity.source)}</span>`,
        );
      }
      if (activity.requestId !== undefined) {
        metaParts.push(
          `<span class="pidance-activity-request-id">requestId: ${escapeHtmlText(activity.requestId)}</span>`,
        );
      }

      return [
        `<article class="pidance-activity-card" data-kind="${kind}" data-entry-id="${escapeHtmlText(entryId)}">`,
        `<div class="pidance-activity-meta">${metaParts.join("")}</div>`,
        `<h3>${title}</h3>`,
        `<pre class="pidance-activity-content">${content}</pre>`,
        `</article>`,
      ].join("");
    })
    .join("\n");

  return [
    `<section class="pidance-activity" id="pidance-session-activity" aria-label="Session activity">`,
    `<style>${ACTIVITY_SECTION_STYLES}</style>`,
    `<h2>Session activity</h2>`,
    cards,
    `</section>`,
  ].join("\n");
}

/**
 * 将 section 插入 HTML 的安全位置：优先最后一个 </body> 前；无 body 则追加。
 * sectionHtml 为空时返回原 html（字节不变）。
 */
export function injectActivitySectionHtml(
  html: string,
  sectionHtml: string,
): string {
  if (sectionHtml.length === 0) return html;

  const match = /<\/body\s*>/i.exec(html);
  if (!match || match.index === undefined) {
    return `${html}${sectionHtml}`;
  }

  // 找最后一个 </body>
  let lastIndex = match.index;
  let lastMatch = match[0];
  const re = /<\/body\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    lastIndex = m.index;
    lastMatch = m[0];
  }

  return (
    html.slice(0, lastIndex) +
    sectionHtml +
    "\n" +
    lastMatch +
    html.slice(lastIndex + lastMatch.length)
  );
}

export type ProjectActivitiesIntoExportHtmlOptions =
  CollectBranchActivitiesOptions;

/**
 * 纯函数：在已生成的 Pi HTML 上投影当前分支 activity。
 * 无合法 activity 时返回原 html（字节不变）。
 */
export function projectActivitiesIntoExportHtml(
  html: string,
  source: ActivityExportSource,
  options: ProjectActivitiesIntoExportHtmlOptions = {},
): string {
  const items = collectBranchActivities(source, options);
  const section = renderActivitySectionHtml(items);
  return injectActivitySectionHtml(html, section);
}

/**
 * 从会话文件投影 activity 到 HTML（SessionManager 只读打开）。
 */
export function projectSessionFileActivitiesIntoExportHtml(
  html: string,
  filePath: string,
  options: ProjectActivitiesIntoExportHtmlOptions = {},
): string {
  const sm = openSessionFile(filePath);
  return projectActivitiesIntoExportHtml(html, sm, options);
}
