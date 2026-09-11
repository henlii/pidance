/**
 * 自管 HTTP 服务器的响应压缩。
 *
 * Next 的 `compress` 只在它自己的内置服务器（router-server）里生效，而 Pidance 用
 * `http.createServer` + `app.getRequestHandler()` 启动，压缩中间件从不运行。
 * 实测后果：`/api/sessions` 105 KB、`/api/agent/[id]` 34 KB（其中 systemPrompt
 * 29 KB）都是原样明文下发，且这些端点会被定时轮询。
 *
 * 这里用 node:zlib 补上 gzip，只处理可压缩的文本类型：
 * - 跳过 `text/event-stream`（SSE 必须即时冲刷，不能缓冲）
 * - 跳过已带 content-encoding、Range 请求、无正文状态码、过小响应
 * - 去掉 Content-Length（压缩后长度未知），补 Vary: Accept-Encoding
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const zlib = require("node:zlib");

/** 低于此字节数压缩净收益为负（gzip 头尾开销 + CPU）。 */
const DEFAULT_MIN_SIZE = 1024;

/**
 * 可压缩类型白名单。刻意用白名单而非「非二进制黑名单」：
 * 漏掉一个文本类型只是不省流量，误压一个二进制类型会损坏响应。
 */
const COMPRESSIBLE_TYPE =
  /^(?:text\/(?!event-stream)|application\/(?:json|javascript|xml|x-ndjson|manifest\+json|ld\+json)|image\/svg\+xml)/i;

/** 无正文的状态码。 */
const BODYLESS_STATUS = new Set([204, 205, 304]);

/** 大小写不敏感地读一个普通对象的头。 */
function headerFrom(headers, name) {
  if (!headers) return null;
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== target) continue;
    const value = headers[key];
    if (value === undefined || value === null) return null;
    return Array.isArray(value) ? value.join(", ") : String(value);
  }
  return null;
}

function headerOf(res, name) {
  const value = typeof res.getHeader === "function" ? res.getHeader(name) : undefined;
  if (value === undefined || value === null) return null;
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/** 解析 Accept-Encoding：显式 gzip 优先，其次通配 `*`；`q=0` 视为不接受。 */
function acceptsGzip(header) {
  if (!header) return false;
  let wildcard = false;
  for (const part of String(header).split(",")) {
    const [rawName, ...params] = part.split(";");
    const name = rawName.trim().toLowerCase();
    if (name !== "gzip" && name !== "*") continue;
    const qParam = params.map((p) => p.trim()).find((p) => p.toLowerCase().startsWith("q="));
    const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1;
    if (Number.isFinite(q) && q === 0) continue;
    if (name === "gzip") return true;
    wildcard = true;
  }
  return wildcard;
}

function shouldCompress(req, res, headers, minSize) {
  if (res.headersSent) return false;
  if (req.method === "HEAD") return false;
  if (!acceptsGzip(req.headers?.["accept-encoding"])) return false;
  if (req.headers?.range) return false;
  if (headerOf(res, "content-encoding")) return false;
  const status = Number(res.statusCode) || 200;
  if (BODYLESS_STATUS.has(status)) return false;
  const contentType = headerFrom(headers, "content-type") ?? headerOf(res, "content-type");
  if (!contentType || !COMPRESSIBLE_TYPE.test(String(contentType).trim())) return false;
  const declared = headerFrom(headers, "content-length") ?? headerOf(res, "content-length");
  if (declared !== null && declared !== undefined && Number(declared) < minSize) return false;
  return true;
}

function withVary(existing) {
  if (!existing) return "Accept-Encoding";
  const parts = String(existing).split(",").map((p) => p.trim());
  return parts.some((p) => p.toLowerCase() === "accept-encoding")
    ? String(existing)
    : `${existing}, Accept-Encoding`;
}

function deleteHeader(headers, name) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
  }
}

/**
 * 就地为一次响应安装 gzip。
 * 返回 `{ enabled }` 供测试断言；生产调用可忽略。
 */
function installResponseCompression(req, res, options = {}) {
  const minSize = options.minSize ?? DEFAULT_MIN_SIZE;
  const createGzip = options.createGzip ?? (() => zlib.createGzip());
  const writeHeadOriginal = res.writeHead.bind(res);
  const writeOriginal = res.write.bind(res);
  const endOriginal = res.end.bind(res);

  let stream = null;
  let decided = false;
  let compressThisResponse = false;

  /** 在 head 落地前做决定；重复调用只生效一次。 */
  const decide = (headers) => {
    if (decided) return;
    // write() 可能先于 writeHead（隐式 head）：此时 statusCode/headers 已在 res 上。
    decided = true;
    if (!shouldCompress(req, res, headers, minSize)) return;
    compressThisResponse = true;

    if (headers) {
      // writeHead 收到的头对象会覆盖此前 setHeader 的值，所以在这里就地改。
      const existingVary = headerFrom(headers, "vary") ?? headerOf(res, "vary");
      deleteHeader(headers, "content-length");
      deleteHeader(headers, "vary");
      headers["content-encoding"] = "gzip";
      headers["vary"] = withVary(existingVary);
      return;
    }
    const existingVary = headerOf(res, "vary");
    res.removeHeader("content-length");
    res.setHeader("content-encoding", "gzip");
    res.setHeader("vary", withVary(existingVary));
  };

  /**
   * 惰性创建压缩流。压缩是流式的：gzip 的 data 直接写底层响应，
   * gzip 读侧 end 时**必须**结束底层响应，否则连接会一直挂着不结束。
   */
  const startStream = () => {
    if (stream) return stream;
    const gzip = createGzip();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try { endOriginal(); } catch { /* 已关闭 */ }
    };
    gzip.on("data", (chunk) => writeOriginal(chunk));
    gzip.on("end", finish);
    gzip.on("error", finish);
    // 客户端提前断开：销毁压缩流，避免继续缓冲。
    res.on("close", () => { if (!finished) gzip.destroy(); });
    stream = gzip;
    return stream;
  };

  res.writeHead = function patchedWriteHead(statusCode, statusMessage, headers) {
    let extraHeaders = headers;
    if (typeof statusMessage === "object" && statusMessage !== null) {
      extraHeaders = statusMessage;
      decide(extraHeaders);
      return writeHeadOriginal(statusCode, extraHeaders);
    }
    decide(extraHeaders);
    return extraHeaders === undefined
      ? writeHeadOriginal(statusCode)
      : writeHeadOriginal(statusCode, statusMessage, extraHeaders);
  };

  res.write = function patchedWrite(chunk, encoding, callback) {
    decide(undefined);
    if (!compressThisResponse) return writeOriginal(chunk, encoding, callback);
    startStream();
    if (typeof encoding === "function") callback = encoding;
    stream.write(chunk);
    if (typeof callback === "function") callback();
    return true;
  };

  res.end = function patchedEnd(chunk, encoding, callback) {
    decide(undefined);
    if (!compressThisResponse) return endOriginal(chunk, encoding, callback);
    const gzip = startStream();
    if (typeof chunk === "function") {
      callback = chunk;
      chunk = undefined;
      encoding = undefined;
    } else if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (typeof callback === "function") res.once("finish", callback);
    if (chunk !== undefined && chunk !== null) gzip.end(chunk, encoding);
    else gzip.end();
    return res;
  };

  return { enabled: () => compressThisResponse };
}

module.exports = {
  installResponseCompression,
  acceptsGzip,
  shouldCompress,
  withVary,
  headerFrom,
  DEFAULT_MIN_SIZE,
};
