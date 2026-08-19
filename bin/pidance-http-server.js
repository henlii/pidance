"use strict";

// Pidance 自管 HTTP server：持有 TCP，把普通请求交给 Next，/api/pty upgrade 进 PTY。
// 正式入口是 bin/pidance.js。

// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require("http");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const next = require("next");

function loadPtyUpgrade() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require("./pty-ws.js");
    if (typeof loaded.handlePtyUpgrade === "function") return loaded.handlePtyUpgrade;
  } catch (error) {
    console.warn("[pidance] PTY upgrade 未加载：", error instanceof Error ? error.message : error);
  }
  return null;
}

let defaultPtyUpgrade;
function getDefaultPtyUpgrade() {
  if (defaultPtyUpgrade === undefined) defaultPtyUpgrade = loadPtyUpgrade();
  return defaultPtyUpgrade;
}

/**
 * @param {{
 *   dir: string,
 *   hostname?: string | null,
 *   port: number,
 *   createNext?: typeof next,
 *   createHttpServer?: typeof http.createServer,
 *   onUpgrade?: (req: import("http").IncomingMessage, socket: import("net").Socket, head: Buffer) => void,
 * }} options
 */
async function startPidanceHttpServer(options) {
  const {
    dir,
    hostname,
    port,
    createNext = next,
    createHttpServer = http.createServer,
    onUpgrade,
  } = options;
  if (!dir) throw new Error("startPidanceHttpServer: dir 必填");
  if (!Number.isInteger(port) || port < 0) throw new Error("startPidanceHttpServer: port 无效");

  // 不把 port/hostname 传给 next()：Next 16 会自己 listen，upgrade 就到不了我们的 server。
  const app = createNext({
    dev: false,
    dir,
  });
  await app.prepare();
  const handle = app.getRequestHandler();
  const server = createHttpServer((req, res) => {
    installUpgradeHandler();
    void handle(req, res);
  });

  function onHttpUpgrade(req, socket, head) {
    const upgrade = onUpgrade === undefined ? getDefaultPtyUpgrade() : onUpgrade;
    const url = req.url || "";
    if (url.startsWith("/api/pty") && typeof upgrade === "function") {
      void Promise.resolve(upgrade(req, socket, head)).catch((error) => {
        console.warn("[pidance] PTY upgrade 异常", error instanceof Error ? error.message : error);
        try { socket.destroy(); } catch { /* 已断开 */ }
      });
      return;
    }
    socket.destroy();
  }
  function installUpgradeHandler() {
    server.removeAllListeners("upgrade");
    server.on("upgrade", onHttpUpgrade);
  }
  installUpgradeHandler();

  const listenHost = hostname || undefined;
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, listenHost, () => {
      server.off("error", onError);
      resolve();
    });
  });

  return { server, app };
}

function destroyUpgrade(req, socket) {
  try {
    socket.destroy();
  } catch {
    /* 已断开 */
  }
}

module.exports = { startPidanceHttpServer, destroyUpgrade };
