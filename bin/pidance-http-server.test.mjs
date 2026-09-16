import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { startPidanceHttpServer } from "./pidance-http-server.js";

function mockNext() {
  return {
    prepare: async () => {},
    getRequestHandler: () => (req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.end("pidance-http-ok");
    },
  };
}

async function listenEphemeral() {
  const upgrades = [];
  const started = await startPidanceHttpServer({
    dir: "/tmp/pidance-http-test",
    hostname: "127.0.0.1",
    port: 0,
    createNext: mockNext,
    onUpgrade: (req, socket) => {
      upgrades.push(req.url);
      socket.destroy();
    },
  });
  const address = started.server.address();
  assert.ok(address && typeof address === "object");
  return { ...started, port: address.port, upgrades };
}

test("自管 server 把普通 HTTP 交给 Next handler", async () => {
  const { server, port } = await listenEphemeral();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "pidance-http-ok");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("upgrade 交给 onUpgrade，默认路径会关掉 socket", async () => {
  const { server, port, upgrades } = await listenEphemeral();
  try {
    await new Promise((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port }, () => {
        socket.write(
          "GET /api/pty HTTP/1.1\r\n" +
            "Host: 127.0.0.1\r\n" +
            "Connection: Upgrade\r\n" +
            "Upgrade: websocket\r\n" +
            "Sec-WebSocket-Version: 13\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
            "\r\n",
        );
      });
      socket.on("close", resolve);
      socket.on("error", reject);
      setTimeout(() => reject(new Error("upgrade socket 未关闭")), 2000);
    });
    assert.deepEqual(upgrades, ["/api/pty"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("未注入 onUpgrade 时非 /api/pty 的 upgrade 被拒绝并关闭", async () => {
  const started = await startPidanceHttpServer({
    dir: "/tmp/pidance-http-test",
    hostname: "127.0.0.1",
    port: 0,
    createNext: mockNext,
    onUpgrade: null,
  });
  const address = started.server.address();
  assert.ok(address && typeof address === "object");
  try {
    await new Promise((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: address.port }, () => {
        socket.write(
          "GET /x HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
      });
      socket.on("close", resolve);
      socket.on("error", reject);
      setTimeout(() => reject(new Error("默认 upgrade 未关闭")), 2000);
    });
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
  }
});
test("首个请求后清掉 Next 自挂的 upgrade 监听器，PTY 升级不被它 socket.end() 打断", async () => {
  const foreignUpgrades = [];
  const upgrades = [];
  // 模仿 next/dist/server/next.js 的 setupWebSocketHandler：只在它处理的第一个请求里
  // 给同一个 server 挂一个 upgrade 监听器，并像 prod 路径那样把 socket 结束掉。
  const nextLike = () => {
    let attached = false;
    return {
      prepare: async () => {},
      getRequestHandler: () => (req, res) => {
        if (!attached) {
          attached = true;
          req.socket.server.on("upgrade", (upgradeReq, socket) => {
            foreignUpgrades.push(upgradeReq.url);
            socket.end();
          });
        }
        res.statusCode = 200;
        res.end("ok");
      },
    };
  };
  const started = await startPidanceHttpServer({
    dir: "/tmp/pidance-http-test",
    hostname: "127.0.0.1",
    port: 0,
    createNext: nextLike,
    onUpgrade: (req, socket) => {
      upgrades.push(req.url);
      socket.destroy();
    },
  });
  const address = started.server.address();
  assert.ok(address && typeof address === "object");
  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(res.status, 200);
    // Next 挂上的那个已被清掉，只剩我们自己那一个
    assert.equal(started.server.listenerCount("upgrade"), 1);
    await new Promise((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: address.port }, () => {
        socket.write(
          "GET /api/pty HTTP/1.1\r\n" +
            "Host: 127.0.0.1\r\n" +
            "Connection: Upgrade\r\n" +
            "Upgrade: websocket\r\n" +
            "Sec-WebSocket-Version: 13\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
            "\r\n",
        );
      });
      socket.on("close", resolve);
      socket.on("error", reject);
      setTimeout(() => reject(new Error("upgrade socket 未关闭")), 2000);
    });
    assert.deepEqual(upgrades, ["/api/pty"]);
    assert.deepEqual(foreignUpgrades, []);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
  }
});
