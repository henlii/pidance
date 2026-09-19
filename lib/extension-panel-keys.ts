/**
 * Custom extension panels still speak the TUI key protocol, but GUI copy/select
 * must not be swallowed. Ctrl/Cmd+A always stays with the browser; Ctrl/Cmd+C
 * stays with the browser when there is a text selection (otherwise it remains
 * the TUI interrupt, usually Close).
 */
export function shouldCaptureCustomPanelKey(
  event: { key: string; ctrlKey: boolean; metaKey: boolean },
  selectedText: string,
): boolean {
  const key = event.key.toLowerCase();
  const chord = event.ctrlKey || event.metaKey;
  if (!chord) return true;
  if (key === "a") return false;
  if (key === "c" && selectedText.length > 0) return false;
  return true;
}
