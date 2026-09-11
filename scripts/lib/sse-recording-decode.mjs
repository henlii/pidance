/**
 * SSE recording fixture 解码（#26）：把「增量文本 + 边界消息」的录制还原成
 * 协议语义的完整事件序列（`message_update` 是完整 message 快照）。
 *
 * 纯逻辑、无 IO：脚本侧与 node:test 都直接用。
 */

/** 深拷贝 content block（block 内只有文本/签名字段，无需 structuredClone）。 */
function cloneBlock(block) {
  return { ...block };
}

/** 内容块的文本字段名：thinking 用 `thinking`，text 用 `text`。 */
function textFieldOf(type) {
  return type === "thinking" ? "thinking" : "text";
}

function textOf(block) {
  return block?.[textFieldOf(block?.type)] ?? "";
}

/**
 * 每个 assistant/user 消息的内容块模板：以 message_end 的块类型与静态字段为准
 * （`message_start` 可能只有第一个块，后续 update 才出现 text 块）。
 */
function initialBlocks(startMessage, endMessage) {
  const fromEnd = Array.isArray(endMessage?.content) ? endMessage.content : [];
  const fromStart = Array.isArray(startMessage?.content) ? startMessage.content : [];
  const templates = fromEnd.length > 0 ? fromEnd : fromStart;
  return templates.map((block) => {
    // message_start 可能已经带了第一段内容（首个 delta 之前的部分），不能清零。
    const started = fromStart.find((candidate) => candidate.type === block.type);
    return { ...block, [textFieldOf(block.type)]: started ? textOf(started) : "" };
  });
}

/**
 * 解码录制。
 * @returns {{
 *   events: {atMs:number, event:object, kind?:string}[],
 *   updateCount:number,
 *   assistantTexts:string[],
 *   messageEnds:{role:string, atMs:number, text:string}[],
 * }}
 */
export function decodeRecording(fixture) {
  const raw = Array.isArray(fixture?.events) ? fixture.events : [];
  const events = [];
  const assistantTexts = [];
  const messageEnds = [];

  // 预扫：每条消息的 message_start / message_end 配对（按顺序）。
  const starts = raw.filter((item) => item.type === "message_start");
  const ends = raw.filter((item) => item.type === "message_end");
  let startIndex = 0;
  let endIndex = 0;

  let current = null;
  for (const item of raw) {
    if (item.type === "message_start") {
      const endMessage = ends[endIndex]?.message;
      current = {
        base: { ...item.message, content: undefined },
        blocks: initialBlocks(item.message, endMessage),
        endAtMs: ends[endIndex]?.atMs ?? null,
      };
      startIndex += 1;
      events.push({ atMs: item.atMs, event: { type: "message_start", message: item.message } });
      continue;
    }
    if (item.type === "message_update") {
      if (!current) throw new Error("message_update 出现在 message_start 之前");
      const delta = item.delta ?? {};
      // 同一帧里 thinking 与 text 都要处理；块不存在就按模板新建（此前会静默丢帧）。
      for (const kind of ["thinking", "text"]) {
        const addition = delta[kind];
        if (typeof addition !== "string" || addition.length === 0) continue;
        let block = [...current.blocks].reverse().find((candidate) => candidate.type === kind);
        if (!block) {
          block = kind === "thinking"
            ? { type: "thinking", thinking: "", thinkingSignature: "reasoning" }
            : { type: "text", text: "" };
          current.blocks.push(block);
        }
        block[textFieldOf(kind)] = `${textOf(block)}${addition}`;
      }
      events.push({
        atMs: item.atMs,
        kind: delta.text ? "text" : "thinking",
        event: {
          type: "message_update",
          message: { ...current.base, content: current.blocks.map(cloneBlock) },
        },
      });
      continue;
    }
    if (item.type === "message_end") {
      const message = item.message ?? {};
      const text = (message.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
      messageEnds.push({ role: message.role, atMs: item.atMs, text });
      if (message.role === "assistant") assistantTexts.push(text);
      current = null;
      endIndex += 1;
      events.push({ atMs: item.atMs, event: { type: "message_end", message } });
      continue;
    }
    events.push({ atMs: item.atMs, event: { ...item, atMs: undefined } });
  }

  if (startIndex !== ends.length) {
    throw new Error(`录制消息不配对：message_start ${startIndex} 条 / message_end ${ends.length} 条`);
  }

  return {
    events,
    updateCount: raw.filter((item) => item.type === "message_update").length,
    assistantTexts,
    messageEnds,
  };
}

/** 把事件间隔压到 ≤maxGapMs（模型等待时间不该拖长验收）；两端使用同一结果。 */
export function clampSchedule(events, maxGapMs) {
  let elapsed = 0;
  let previousAt = 0;
  return events.map((item) => {
    const gap = Math.min(item.atMs - previousAt, maxGapMs);
    previousAt = item.atMs;
    elapsed += Math.max(gap, 0);
    return { ...item, atMs: elapsed };
  });
}
