"use strict";

// Pidance 自管 HTTP server：持有 TCP，把普通请求交给 Next，/api/pty upgrade 进 PTY。
// 正式入口是 bin/pidance.js。

// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require("http");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const next = require("next");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { installResponseCompression } = require("./pidance-compression");

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
    // 对端地址是我们唯一可信的客户端身份来源：先删掉客户端自带的同名头，
    // 再写入 socket 地址。限流分桶读它（middleware 里读不到 socket）。
    if (req.headers) {
      delete req.headers["x-pidance-peer-ip"];
      const address = req.socket?.remoteAddress;
      if (address) req.headers["x-pidance-peer-ip"] = address;
    }
    // Next 的 compress 只在它自己的内置服务器（router-server）里生效；
    // 自管 server 必须自己压缩，否则 JSON/HTML 明文下发。
    // 见 bin/pidance-compression.js。
    installResponseCompression(req, res);
    void handle(req, res);
    // 见下方 installUpgradeHandler 注释：Next 在首个请求里给同一个 server 挂了自己的
    // upgrade 监听器（这一步在 handle() 内部同步发生），要在它挂完之后再清一次。
    installUpgradeHandler();
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
  // Node 的 upgrade 事件会依次调用**所有**监听器，而 Next 会在它处理的第一个请求里
  // 给同一个 server 再挂一个（next/dist/server/next.js 的 setupWebSocketHandler）：
  // /api/pty 升级握手完成后，Next 的处理器还会走到它自己的路由判定，并可能
  // socket.end()，浏览器侧就是「终端刚连上就断」（WebSocket 1006）。
  // Next 的挂载只发生一次，且我们的 Next 一直是 dev:false（用不到它那个 upgrade 分支），
  // 所以清掉即可：每个请求前后各清一次，请求后那次清的就是 Next 刚挂上的那个；
  // 平时就只剩我们自己的处理器。
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
