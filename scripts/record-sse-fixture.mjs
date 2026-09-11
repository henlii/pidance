/**
 * 录制固定时间戳 SSE fixture（#26 D1）：真实跑一轮 + 中途入队一次 follow-up，
 * 把 `/api/agent/<id>/events` 收到的事件按到达时间写成 JSON。
 *
 * fixture 是验收输入，不参与默认测试：重新录制时才运行本脚本。
 * message_update 在协议里是「完整 message 快照」，直接存会让文件体积按 delta 数
 * 平方增长；这里存增量文本，回放脚本按快照语义重建（见 sse-recording-replay）。
 *
 * 用法（31416 在运行、有可用模型）：
 *   PIDANCE_TEST_PASSWORD=... node scripts/record-sse-fixture.mjs
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const URL_BASE = process.env.PIDANCE_TEST_URL ?? "http://127.0.0.1:31416";
const PASSWORD = process.env.PIDANCE_TEST_PASSWORD ?? "";
const AUTH_HEADER = PASSWORD
  ? { Authorization: `Basic ${Buffer.from(`pi:${PASSWORD}`).toString("base64")}` }
  : {};
const JSON_HEADERS = { "Content-Type": "application/json", ...AUTH_HEADER };

const FIRST_PROMPT =
  "不要使用任何工具。请用大约 600 字的中文说明「流式渲染的帧调度」，分段输出，只输出正文。";
const QUEUED_PROMPT =
  "不要使用任何工具。再用大约 200 字补充说明「为什么低性能设备需要合帧」，只输出正文。";

async function post(path, body) {
  const res = await fetch(`${URL_BASE}${path}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function waitIdle(sessionId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${URL_BASE}/api/agent/${encodeURIComponent(sessionId)}?light=1`, { headers: AUTH_HEADER });
    const body = res.ok ? await res.json() : {};
    if (body.live !== true && body.activeRun !== true) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("会话未在预期时间内空闲");
}

const created = await post("/api/agent/new", {
  cwd: process.cwd(),
  type: "prompt",
  message: "只回答 OK，不要调用工具。",
});
const sessionId = created.sessionId;
console.log(`录制会话 ${sessionId}`);

/** 当前正在录制的 message（message_start → message_update* → message_end）。 */
let current = null;
const events = [];
let startedAt = null;
let queued = false;
let finished = false;
let assistantEnds = 0;

function snapshotText(message, blockType) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter((block) => block?.type === blockType)
    .map((block) => (blockType === "thinking" ? block.thinking ?? "" : block.text ?? ""))
    .join("");
}

function record(event, atMs) {
  if (event.type === "message_start") {
    const message = event.message ?? {};
    const blockTypes = (message.content ?? []).map((block) => block?.type);
    if (blockTypes.some((type) => type !== "thinking" && type !== "text")) {
      throw new Error(`录制仅支持 thinking/text 内容块，遇到 ${JSON.stringify(blockTypes)}`);
    }
    current = {
      role: message.role,
      blockTypes,
      thinking: snapshotText(message, "thinking"),
      text: snapshotText(message, "text"),
    };
    events.push({ atMs, type: "message_start", message });
    return;
  }
  if (event.type === "message_update") {
    const message = event.message ?? {};
    const blockTypes = (message.content ?? []).map((block) => block?.type);
    if (blockTypes.some((type) => type !== "thinking" && type !== "text")) {
      throw new Error(`录制仅支持 thinking/text 内容块，遇到 ${JSON.stringify(blockTypes)}`);
    }
    const thinking = snapshotText(message, "thinking");
    const text = snapshotText(message, "text");
    const delta = {};
    if (current && thinking.startsWith(current.thinking)) {
      const added = thinking.slice(current.thinking.length);
      if (added) delta.thinking = added;
    }
    if (current && text.startsWith(current.text)) {
      const added = text.slice(current.text.length);
      if (added) delta.text = added;
    }
    if (current) {
      current.thinking = thinking;
      current.text = text;
    }
    if (delta.thinking || delta.text) events.push({ atMs, type: "message_update", delta });
    return;
  }
  if (event.type === "message_end") {
    events.push({ atMs, type: "message_end", message: event.message ?? {} });
    if ((event.message ?? {}).role === "assistant") assistantEnds += 1;
    current = null;
    return;
  }
  // 运行边界（agent_end / agent_settled / prompt_done）会让应用按磁盘权威重载
  // timeline，属于服务端回放范围：fixture 不收录，回放也就不会中途结束。
  if (event.type === "agent_end" || event.type === "agent_settled" || event.type === "prompt_done") return;
  events.push({ atMs, ...event });
}

try {
  await waitIdle(sessionId);
  // 先显式 wake：空闲会话没有 live host，SSE 路由会 404（打开历史不建 writer）。
  // wake 只创建 host 不发 prompt，事件从 agent_start 起完整捕获。
  const wake = await fetch(`${URL_BASE}/api/sessions/${encodeURIComponent(sessionId)}/state?wake=1`, { headers: AUTH_HEADER });
  if (!wake.ok) throw new Error(`wake 失败: ${wake.status}`);
  const response = await fetch(`${URL_BASE}/api/agent/${encodeURIComponent(sessionId)}/events`, {
    headers: { ...AUTH_HEADER, Accept: "text/event-stream" },
  });
  if (!response.ok || !response.body) throw new Error(`SSE 连接失败: ${response.status}`);

  await post(`/api/agent/${encodeURIComponent(sessionId)}`, { type: "prompt", message: FIRST_PROMPT });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 120_000;

  while (!finished && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split = buffer.indexOf("\n\n");
    while (split >= 0) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf("\n\n");
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      // 心跳帧（data: ":"）与 connected 不进 fixture。
      if (typeof event !== "object" || event === null || typeof event.type !== "string") continue;
      if (event.type === "connected") continue;
      const now = Date.now();
      if (startedAt === null) startedAt = now;
      record(event, now - startedAt);

      // 首轮开始后入队一条 follow-up：录制里包含队列投递的完整链路。
      if (!queued && event.type === "message_update") {
        queued = true;
        await post(`/api/agent/${encodeURIComponent(sessionId)}`, {
          type: "set_follow_up_queue",
          items: [QUEUED_PROMPT],
        });
      }
      if (assistantEnds >= 2) finished = true;
    }
  }
  await reader.cancel().catch(() => {});
} finally {
  await fetch(`${URL_BASE}/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: AUTH_HEADER,
  }).catch(() => {});
}

const deltas = events.filter((e) => e.type === "message_update").length;
const fixture = {
  version: 1,
  note:
    "真实 run 捕获（#26 D1）。协议里 message_update 是完整 message 快照，这里只存增量文本"
    + "（thinking/text），回放脚本按快照语义重建。运行边界事件（agent_end/agent_settled/"
    + "prompt_done）不收录：它们会让应用按磁盘权威重载 timeline，属于服务端回放范围。"
    + "录制终点是第二轮 assistant message_end。",
  capturedFrom: "pidance 31416 / scripts/record-sse-fixture.mjs",
  events,
};
const out = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sse-run-recording.json");
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`事件 ${events.length}（message_update ${deltas}）→ ${out}`);
