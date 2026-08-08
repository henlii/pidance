/**
 * 严格 JSONL framing（仅 LF 分帧）。
 * 禁止用 Node readline：它会按 U+2028/U+2029 切分，而它们可出现在 JSON 字符串内。
 */

import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

/** 序列化单条 JSONL 记录（末尾必为 \\n）。 */
export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * 将可读流按 LF-only 规则拆成完整行，回调原始行文本（不含尾部 \\n；
 * 若行尾为 \\r\\n 则剥掉 \\r）。
 * 返回 detach 函数。
 */
export function attachJsonlLineReader(
  stream: Readable,
  onLine: (line: string) => void,
): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const emitLine = (line: string) => {
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };

  const onData = (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      emitLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
    }
  };

  const onEnd = () => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      emitLine(buffer);
      buffer = "";
    }
  };

  stream.on("data", onData);
  stream.on("end", onEnd);
  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

/**
 * 纯缓冲解析器：喂入 chunk，吐出完整行。便于单测，不依赖 stream。
 */
export class JsonlLineBuffer {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      lines.push(line);
    }
    return lines;
  }

  /** 流结束时冲刷残余（无尾 \\n 的最后一行）。 */
  flush(): string | null {
    if (this.buffer.length === 0) return null;
    let line = this.buffer;
    this.buffer = "";
    if (line.endsWith("\r")) line = line.slice(0, -1);
    return line;
  }
}
