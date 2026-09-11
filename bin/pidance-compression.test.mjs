/**
 * 自管 server 的响应压缩。
 * 关键点是「压什么、不压什么」——压错会让 SSE 卡住或损坏二进制响应。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { request } from "node:http";
import { once } from "node:events";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { installResponseCompression, acceptsGzip, shouldCompress, withVary } =
  require("./pidance-compression.js");

test("acceptsGzip：显式 gzip、通配符、q=0 拒绝", () => {
  assert.equal(acceptsGzip("gzip, deflate, br"), true);
  assert.equal(acceptsGzip("deflate"), false);
  assert.equal(acceptsGzip("*"), true);
  assert.equal(acceptsGzip("gzip;q=0"), false, "q=0 表示不接受");
  assert.equal(acceptsGzip("br, *;q=0.5"), true);
  assert.equal(acceptsGzip(""), false);
  assert.equal(acceptsGzip(undefined), false);
});

test("withVary：不重复追加 Accept-Encoding", () => {
  assert.equal(withVary(null), "Accept-Encoding");
  assert.equal(withVary("Origin"), "Origin, Accept-Encoding");
  assert.equal(withVary("origin, accept-encoding"), "origin, accept-encoding");
});

function fakeRes(headers = {}, statusCode = 200) {
  const store = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    statusCode,
    headersSent: false,
    getHeader: (n) => store.get(String(n).toLowerCase()),
    setHeader: (n, v) => store.set(String(n).toLowerCase(), v),
    removeHeader: (n) => store.delete(String(n).toLowerCase()),
    _store: store,
  };
}

const jsonReq = (accept = "gzip") => ({
  method: "GET",
  headers: { "accept-encoding": accept },
});

test("shouldCompress：文本/JSON 压，SSE 与二进制不压", () => {
  assert.equal(shouldCompress(jsonReq(), fakeRes({ "content-type": "application/json" }), null, 1024), true);
  assert.equal(shouldCompress(jsonReq(), fakeRes({ "content-type": "text/html" }), null, 1024), true);
  assert.equal(
    shouldCompress(jsonReq(), fakeRes({ "content-type": "text/event-stream" }), null, 1024),
    false,
    "SSE 必须即时冲刷，压缩会缓冲住事件",
  );
  assert.equal(shouldCompress(jsonReq(), fakeRes({ "content-type": "image/png" }), null, 1024), false);
  assert.equal(shouldCompress(jsonReq(), fakeRes({ "content-type": "font/woff2" }), null, 1024), false);
  assert.equal(shouldCompress(jsonReq(), fakeRes({ "content-type": "video/mp4" }), null, 1024), false);
  assert.equal(shouldCompress(jsonReq(), fakeRes({ "content-type": "application/octet-stream" }), null, 1024), false);
});

test("shouldCompress：已编码、Range、HEAD、无正文状态、过小响应都跳过", () => {
  const base = { "content-type": "application/json" };
  assert.equal(
    shouldCompress(jsonReq(), fakeRes({ ...base, "content-encoding": "br" }), null, 1024),
    false,
    "已编码不得二次压缩",
  );
  assert.equal(
    shouldCompress({ method: "GET", headers: { "accept-encoding": "gzip", range: "bytes=0-99" } },
      fakeRes(base), null, 1024),
    false,
    "Range 请求跳过（内容长度语义不同）",
  );
  assert.equal(shouldCompress({ method: "HEAD", headers: { "accept-encoding": "gzip" } }, fakeRes(base), null, 1024), false);
  assert.equal(shouldCompress(jsonReq(), fakeRes(base, 304), null, 1024), false);
  assert.equal(shouldCompress(jsonReq(), fakeRes(base, 204), null, 1024), false);
  assert.equal(
    shouldCompress(jsonReq(), fakeRes({ ...base, "content-length": "120" }), null, 1024),
    false,
    "低于阈值不值得压",
  );
  assert.equal(
    shouldCompress(jsonReq(), fakeRes({ ...base, "content-length": "100000" }), null, 1024),
    true,
  );
  assert.equal(shouldCompress(jsonReq("br"), fakeRes(base), null, 1024), false, "客户端不支持 gzip 时不压");
});

/** 起一个真实 HTTP server，按给定响应形态回包，返回客户端看到的结果。 */
async function roundTrip(handler, reqOptions = {}) {
  const server = createServer((req, res) => {
    installResponseCompression(req, res);
    handler(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    return await new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path: "/", method: "GET", headers: { "accept-encoding": "gzip" }, ...reqOptions },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  } finally {
    server.close();
  }
}

test("真实响应：JSON 被 gzip，Content-Length 移除且可解回原文", async () => {
  const payload = JSON.stringify({ sessions: Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, firstMessage: "x".repeat(200) })) });
  const res = await roundTrip((_req, response) => {
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    response.end(payload);
  });
  assert.equal(res.headers["content-encoding"], "gzip");
  assert.equal(res.headers["content-length"], undefined, "压缩后长度未知，必须移除");
  assert.equal(res.headers.vary, "Accept-Encoding");
  assert.equal(zlib.gunzipSync(res.body).toString("utf8"), payload);
  assert.ok(res.body.length < payload.length / 2, "应当明显变小");
});

test("真实响应：writeHead 后再 write 的分块正文也能正确压缩", async () => {
  const payload = "a".repeat(4000) + "b".repeat(4000);
  const res = await roundTrip((_req, response) => {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.write(payload.slice(0, 4000));
    response.write(payload.slice(4000));
    response.end();
  });
  assert.equal(res.headers["content-encoding"], "gzip");
  assert.equal(zlib.gunzipSync(res.body).toString("utf8"), payload);
});

test("真实响应：SSE 不被压缩也不被缓冲", async () => {
  const res = await roundTrip((_req, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: one\n\n");
    response.end("data: two\n\n");
  });
  assert.equal(res.headers["content-encoding"], undefined);
  assert.equal(res.body.toString("utf8"), "data: one\n\ndata: two\n\n");
});

test("真实响应：二进制类型原样通过（长度与字节不变）", async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]);
  const res = await roundTrip((_req, response) => {
    response.writeHead(200, { "content-type": "image/png", "content-length": bytes.length });
    response.end(bytes);
  });
  assert.equal(res.headers["content-encoding"], undefined);
  assert.deepEqual(res.body, bytes);
});

test("真实响应：小 JSON 不压缩，但内容不变", async () => {
  const payload = JSON.stringify({ ok: true });
  const res = await roundTrip((_req, response) => {
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    response.end(payload);
  });
  assert.equal(res.headers["content-encoding"], undefined);
  assert.equal(res.body.toString("utf8"), payload);
});

test("真实响应：客户端不带 Accept-Encoding 时原样返回", async () => {
  const payload = "x".repeat(5000);
  const res = await roundTrip(
    (_req, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(payload);
    },
    { headers: {} },
  );
  assert.equal(res.headers["content-encoding"], undefined);
  assert.equal(res.body.toString("utf8"), payload);
});
