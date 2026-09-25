// Types mirrored from pi-mono coding-agent session-manager

export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  /** Pi 原生 0.85 ImageContent 的扁平结构。 */
  data?: string;
  mimeType?: string;
  /** 兼容历史/供应商 source 结构的图片块。 */
  source?: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export type BinaryMessageKind = "image" | "audio" | "video" | "file";

/** 上传后由 Pidance 文件存储返回的二进制消息输入。 */
export interface BinaryMessageInput {
  path: string;
  name: string;
  mimeType: string;
  size: number;
  /** image 的小尺寸预览文件；原图仍由 path 指向。 */
  previewPath?: string;
}

/** Pi custom entry 中保存的 UI-only 二进制消息元数据。 */
export interface BinaryMessageData extends BinaryMessageInput {
  type: "binary";
  version: 1;
  kind: BinaryMessageKind;
  /** 关联的 Pi user message entry；缺省表示独立二进制消息。 */
  messageEntryId?: string;
}

/** 上传到 Pidance 附件目录后返回的引用（字节在盘上，输入框/队列只存引用）。 */
export interface UploadedMedia {
  path: string;
  name: string;
  /** 落盘文件名（附件目录内唯一）。 */
  storedName: string;
  size: number;
  mimeType: string;
}

export interface AttachedImage {
  /**
   * 发送给模型的安全尺寸图片 Base64。
   *
   * 只在没有 `media` 引用时作为兼容路径内联给 SDK；正常流程里字节在附件
   * 目录（media.model），Host 按引用回读，浏览器不保留 base64。
   */
  data?: string;
  mimeType: string;
  /** 当前输入框缩略图 URL（本地 blob 或附件读取 URL）。 */
  previewUrl?: string;
  /**
   * 进入输入框时上传好的媒体引用：模型副本 + 原图（+ 内联预览）。
   *
   * 队列、二进制消息卡片与「删除输入框附件即回收」都以它为唯一来源。
   */
  media?: AttachedImageMedia;
  /** 兼容：历史消息/旧草稿只带原图元数据（无 media 时的引用来源）。 */
  original?: BinaryMessageInput;
}

/** 一张图的全部已上传副本。preview 与 original 同一路径时表示直接用原图做预览。 */
export interface AttachedImageMedia {
  model: UploadedMedia;
  original: UploadedMedia;
  preview: UploadedMedia;
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
  /** 把 text（可选带图片）放到当前草稿之前（队列取回语义）。 */
  prependText: (text: string, images?: AttachedImage[]) => void;
  /** 整体替换输入框内容（分支/新会话预填语义，对齐 OC replace）。 */
  replaceText: (text: string) => void;
  addFiles: (files: File[]) => void;
  /**
   * 发送失败后的原样恢复（正文 + 图片一起回输入框）。
   *
   * 与 prependText 的差别：图片必须能回来。失败回滚是「原会话草稿完整恢复」，
   * 只退正文会把用户刚贴的图静默丢掉。
   *
   * `ownerKey` = 内容归属的会话；省略时算当前输入框。传了原会话 key 时，即使用户
   * 已经切走，内容也会落进**原会话草稿**（UI 只决定渲染，不决定保存）。
   */
  restoreDraft: (text: string, images?: AttachedImage[], ownerKey?: string) => void;
  /** 从当前 draftKey 的草稿重建输入框内容（队列取回等外部改动后刷新）。 */
  reloadDraft: () => void;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  /** Historical content omitted from the initial response and loaded on demand. */
  deferred?: boolean;
}

/**
 * 工具定义里的显示元数据（issue #75）：`label` 是人类可读名（pi-mcp-adapter 给 "MCP"、
 * pi-lsp 给 "LSP: Diagnostics"），`renderShell: "self"` 表示该工具**自带外壳**、
 * 宿主不得再套一层卡片边框与底色。
 *
 * 只承载显示语义，不参与工具执行。
 */
export interface ToolDisplayMeta {
  label?: string;
  renderShell?: "self";
}

export interface ToolCallContent {
  type: "toolCall";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** 插件 renderCall 在服务端 headless 渲染得到的 ANSI 行。 */
  renderedCallLines?: string[];
  /** 工具定义的显示名（`ToolDefinition.label`）；缺省时客户端回退到工具名格式化。 */
  toolLabel?: string;
  /** 工具定义声明自带外壳（`renderShell: "self"`）：客户端不套卡片边框/底色。 */
  toolShell?: "self";
}

export type AssistantContentBlock = TextContent | ImageContent | ThinkingContent | ToolCallContent;

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp?: number;
  /** Pidance UI 投影：原图/其它二进制消息块，不写入 Pi 原生 user message。 */
  binaryBlocks?: BinaryMessageData[];
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContentBlock[];
  model: string;
  provider: string;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
  /** 该条消息产生时的思考档（由会话路径上最近一次 thinking_level_change 投影）。 */
  thinkingLevel?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: (TextContent | ImageContent)[];
  isError?: boolean;
  details?: unknown;
  /** 插件 renderResult 在服务端 headless 渲染得到的 ANSI 行。 */
  renderedResultLines?: string[];
  timestamp?: number;
}

export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: unknown;
  /** 插件消息渲染器在服务端 headless 渲染得到的 ANSI 行。 */
  renderedLines?: string[];
  timestamp?: number;
}

export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  timestamp?: number;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage | CustomMessage | BashExecutionMessage;

export type ExtensionUiRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      expiresAt?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message: string;
      expiresAt?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      expiresAt?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
      expiresAt?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "notify";
      message: string;
      notifyType?: "info" | "success" | "warning" | "error";
      activityRecord?: boolean;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setStatus";
      statusKey: string;
      statusText?: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setToolsExpanded";
      toolsExpanded: boolean;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "terminalInputListeners";
      /** 当前注册了全局按键监听的监听器数量（0 = 前端无需询问）。 */
      count: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWorkingMessage";
      /** null = 恢复默认文案。 */
      message: string | null;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWorkingVisible";
      visible: boolean;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWorkingIndicator";
      /** null = 恢复默认 spinner；空数组 = 隐藏指示器。 */
      frames: string[] | null;
      intervalMs: number | null;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setTitle";
      title: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "set_editor_text";
      text: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "custom";
      lines: string[];
      closed?: boolean;
      /** 插件把面板收起了（overlay 句柄的 setHidden）：前端让位给背后的会话内容。 */
      hidden?: boolean;
      /** 插件声明了 overlay 时的定位/尺寸；缺省表示按全屏模态面板渲染。 */
      layout?: ExtensionUiCustomLayout;
    };

/**
 * 插件 overlay 面板的定位/尺寸（pi-tui `OverlayOptions` 在 Web 上的投影）。
 *
 * 只带插件真正用得到的那几个字段：真实插件只用到 anchor / width / minWidth /
 * maxHeight / margin，row / col / offset / visible 回调等未出现。
 */
export interface ExtensionUiCustomLayout {
  /** 九个锚点之一（center、top-left、bottom-center …），缺省 center。 */
  anchor: string;
  /** 数字 = 终端列数，字符串 = 百分比（如 "95%"）。 */
  width?: number | string;
  /** 终端列数。 */
  minWidth?: number;
  /** 数字 = 终端行数，字符串 = 百分比。 */
  maxHeight?: number | string;
  /** 数字 = 四周一致，对象按边给；单位为终端行/列。 */
  margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
}

export type ExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export interface ExtensionStatusItem {
  key: string;
  text: string;
}

export interface ExtensionWidgetItem {
  key: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

/**
 * SSE 工具事件的插件 TUI 渲染扩展字段；服务端缺省时客户端维持原展示。
 *
 * 事件名必须与 SDK 实际发的会话事件一致（tool_execution_start/update/end）——
 * tool_call / tool_result 是**扩展钩子**事件，不会到达会话订阅者，
 * 之前按它们接线等于全链路静默失效（issue #69）。
 * rendered_lines_update 是宿主自己的重渲事件（插件 invalidate / 宽度变化）。
 */
export type ToolRenderedAgentEvent =
  | { type: "tool_execution_start"; renderedCallLines?: string[]; toolLabel?: string; toolShell?: "self" }
  | { type: "tool_execution_update"; renderedLines?: string[] }
  | { type: "tool_execution_end"; renderedResultLines?: string[] }
  | { type: "rendered_lines_update"; renderedCallLines?: string[]; renderedResultLines?: string[] };

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
  fromHook?: boolean;
}

export interface BranchSummaryEntry extends SessionEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: unknown;
  fromHook?: boolean;
}

export interface CustomEntry extends SessionEntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

export interface CustomMessageEntry extends SessionEntryBase {
  type: "custom_message";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: unknown;
  display: boolean;
}

export interface LabelEntry extends SessionEntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}

export interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info";
  name?: string;
}

export type SessionEntry =
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry;

export type FileEntry = SessionHeader | SessionEntry;

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label?: string;
  compressedEntryIds?: string[];
}

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  parentSessionId?: string; // set if this session was forked from another
  /** Subagent 关系只表示工具结果发现的直接父子，不伪装成 Pi fork。 */
  subagent?: {
    parentSessionId: string;
    runId: string;
    runIndex: number;
    agent?: string;
  };
  /** 子代理持久化会话只能浏览，服务端也必须执行此门禁。 */
  readOnly?: true;
  /** Project root = the session cwd itself (one directory, one project).
   *  Always set by the server; optional because the client builds transient
   *  SessionInfo objects before the first refresh. Fall back to cwd. */
  projectRoot?: string;
  /** 归档时间（ISO）。存在即视为已归档：普通列表/Recent/搜索默认排除，聊天只读。 */
  archivedAt?: string;
}

export interface SessionContext {
  messages: AgentMessage[];
  entryIds: string[]; // parallel to messages — the session entry id for each message
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
  /** 当前窗口之前是否还有更旧消息（tail/before 分页时由服务端填充）。 */
  hasMoreBefore?: boolean;
  /** 未切片前的消息总数。 */
  totalMessageCount?: number;
}
