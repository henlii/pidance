export type DesktopSettingKey = "openAtLogin" | "minimizeToTray" | "notificationsEnabled";

export type DesktopSettings = {
  openAtLogin: boolean;
  minimizeToTray: boolean;
  notificationsEnabled: boolean;
};

export type DesktopBridge = {
  readonly isDesktop: true;
  getSettings(): Promise<DesktopSettings>;
  setSetting(key: DesktopSettingKey, value: boolean): Promise<DesktopSettings>;
  notify(title: string, body: string): Promise<boolean>;
  onOpenSettings(callback: () => void): () => void;
};

declare global {
  interface Window {
    pidanceDesktop?: DesktopBridge;
  }
}

export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  return window.pidanceDesktop ?? null;
}
