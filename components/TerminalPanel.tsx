"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Settings2, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useTheme } from "@/hooks/useTheme";
import { ViewportDialog } from "./ui/ViewportDialog";
import {
  DEFAULT_TERMINAL_KEYS,
  VIRTUAL_CHAR_ROWS,
  VIRTUAL_SPECIAL_KEYS,
  comboToPadItem,
  expandTerminalSend,
  loadTerminalPadConfig,
  newPadItem,
  saveTerminalPadConfig,
  type TerminalKeyMods,
  type TerminalPadConfig,
  type TerminalPadItem,
  type VirtualKey,
} from "@/lib/terminal-pad";

type PtyStatus = "idle" | "connecting" | "open" | "closed" | "error";

export function TerminalPanel() {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const { isDark } = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sendRef = useRef<(data: string) => boolean>(() => false);
  const [status, setStatus] = useState<PtyStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [pad, setPad] = useState<TerminalPadConfig>(() => loadTerminalPadConfig());
  const [configOpen, setConfigOpen] = useState(false);
  const [kbInset, setKbInset] = useState(0);
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [commandDraft, setCommandDraft] = useState("");
  const composingRef = useRef(false);

  const send = useCallback((data: string) => {
    sendRef.current(data);
    setLastSent(
      data === "\r"
        ? "Enter"
        : data.length === 1 && data.charCodeAt(0) < 32
          ? `^${String.fromCharCode(64 + data.charCodeAt(0))}`
          : data.slice(0, 24),
    );
  }, []);

  const submitCommand = useCallback(() => {
    if (commandDraft) send(commandDraft);
    send("\r");
    setCommandDraft("");
  }, [commandDraft, send]);

  const onCommandKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || composingRef.current) return;
    if (event.key === "Enter") {
      event.preventDefault();
      submitCommand();
    }
  }, [submitCommand]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport || !isMobile) {
      setKbInset(0);
      return;
    }
    const update = () => {
      setKbInset(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop));
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [isMobile]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let closed = false;
    let socket: WebSocket | null = null;
    let retryTimer: number | null = null;
    const queue: string[] = [];

    // 防止 StrictMode 二次挂载在同一个容器里留下多个 xterm 实例。
    container.innerHTML = "";

    const term = new Terminal({
      allowProposedApi: true,
      allowTransparency: true,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: "var(--font-mono)",
      fontSize: 13,
      lineHeight: 1.4,
      scrollback: 8000,
      convertEol: false,
      macOptionIsMeta: true,
      theme: {
        background: "transparent",
        foreground: "#fff",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    try {
      fit.fit();
    } catch {
      // 面板尚未可见时忽略，后续 ResizeObserver 会再 fit。
    }
    termRef.current = term;
    fitRef.current = fit;

    // 手机端/输入法：xterm 自带的隐藏 textarea 是键盘输入入口。
    // 这里显式关掉自动纠错/大写，并放大字号避免 iOS 聚焦时自动缩放页面。
    const textarea = term.textarea;
    if (textarea) {
      textarea.setAttribute("autocapitalize", "off");
      textarea.setAttribute("autocorrect", "off");
      textarea.setAttribute("autocomplete", "off");
      textarea.setAttribute("spellcheck", "false");
      textarea.setAttribute("inputmode", "text");
      textarea.setAttribute("enterkeyhint", "send");
      textarea.style.fontSize = "16px";
    }

    const flush = () => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      while (queue.length > 0) {
        const data = queue.shift();
        if (data) socket.send(JSON.stringify({ type: "in", d: data }));
      }
    };

    const sendData = (data: string) => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "in", d: data }));
        return true;
      }
      queue.push(data);
      if (!socket || socket.readyState === WebSocket.CLOSED) connect();
      return true;
    };
    sendRef.current = sendData;

    const onDataDisposable = term.onData((data) => {
      sendData(data);
    });
    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "rs", cols, rows }));
      }
    });

    const fitNow = () => {
      try {
        fit.fit();
      } catch {
        // 面板隐藏时无尺寸，等待下一次 resize。
      }
    };
    const resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(fitNow);
    });
    resizeObserver.observe(container);

    const connect = () => {
      if (closed) return;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      setStatus("connecting");
      setError(null);
      const ws = new WebSocket(`${proto}//${window.location.host}/api/pty`);
      socket = ws;
      ws.onopen = () => {
        if (closed || socket !== ws) return;
        setStatus("open");
        ws.send(JSON.stringify({ type: "rs", cols: term.cols, rows: term.rows }));
        flush();
      };
      ws.onmessage = (event) => {
        void Promise.resolve(event.data)
          .then((raw) => {
            if (typeof raw !== "string") {
              if (raw instanceof Blob) return raw.text();
              if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
              return "";
            }
            return raw;
          })
          .then((text) => {
            if (closed || socket !== ws || !text) return;
            try {
              const parsed = JSON.parse(text) as { type?: string; message?: string; code?: number; d?: string };
              if (parsed && typeof parsed.type === "string") {
                if (parsed.type === "error" && parsed.message) {
                  setError(parsed.message);
                  setStatus("error");
                  return;
                }
                if (parsed.type === "exit") {
                  setStatus("closed");
                  return;
                }
                if (parsed.type === "out" && typeof parsed.d === "string") {
                  term.write(parsed.d);
                  return;
                }
              }
            } catch {
              // 不是 JSON 时按普通终端输出处理（兼容旧协议）。
            }
            term.write(text);
          });
      };
      ws.onclose = () => {
        if (closed || socket !== ws) return;
        setStatus("connecting");
        retryTimer = window.setTimeout(connect, 600);
      };
    };
    connect();

    return () => {
      closed = true;
      sendRef.current = () => false;
      onDataDisposable.dispose();
      onResizeDisposable.dispose();
      resizeObserver.disconnect();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      socket?.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // 让 xterm 跟随当前主题的 CSS 变量（主 effect 创建终端后再执行）。
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const styles = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    term.options.theme = {
      background: read("--bg", isDark ? "#101719" : "#fbfcfd"),
      foreground: read("--text", isDark ? "#ced8d8" : "#263439"),
      cursor: read("--accent", isDark ? "#69a7ca" : "#286e98"),
      cursorAccent: read("--bg", isDark ? "#101719" : "#fbfcfd"),
      selectionBackground: read("--bg-selected", isDark ? "#6ba7c426" : "#2e6f9520"),
    };
  }, [isDark]);

  // 移动端切换时只调字号，不重建终端/不断开 PTY。
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = isMobile ? 14 : 13;
    try {
      fitRef.current?.fit();
    } catch {
      // 面板隐藏时忽略。
    }
  }, [isMobile]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, paddingBottom: kbInset }}>
      <div style={{ padding: "4px 10px", fontSize: 11, color: "var(--text-dim)", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        {status === "connecting" && t("terminal_connecting")}
        {status === "open" && t("terminal_connected")}
        {status === "closed" && t("terminal_disconnected")}
        {status === "error" && (error ?? t("terminal_unavailable"))}
        {lastSent && status === "open" && <span style={{ marginLeft: 8 }}>· {t("terminal_sent", { value: lastSent })}</span>}
      </div>
      <div
        className="pidance-terminal-surface"
        style={{ flex: 1, minHeight: 80, position: "relative", overflow: "hidden" }}
      >
        <div
          ref={containerRef}
          className="pidance-terminal-xterm"
          style={{ position: "absolute", inset: 0, padding: "6px 8px 8px" }}
        />
      </div>
      {isMobile && (
        <div style={{ flexShrink: 0, borderTop: "1px solid var(--border)", background: "var(--bg)", padding: "6px 8px", display: "flex", gap: 6 }}>
          <input
            value={commandDraft}
            onChange={(event) => setCommandDraft(event.target.value)}
            onKeyDown={onCommandKeyDown}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            placeholder={t("terminal_inputPlaceholder")}
            enterKeyHint="send"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            aria-label={t("workspace_terminal")}
            style={{
              flex: 1,
              minWidth: 0,
              height: 40,
              fontSize: 16,
              padding: "0 10px",
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--bg-panel)",
              color: "var(--text)",
            }}
          />
          <button
            type="button"
            onClick={submitCommand}
            style={{ ...actionBtnStyle, height: 40, minWidth: 56, fontSize: 14, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
          >
            {t("terminal_sendEnter")}
          </button>
        </div>
      )}
      <TerminalChrome
        pad={pad}
        onSend={send}
        onOpenConfig={() => setConfigOpen(true)}
        isMobile={isMobile}
      />
      {configOpen && (
        <TerminalPadEditor
          value={pad}
          isMobile={isMobile}
          onClose={() => setConfigOpen(false)}
          onSave={(next) => {
            setPad(next);
            saveTerminalPadConfig(next);
            setConfigOpen(false);
          }}
        />
      )}
    </div>
  );
}

function TerminalChrome({
  pad,
  onSend,
  onOpenConfig,
  isMobile,
}: {
  pad: TerminalPadConfig;
  onSend: (data: string) => void;
  onOpenConfig: () => void;
  isMobile: boolean;
}) {
  const { t } = useI18n();
  const chip: CSSProperties = {
    flex: "0 0 auto",
    height: isMobile ? 36 : 30,
    minWidth: isMobile ? 38 : undefined,
    padding: isMobile ? "0 12px" : "0 10px",
    border: "1px solid var(--border)",
    borderRadius: 6,
    background: "var(--bg-panel)",
    color: "var(--text)",
    fontSize: isMobile ? 13 : 12,
    whiteSpace: "nowrap",
  };

  return (
    <div style={{ flexShrink: 0, borderTop: "1px solid var(--border)", background: "var(--bg)" }}>
      {pad.commands.length > 0 && (
        <div style={{ display: "flex", gap: 6, overflowX: "auto", padding: "6px 8px 2px", WebkitOverflowScrolling: "touch" }}>
          {pad.commands.map((item) => (
            <button key={item.id} type="button" onPointerUp={(event) => { event.preventDefault(); onSend(expandTerminalSend(item.send)); }} style={{ ...chip, touchAction: "manipulation", cursor: "pointer" }}>
              {item.label || item.send}
            </button>
          ))}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 6, overflowX: "auto", padding: "6px 8px", WebkitOverflowScrolling: "touch" }}>
        <button
          type="button"
          onClick={onOpenConfig}
          aria-label={t("terminal_configure")}
          title={t("terminal_configure")}
          style={{
            flex: "0 0 auto",
            width: isMobile ? 36 : 30,
            height: isMobile ? 36 : 30,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
            touchAction: "manipulation",
          }}
        >
          <Settings2 size={isMobile ? 17 : 15} />
        </button>
        {pad.keys.map((item) => (
          <button key={item.id} type="button" onPointerUp={(event) => { event.preventDefault(); onSend(expandTerminalSend(item.send)); }} style={{ ...chip, touchAction: "manipulation", cursor: "pointer" }}>
            {item.label || item.send}
          </button>
        ))}
      </div>
    </div>
  );
}

function TerminalPadEditor({
  value,
  isMobile,
  onClose,
  onSave,
}: {
  value: TerminalPadConfig;
  isMobile: boolean;
  onClose: () => void;
  onSave: (next: TerminalPadConfig) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<TerminalPadConfig>(() => ({
    keys: value.keys.map((item) => ({ ...item })),
    commands: value.commands.map((item) => ({ ...item })),
  }));
  const [comboMode, setComboMode] = useState(true);
  const [mods, setMods] = useState<TerminalKeyMods>({ ctrl: false, alt: false, shift: false });
  const [commandDraft, setCommandDraft] = useState("");

  const addKey = (key: VirtualKey) => {
    setDraft((prev) => ({ ...prev, keys: [...prev.keys, comboToPadItem(mods, key)] }));
  };

  const addCommand = () => {
    const text = commandDraft.trim();
    if (!text) return;
    const item = newPadItem("cmd");
    item.label = text;
    item.send = text.endsWith("\\n") || text.endsWith("\\r") ? text : `${text}\\n`;
    setDraft((prev) => ({ ...prev, commands: [...prev.commands, item] }));
    setCommandDraft("");
  };

  return (
    <ViewportDialog open onClose={onClose} title={t("terminal_configure")} width={440} closeLabel={t("dialog_close")}>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 12 }}>
        <input type="checkbox" checked={comboMode} onChange={(event) => setComboMode(event.target.checked)} />
        {t("terminal_comboMode")}
      </label>
      {comboMode ? (
      <>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        {(["ctrl", "alt", "shift"] as const).map((name) => (
          <label key={name} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={mods[name]}
              onChange={(event) => setMods((prev) => ({ ...prev, [name]: event.target.checked }))}
            />
            {name === "ctrl" ? "Ctrl" : name === "alt" ? "Alt" : "Shift"}
          </label>
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
        {VIRTUAL_SPECIAL_KEYS.map((key) => (
          <KeyCap key={key.label} label={key.label} onClick={() => addKey(key)} isMobile={isMobile} />
        ))}
      </div>
      {VIRTUAL_CHAR_ROWS.map((row) => (
        <div key={row} style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 4 }}>
          {[...row].map((ch) => (
            <KeyCap
              key={ch}
              label={mods.shift ? ch.toUpperCase() : ch}
              onClick={() => addKey({ kind: "char", label: ch, ch })}
              isMobile={isMobile}
            />
          ))}
        </div>
      ))}
      <PadChipList
        items={draft.keys}
        onRemove={(id) => setDraft((prev) => ({ ...prev, keys: prev.keys.filter((item) => item.id !== id) }))}
      />
      </>
      ) : (
      <>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{t("terminal_commands")}</div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          addCommand();
        }}
        style={{ display: "flex", gap: 6, marginBottom: 8 }}
      >
        <input
          value={commandDraft}
          onChange={(event) => setCommandDraft(event.target.value)}
          placeholder={t("terminal_commandPlaceholder")}
          style={{
            flex: 1,
            minWidth: 0,
            height: isMobile ? 40 : 32,
            fontSize: 16,
            padding: "0 8px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-panel)",
            color: "var(--text)",
          }}
        />
        <button type="submit" style={actionBtnStyle}>{t("terminal_addCommand")}</button>
      </form>
      <PadChipList
        items={draft.commands}
        onRemove={(id) => setDraft((prev) => ({ ...prev, commands: prev.commands.filter((item) => item.id !== id) }))}
      />
      </>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <button type="button" onClick={() => onSave(draft)} style={{ ...actionBtnStyle, border: "1px solid var(--accent)", background: "var(--accent)", color: "var(--accent-foreground)", fontWeight: 600 }}>
          {t("terminal_saveConfig")}
        </button>
        <button
          type="button"
          onClick={() => setDraft((prev) => ({ ...prev, keys: DEFAULT_TERMINAL_KEYS.map((item) => ({ ...item })) }))}
          style={actionBtnStyle}
        >
          {t("terminal_resetKeys")}
        </button>
      </div>
    </ViewportDialog>
  );
}

function KeyCap({ label, onClick, isMobile }: { label: string; onClick: () => void; isMobile: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        minWidth: isMobile ? 36 : 28,
        height: isMobile ? 38 : 32,
        padding: "0 8px",
        border: "1px solid var(--border)",
        borderRadius: 6,
        background: "var(--bg-panel)",
        color: "var(--text)",
        fontSize: isMobile ? 13 : 12,
        touchAction: "manipulation",
      }}
    >
      {label}
    </button>
  );
}

function PadChipList({ items, onRemove }: { items: TerminalPadItem[]; onRemove: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
      {items.map((item) => (
        <span key={item.id} style={{ display: "inline-flex", alignItems: "center", gap: 4, height: 28, padding: "0 6px 0 8px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }}>
          {item.label || item.send}
          <button type="button" onClick={() => onRemove(item.id)} aria-label="remove" style={{ border: "none", background: "none", color: "var(--text-muted)", display: "flex" }}>
            <Trash2 size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}

const actionBtnStyle: CSSProperties = {
  minHeight: 32,
  padding: "0 12px",
  borderRadius: 7,
  border: "1px solid var(--border)",
  background: "var(--bg-panel)",
  color: "var(--text-muted)",
  fontSize: 12,
};
