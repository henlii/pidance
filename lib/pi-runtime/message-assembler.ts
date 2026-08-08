/**
 * 服务端消息组装器：把 RPC message_start / message_update / message_end
 * 规范为前端契约（累计 event.message）。
 *
 * 兼容：
 * - 0.81：message_update 可能已带累计 message + assistantMessageEvent
 * - 0.84：message_update 可能仅有 delta，无累计 message / partial
 */

export type AssemblerAgentEvent = {
  type: string;
  message?: unknown;
  assistantMessageEvent?: AssistantMessageEventLike;
  [key: string]: unknown;
};

export type AssistantMessageEventLike = {
  type: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  partial?: unknown;
  // toolcall 相关字段（宽松）
  id?: string;
  name?: string;
  arguments?: unknown;
  [key: string]: unknown;
};

type ContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  [key: string]: unknown;
};

type MutableMessage = {
  role: string;
  content: ContentBlock[];
  [key: string]: unknown;
};

/**
 * 有状态组装器：一次 RPC 进程 / 一次 live session 一个实例。
 * 输出的 message_update 始终带累计 message；原 assistantMessageEvent 保留
 * 供调试，下游 projectAgentEvent 仍会剥离。
 */
export class MessageAssembler {
  private current: MutableMessage | null = null;

  /** 处理一条原始 RPC 事件，返回对外事件（可能为 null 表示丢弃）。 */
  process(event: AssemblerAgentEvent): AssemblerAgentEvent | null {
    if (!event || typeof event.type !== "string") return null;

    switch (event.type) {
      case "message_start": {
        const msg = cloneMessage(event.message);
        this.current = msg;
        return { ...event, message: msg ?? event.message };
      }

      case "message_update": {
        const ame = event.assistantMessageEvent;
        // 优先：已有累计 message（0.81 风格）→ 同步 buffer 并透传
        if (event.message && isMessageLike(event.message)) {
          this.current = cloneMessage(event.message);
          return { ...event, message: this.current };
        }
        // delta-only：在 buffer 上应用 delta
        if (!this.current) {
          this.current = { role: "assistant", content: [] };
        }
        if (ame) applyAssistantDelta(this.current, ame);
        return {
          ...event,
          message: cloneMessage(this.current),
        };
      }

      case "message_end": {
        // message_end.message 为权威
        if (event.message && isMessageLike(event.message)) {
          this.current = null;
          return { ...event, message: cloneMessage(event.message) };
        }
        const finalMsg = this.current ? cloneMessage(this.current) : event.message;
        this.current = null;
        return { ...event, message: finalMsg };
      }

      default:
        return event;
    }
  }

  reset(): void {
    this.current = null;
  }
}

function isMessageLike(value: unknown): value is MutableMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as MutableMessage;
  return typeof m.role === "string" && Array.isArray(m.content);
}

function cloneMessage(value: unknown): MutableMessage | null {
  if (!isMessageLike(value)) return null;
  return {
    ...value,
    content: value.content.map((block) => ({ ...block })),
  };
}

function ensureBlock(message: MutableMessage, index: number, type: string): ContentBlock {
  while (message.content.length <= index) {
    message.content.push({ type: "text", text: "" });
  }
  const block = message.content[index];
  if (block.type !== type) {
    // 类型切换：保留 id/name 等，重置主体字段
    message.content[index] = { ...block, type };
  }
  return message.content[index];
}

function applyAssistantDelta(message: MutableMessage, ame: AssistantMessageEventLike): void {
  const index = typeof ame.contentIndex === "number" ? ame.contentIndex : 0;
  const t = ame.type;

  switch (t) {
    case "text_start": {
      const block = ensureBlock(message, index, "text");
      block.text = typeof ame.content === "string" ? ame.content : "";
      break;
    }
    case "text_delta": {
      const block = ensureBlock(message, index, "text");
      block.text = (block.text ?? "") + (typeof ame.delta === "string" ? ame.delta : "");
      break;
    }
    case "text_end": {
      const block = ensureBlock(message, index, "text");
      if (typeof ame.content === "string") block.text = ame.content;
      break;
    }
    case "thinking_start": {
      const block = ensureBlock(message, index, "thinking");
      block.thinking = typeof ame.content === "string" ? ame.content : "";
      break;
    }
    case "thinking_delta": {
      const block = ensureBlock(message, index, "thinking");
      block.thinking = (block.thinking ?? "") + (typeof ame.delta === "string" ? ame.delta : "");
      break;
    }
    case "thinking_end": {
      const block = ensureBlock(message, index, "thinking");
      if (typeof ame.content === "string") block.thinking = ame.content;
      break;
    }
    case "toolcall_start":
    case "tool_call_start": {
      const block = ensureBlock(message, index, "toolCall");
      if (typeof ame.id === "string") block.id = ame.id;
      if (typeof ame.name === "string") block.name = ame.name;
      if (ame.arguments !== undefined) block.arguments = ame.arguments;
      break;
    }
    case "toolcall_delta":
    case "tool_call_delta": {
      const block = ensureBlock(message, index, "toolCall");
      // 参数可能以字符串 delta 流式到达
      if (typeof ame.delta === "string") {
        const prev =
          typeof block.arguments === "string"
            ? block.arguments
            : block.arguments != null
              ? JSON.stringify(block.arguments)
              : "";
        block.arguments = prev + ame.delta;
      } else if (ame.arguments !== undefined) {
        block.arguments = ame.arguments;
      }
      break;
    }
    case "toolcall_end":
    case "tool_call_end": {
      const block = ensureBlock(message, index, "toolCall");
      if (typeof ame.id === "string") block.id = ame.id;
      if (typeof ame.name === "string") block.name = ame.name;
      if (ame.arguments !== undefined) block.arguments = ame.arguments;
      if (typeof ame.content === "string" && ame.arguments === undefined) {
        // 部分版本在 end 用 content 放完整 arguments JSON
        try {
          block.arguments = JSON.parse(ame.content);
        } catch {
          block.arguments = ame.content;
        }
      }
      break;
    }
    default:
      // 未知 delta：若 partial 有完整消息则采用
      if (ame.partial && isMessageLike(ame.partial)) {
        message.role = ame.partial.role;
        message.content = ame.partial.content.map((b) => ({ ...b }));
        for (const [k, v] of Object.entries(ame.partial)) {
          if (k !== "role" && k !== "content") message[k] = v;
        }
      }
      break;
  }
}
