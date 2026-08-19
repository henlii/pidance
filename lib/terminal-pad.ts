export type TerminalPadItem = {
  id: string;
  label: string;
  send: string;
};

export type TerminalPadConfig = {
  keys: TerminalPadItem[];
  commands: TerminalPadItem[];
};

export const TERMINAL_PAD_STORAGE_KEY = "pidance.terminalPad";

export const DEFAULT_TERMINAL_KEYS: TerminalPadItem[] = [
  { id: "esc", label: "Esc", send: "\\e" },
  { id: "tab", label: "Tab", send: "\\t" },
  { id: "ctrl-c", label: "Ctrl-C", send: "\\x03" },
  { id: "ctrl-d", label: "Ctrl-D", send: "\\x04" },
  { id: "ctrl-z", label: "Ctrl-Z", send: "\\x1a" },
  { id: "ctrl-l", label: "Ctrl-L", send: "\\x0c" },
  { id: "up", label: "↑", send: "\\e[A" },
  { id: "down", label: "↓", send: "\\e[B" },
  { id: "right", label: "→", send: "\\e[C" },
  { id: "left", label: "←", send: "\\e[D" },
  { id: "home", label: "Home", send: "\\e[H" },
  { id: "end", label: "End", send: "\\e[F" },
];

export function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*\u0007/g, "")
    .replace(/\r(?!\n)/g, "\n");
}

export function expandTerminalSend(raw: string): string {
  return raw.replace(/\\e/g, "\u001b")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\x([0-9a-fA-F]{2})/g, (_all, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function isItem(value: unknown): value is TerminalPadItem {
  if (!value || typeof value !== "object") return false;
  const item = value as TerminalPadItem;
  return typeof item.id === "string" && item.id.length > 0
    && typeof item.label === "string"
    && typeof item.send === "string";
}

export function parseTerminalPadConfig(raw: unknown): TerminalPadConfig {
  if (!raw || typeof raw !== "object") {
    return { keys: DEFAULT_TERMINAL_KEYS.map((item) => ({ ...item })), commands: [] };
  }
  const rec = raw as { keys?: unknown; commands?: unknown };
  const keys = Array.isArray(rec.keys) ? rec.keys.filter(isItem) : [];
  const commands = Array.isArray(rec.commands) ? rec.commands.filter(isItem) : [];
  return {
    keys: keys.length > 0 ? keys : DEFAULT_TERMINAL_KEYS.map((item) => ({ ...item })),
    commands,
  };
}

export function loadTerminalPadConfig(): TerminalPadConfig {
  if (typeof localStorage === "undefined") {
    return { keys: DEFAULT_TERMINAL_KEYS.map((item) => ({ ...item })), commands: [] };
  }
  try {
    const raw = localStorage.getItem(TERMINAL_PAD_STORAGE_KEY);
    return parseTerminalPadConfig(raw ? JSON.parse(raw) : null);
  } catch {
    return { keys: DEFAULT_TERMINAL_KEYS.map((item) => ({ ...item })), commands: [] };
  }
}

export function saveTerminalPadConfig(config: TerminalPadConfig): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(TERMINAL_PAD_STORAGE_KEY, JSON.stringify(config));
}

export function newPadItem(prefix: string): TerminalPadItem {
  const id = `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, label: "", send: "" };
}

export type TerminalKeyMods = { ctrl: boolean; alt: boolean; shift: boolean };

export type VirtualKey =
  | { kind: "char"; label: string; ch: string }
  | { kind: "special"; label: string; send: string; shiftSend?: string };

export const VIRTUAL_SPECIAL_KEYS: VirtualKey[] = [
  { kind: "special", label: "Esc", send: "\\e" },
  { kind: "special", label: "Tab", send: "\\t", shiftSend: "\\e[Z" },
  { kind: "special", label: "Enter", send: "\\r" },
  { kind: "special", label: "Bksp", send: "\\x7f" },
  { kind: "special", label: "Space", send: " " },
  { kind: "special", label: "↑", send: "\\e[A" },
  { kind: "special", label: "↓", send: "\\e[B" },
  { kind: "special", label: "→", send: "\\e[C" },
  { kind: "special", label: "←", send: "\\e[D" },
  { kind: "special", label: "Home", send: "\\e[H" },
  { kind: "special", label: "End", send: "\\e[F" },
];

export const VIRTUAL_CHAR_ROWS: string[] = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"];

function hexByte(code: number): string {
  return `\\x${code.toString(16).padStart(2, "0")}`;
}

export function comboLabel(mods: TerminalKeyMods, keyLabel: string): string {
  const parts: string[] = [];
  if (mods.ctrl) parts.push("Ctrl");
  if (mods.alt) parts.push("Alt");
  if (mods.shift) parts.push("Shift");
  parts.push(keyLabel);
  return parts.join("-");
}

export function comboToPadItem(mods: TerminalKeyMods, key: VirtualKey): TerminalPadItem {
  const id = `key-${Math.random().toString(36).slice(2, 10)}`;
  if (key.kind === "char") {
    const letter = mods.shift ? key.ch.toUpperCase() : key.ch.toLowerCase();
    const shown = key.ch.toUpperCase();
    if (mods.ctrl) {
      const code = shown.charCodeAt(0) - 64;
      const send = mods.alt ? `\\e${hexByte(code)}` : hexByte(code);
      return { id, label: comboLabel(mods, shown), send };
    }
    if (mods.alt) return { id, label: comboLabel(mods, shown), send: `\\e${letter}` };
    return { id, label: comboLabel(mods, shown), send: letter };
  }
  const send = mods.shift && key.shiftSend ? key.shiftSend : key.send;
  const label = comboLabel({
    ctrl: mods.ctrl,
    alt: mods.alt,
    shift: Boolean(mods.shift && key.shiftSend),
  }, key.label);
  if (mods.alt && send !== "\\e") return { id, label: comboLabel(mods, key.label), send: `\\e${send}` };
  return { id, label, send };
}
