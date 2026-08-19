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
