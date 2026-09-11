const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pidanceDesktop", {
  isDesktop: true,
  getSettings: () => ipcRenderer.invoke("desktop-settings:get"),
  setSetting: (key, value) => ipcRenderer.invoke("desktop-settings:set", key, value),
  notify: (title, body) => ipcRenderer.invoke("desktop-notification:show", title, body),
  onOpenSettings: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("desktop-settings:open", listener);
    return () => ipcRenderer.removeListener("desktop-settings:open", listener);
  },
});
