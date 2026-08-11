import { basename } from "path";
import { CURRENT_SESSION_VERSION, openSessionView } from "./pi-session-io";

/** 与 AgentSession.exportToJsonl 对齐的分支导出错误。 */
export class SessionExportError extends Error {
  readonly code: "bad-request";

  constructor(message: string) {
    super(message);
    this.name = "SessionExportError";
    this.code = "bad-request";
  }
}

export type ExportFormat = "html" | "jsonl";

/**
 * 解析导出 format 查询参数。
 * 省略或空串 → html（默认）；jsonl → jsonl；其它 → null（未知）。
 */
export function parseExportFormat(raw: string | null): ExportFormat | null {
  if (raw === null || raw === "") return "html";
  if (raw === "jsonl") return "jsonl";
  return null;
}

/** 只读会话源：便于 fixture / 假实现测试，不绑定 AgentSession。 */
export type SessionBranchExportSource = {
  getSessionId(): string;
  getCwd(): string;
  getEntry(id: string): { id: string } | undefined;
  /** 返回 root→leaf 路径上的 entry（浅拷贝后可安全改 parentId）。 */
  getBranch(fromId?: string): Array<{ id: string } & object>;
};

export type BuildSessionBranchJsonlOptions = {
  /** 显式 leaf；省略时使用 SessionManager 当前 leaf（getBranch() 无参）。 */
  leafId?: string | null;
  /** 可注入时钟，便于确定性测试。 */
  now?: () => Date;
};

/**
 * 复刻 0.81.1 AgentSession.exportToJsonl 的序列化：
 * header + getBranch 全量 entry，parentId 从 null 起线性重链，末尾换行。
 * 不做 context 裁剪，不写盘。
 */
export function buildSessionBranchJsonl(
  source: SessionBranchExportSource,
  options: BuildSessionBranchJsonlOptions = {},
): string {
  const rawLeaf = options.leafId;
  const leafId =
    typeof rawLeaf === "string" && rawLeaf.length > 0 ? rawLeaf : undefined;

  if (leafId !== undefined && !source.getEntry(leafId)) {
    throw new SessionExportError(`Invalid leafId: ${leafId}`);
  }

  const branchEntries =
    leafId !== undefined ? source.getBranch(leafId) : source.getBranch();

  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: source.getSessionId(),
    timestamp,
    cwd: source.getCwd(),
  };

  const lines: string[] = [JSON.stringify(header)];
  let prevId: string | null = null;
  for (const entry of branchEntries) {
    const linear = { ...entry, parentId: prevId };
    lines.push(JSON.stringify(linear));
    prevId = entry.id;
  }
  return `${lines.join("\n")}\n`;
}

/**
 * 打开会话文件并导出指定 leaf 的当前分支 JSONL（只读，无 AgentSession）。
 */
export function exportSessionFileToJsonl(
  filePath: string,
  options: BuildSessionBranchJsonlOptions = {},
): string {
  const sm = openSessionView(filePath);
  return buildSessionBranchJsonl(sm, options);
}

/** attachment 安全文件名：与 HTML 导出口径一致。 */
export function getExportJsonlFileName(sessionFilePath: string): string {
  const sessionBase = basename(sessionFilePath, ".jsonl");
  return `pi-session-${sessionBase}.jsonl`;
}

export const JSONL_EXPORT_CONTENT_TYPE =
  "application/x-ndjson; charset=utf-8";
