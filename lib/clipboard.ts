/**
 * 复制到剪贴板。
 *
 * 优先用 Clipboard API，但**不可用与失败两种情形都要回退**：非安全上下文（局域网 IP、Tailscale
 * 地址这类 `http://` 源）下 `navigator.clipboard` 根本不存在；即使在安全上下文，`writeText` 也会
 * 因为权限策略或文档失焦被拒。以前只在「不存在」时回退，于是「存在但拒绝」的路径静默什么都不做。
 *
 * 回退用隐藏 textarea + `document.execCommand("copy")`，并**检查它的返回值**：返回 false 说明
 * 浏览器没真的复制，这时必须让调用方看到失败（各调用点已经有各自的失败提示）。
 */
export function copyText(text: string): Promise<void> {
  const fallback = (): Promise<void> => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      // 固定在视口外而不是 display:none —— 后者在部分浏览器里选中不到。
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok ? Promise.resolve() : Promise.reject(new Error("document.execCommand(\"copy\") returned false"));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("clipboard unavailable"));
    }
  };

  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard?.writeText) return fallback();
  try {
    return clipboard.writeText(text).catch(fallback);
  } catch (error) {
    // 少数实现同步抛（例如被权限策略拦下）
    return fallback().catch(() => Promise.reject(error));
  }
}
