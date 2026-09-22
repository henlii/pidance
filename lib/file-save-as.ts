/**
 * 「另存为」客户端：把源文件复制到用户选定的目录（服务端落盘，原文件保留）。
 *
 * 与浏览器下载的分工：下载走浏览器自己的下载目录（web 缓存），这条走服务端拷贝 ——
 * 因为要落到的目录是 Web 端看不见的服务端路径，且要保证原文件留在原位。
 */

export type SaveAsResult =
  | { ok: true; path: string; name: string }
  | { ok: false; message: string };

/** 非 2xx 时尽量取出服务端给的原因（403 越权 / 404 找不到 / 409 冲突）。 */
function errorMessageFrom(status: number, payload: unknown): string {
  const serverError = (payload as { error?: unknown } | null)?.error;
  if (typeof serverError === "string" && serverError.trim()) return serverError;
  if (status === 403) return "Access denied";
  if (status === 404) return "Not found";
  if (status === 409) return "Already exists";
  return `HTTP ${status}`;
}

export async function saveFileAs(input: {
  path: string;
  targetDirectory: string;
  fetchImpl?: typeof fetch;
}): Promise<SaveAsResult> {
  const caller = input.fetchImpl ?? fetch;
  try {
    const response = await caller("/api/files/save-as", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: input.path, targetDirectory: input.targetDirectory }),
    });
    const payload = await response.json().catch(() => null) as { path?: unknown; name?: unknown } | null;
    if (!response.ok) {
      return { ok: false, message: errorMessageFrom(response.status, payload) };
    }
    const savedPath = typeof payload?.path === "string" ? payload.path : "";
    if (!savedPath) return { ok: false, message: "Save failed" };
    return {
      ok: true,
      path: savedPath,
      name: typeof payload?.name === "string" ? payload.name : savedPath.split("/").pop() ?? savedPath,
    };
  } catch {
    return { ok: false, message: "Save failed" };
  }
}
