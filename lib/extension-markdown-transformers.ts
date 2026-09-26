/**
 * 插件 markdown 转换器（`pi.registerMarkdownTransformer`，issue #106）。
 *
 * 背景：插件可以在 Pi 渲染用户/助手 markdown **之前**改文本（TUI 里由
 * `Markdown` 组件在渲染时调用）。Pidance 的 Web 端原本没有任何落点 —— 插件注册了也
 * 只有 TUI 生效，Web 上静默无效。本模块把它接到 **Web 的渲染边界**：服务端投影出来的
 * 消息窗口（分页后的那一段）与按需加载的思考正文。
 *
 * 与 SDK 的关系（语义逐字对齐，不要自己发明）：
 * - `dist/modes/interactive/components/markdown-transform.js` 的 `applyMarkdownTransformers`：
 *   按链顺序依次应用，每个转换器拿到**上一个的输出**；返回非字符串则忽略（保持当前值）；
 *   **抛错只跳过这一个**，后续转换器继续跑（不是整条放弃）。
 * - 调用点（`user-message.js` / `assistant-message.js`）：用户消息 `("user", isStreaming=false)`、
 *   助手正文 `("assistant", isStreaming)`、助手思考 `("assistant-thinking", isStreaming)`。
 * - 每个扩展只保留**最后一个**转换器（`loader.js` 是赋值），链 = 各扩展的转换器按扩展顺序拼接
 *   （`runner.js` 的 `getMarkdownTransformers` 是 `flatMap`）。
 *
 * **有意分叉（与 TUI 不一致，写清理由）**：TUI 的链首还有 SDK 自带的 mermaid 转换器，
 * 它把 mermaid 代码块换成本地渲染的 **ASCII 图**（`createMermaidMarkdownTransformer` →
 * `render(token.text)` → 行内 code span，还按 availableWidth 裁剪）。Web 端已经有**真正的**
 * 图形渲染（`components/MarkdownBody.tsx` 动态 `import("mermaid")` 出 SVG，还带预览按钮），
 * 接上链首会把代码块换成 ASCII 图、把我们更好的渲染路径挡掉。所以这里**只跑扩展转换器**。
 *
 * **有意分块（与 TUI 的第二处差别）**：TUI 在渲染前把**连续 thinking 块**用 `\n\n` 拼成一次转换
 * （`assistant-message.js`），把用户消息的**全部 text 块**拼成一个字符串再转、正文还会 `trim()`。
 * 这里**逐块**转换、只跳过空白块、不 trim，理由是结构完整性：
 * - 投影里的块与磁盘 entry 是**按下标一一对应**的 —— `getEntryThinking(sessionId, entryId, blockIndex)`
 *   正是按这个下标回读磁盘上那块思考正文；把 N 块并成 1 块会让下标错位、按需加载取到错的块。
 * - 一次转换后的整段文本**无法可靠拆回** N 块（转换器是任意函数）。
 * - 投影出来的 text 同时供复制/摘录使用，`trim()` 会悄悄改内容（TUI 那里 trim 只是渲染需要）。
 * 单块消息（绝大多数）两条路径完全一致。
 *
 * 边界：
 * - **只读投影**：只改投影出来的文本，不写 JSONL、不执行会话动作、不唤醒 writer。
 * - 加载扩展失败 / 没有转换器 → 调用方零成本跳过（返回 null）。
 * - 缓存：链按 (cwd, agentDir) 短 TTL 缓存；单条消息按
 *   (链指纹, 消息 id, 内容 hash, availableWidth, isStreaming, messageType) 记忆化，避免
 *   同一份内容随每次分页请求重复跑插件代码。
 */

import {
  invalidateLoadedExtensionsCache,
  loadExtensionsForCwd,
  type LoadedExtensionsLoader,
} from "./loaded-extensions";

/** 与 SDK `MarkdownTransformContext` 同形。 */
export interface MarkdownTransformContext {
  messageType: "user" | "assistant" | "assistant-thinking";
  isStreaming: boolean;
  availableWidth: number;
}

/** 与 SDK `MarkdownTransformer` 同形（同步返回字符串）。 */
export type MarkdownTransformer = (markdown: string, context: MarkdownTransformContext) => string;

/** 链指纹：用来在缓存键里区分「同一份链」与「插件换过之后的链」。 */
export interface MarkdownTransformerChain {
  transformers: MarkdownTransformer[];
  /** 由链里各函数的稳定 id 拼成；插件重载后函数对象变了，指纹随之变化。 */
  fingerprint: string;
}

export interface MarkdownTransformerChainOptions {
  cwd: string;
  agentDir?: string;
  /** 注入加载器（测试不加载真实扩展）。 */
  loaderFactory?: (cwd: string, agentDir: string | undefined) => LoadedExtensionsLoader;
  /** 跳过缓存（内部/测试用）。 */
  bypassCache?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 收集扩展注册的 markdown 转换器（按扩展顺序）。
 *
 * 每个扩展最多一个（SDK 侧 `registerMarkdownTransformer` 是赋值），非函数一律跳过 ——
 * 扩展写坏了不能让整个会话读不出来。
 */
export function collectMarkdownTransformers(extensions: Array<Record<string, unknown>>): MarkdownTransformer[] {
  const out: MarkdownTransformer[] = [];
  for (const extension of extensions) {
    const transformer = asRecord(extension)?.markdownTransformer;
    if (typeof transformer === "function") out.push(transformer as MarkdownTransformer);
  }
  return out;
}

/**
 * 依次应用转换器 —— 与 SDK 的 `applyMarkdownTransformers` 逐条对齐：
 * 链式传递、非字符串忽略、抛错只跳过这一个。
 */
export function applyMarkdownTransformers(
  markdown: string,
  context: MarkdownTransformContext,
  transformers: MarkdownTransformer[],
): string {
  let transformed = markdown;
  for (const transformer of transformers) {
    try {
      const next = transformer(transformed, context);
      if (typeof next === "string") transformed = next;
    } catch {
      // 与 SDK 一致：跳过这一个，继续跑后面的转换器。
    }
  }
  return transformed;
}

// ── 函数身份：给缓存键一个「插件换过没有」的稳定信号 ────────────────────────
const functionIds = new WeakMap<MarkdownTransformer, number>();
let functionIdCounter = 0;

function functionId(transformer: MarkdownTransformer): number {
  const existing = functionIds.get(transformer);
  if (existing !== undefined) return existing;
  functionIdCounter += 1;
  functionIds.set(transformer, functionIdCounter);
  return functionIdCounter;
}

export function fingerprintTransformers(transformers: MarkdownTransformer[]): string {
  return transformers.map((transformer) => functionId(transformer)).join(".");
}

/** 从一串转换器构造链（空数组 → null，调用方据此零成本跳过）。 */
export function createMarkdownTransformerChain(
  transformers: MarkdownTransformer[],
): MarkdownTransformerChain | null {
  if (transformers.length === 0) return null;
  return { transformers, fingerprint: fingerprintTransformers(transformers) };
}

// ── 链缓存（按 cwd/agentDir，与扩展加载缓存同 TTL）─────────────────────────
interface ChainCacheState {
  entries: Map<string, { chain: MarkdownTransformerChain | null; expiresAt: number }>;
  inFlight: Map<string, Promise<MarkdownTransformerChain | null>>;
  generation: number;
}

declare global {
  var __piPidanceMarkdownTransformerCache: ChainCacheState | undefined;
  var __piPidanceMarkdownTransformMemo: Map<string, string> | undefined;
}

export const MARKDOWN_TRANSFORMER_CACHE_TTL_MS = 30_000;

/** 单条消息记忆化的上限（投影窗口有限，正常远不到；有界只为防插件把 API 当循环用）。 */
export const MARKDOWN_TRANSFORM_MEMO_MAX = 2_000;

function chainCacheState(): ChainCacheState {
  if (!globalThis.__piPidanceMarkdownTransformerCache) {
    globalThis.__piPidanceMarkdownTransformerCache = {
      entries: new Map(),
      inFlight: new Map(),
      generation: 0,
    };
  }
  return globalThis.__piPidanceMarkdownTransformerCache;
}

function memoState(): Map<string, string> {
  if (!globalThis.__piPidanceMarkdownTransformMemo) {
    globalThis.__piPidanceMarkdownTransformMemo = new Map();
  }
  return globalThis.__piPidanceMarkdownTransformMemo;
}

/**
 * 失效入口：插件安装/卸载、测试复位时调用。
 *
 * 同时清掉链缓存与单条消息记忆化，**并把共享的扩展加载缓存一起失效** —— 只清本模块的链
 * 缓存是不够的：下一次解析会从那份更外层的缓存里拿到**旧插件代码**，链看起来重建了、其实没变。
 */
/**
 * 转换器链的世代号：每次 `invalidateMarkdownTransformCache()` 自增。
 *
 * 给**活宿主**用：它缓存了一份解析好的链（流式路径是同步的，没法每次都 await），
 * 失效之后必须知道"手里这份已经过期"，否则卸载插件后还会继续改写新消息。
 */
export function markdownTransformerGeneration(): number {
  return chainCacheState().generation;
}

/**
 * 失效通知：活宿主**缓存**了一份解析好的链（流式路径是同步的，来不及 await），
 * 失效时它必须知道手里那份已经过期。宿主在 start 时订阅、destroy 时退订。
 *
 * 只是「去重解析」的通知：本身不解析，收到的一方各自按自己的 cwd 重解析
 * （同一 cwd 的在途解析由 resolveMarkdownTransformerChain 合流，不会重复加载扩展）。
 */
const invalidationListeners = new Set<() => void>();

export function onMarkdownTransformerInvalidate(listener: () => void): () => void {
  invalidationListeners.add(listener);
  return () => {
    invalidationListeners.delete(listener);
  };
}

export function invalidateMarkdownTransformCache(): void {
  const state = globalThis.__piPidanceMarkdownTransformerCache;
  if (state) {
    state.entries.clear();
    state.inFlight.clear();
    state.generation += 1;
  }
  globalThis.__piPidanceMarkdownTransformMemo?.clear();
  invalidateLoadedExtensionsCache();
  // 通知活宿主：它们手里缓存的链已经过期（见 onMarkdownTransformerInvalidate）。
  for (const listener of [...invalidationListeners]) {
    try {
      listener();
    } catch {
      /* 单个订阅者出错不影响失效本身 */
    }
  }
}

/**
 * 解析该 (cwd, agentDir) 的转换器链：没有插件注册 → **null**（调用方不付任何代价）。
 * 加载失败同样 null（只读投影失败要安全降级，绝不抛给调用方）。
 */
export async function resolveMarkdownTransformerChain(
  options: MarkdownTransformerChainOptions,
): Promise<MarkdownTransformerChain | null> {
  const key = `${options.cwd}\0${options.agentDir ?? ""}`;
  const state = chainCacheState();
  if (!options.bypassCache) {
    const cached = state.entries.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.chain;
    if (cached) state.entries.delete(key);
    const existing = state.inFlight.get(key);
    if (existing) return existing;
  }

  const generationAtStart = state.generation;
  const loading = Promise.resolve()
    .then(() => loadExtensionsForCwd({
      cwd: options.cwd,
      agentDir: options.agentDir,
      loaderFactory: options.loaderFactory,
      bypassCache: options.bypassCache,
    }))
    .then((loaded) => (loaded.ok ? createMarkdownTransformerChain(collectMarkdownTransformers(loaded.value.extensions)) : null))
    .catch(() => null)
    .then((chain) => {
      if (!options.bypassCache && state.generation === generationAtStart) {
        state.entries.set(key, { chain, expiresAt: Date.now() + MARKDOWN_TRANSFORMER_CACHE_TTL_MS });
      }
      return chain;
    })
    .finally(() => {
      if (state.inFlight.get(key) === loading) state.inFlight.delete(key);
    });

  if (!options.bypassCache) state.inFlight.set(key, loading);
  return loading;
}

/**
 * 一次转换（带记忆化）。
 *
 * 缓存键按需求写全：**链指纹 + 消息 id + 内容 hash + availableWidth + isStreaming + messageType**。
 * 内容变了（hash 不同）、窗口宽度变了、流式状态变了、换了插件 —— 任意一项不同都不会命中旧值。
 */
export function transformMarkdownOnce(options: {
  chain: MarkdownTransformerChain;
  messageId: string;
  markdown: string;
  context: MarkdownTransformContext;
  useCache?: boolean;
}): string {
  const { chain, messageId, markdown, context } = options;
  if (options.useCache === false) {
    return applyMarkdownTransformers(markdown, context, chain.transformers);
  }
  const key = [
    chain.fingerprint,
    messageId,
    hashContent(markdown),
    context.availableWidth,
    context.isStreaming ? "1" : "0",
    context.messageType,
  ].join("\0");
  const memo = memoState();
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const result = applyMarkdownTransformers(markdown, context, chain.transformers);
  // 有界：满了先清空（投影窗口不大，正常永远到不了；清空比 LRU 简单且不会漏失效）。
  if (memo.size >= MARKDOWN_TRANSFORM_MEMO_MAX) memo.clear();
  memo.set(key, result);
  return result;
}

/** FNV-1a：只为「内容变了没有」，不需要密码学强度。 */
export function hashContent(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

// ── 渲染边界的变换（两条路径共用同一套按消息规则）──────────────────────────
//
// 调用点是**两条**渲染边界：
// 1. 已落盘的投影窗口（分页后的那一段 / 首屏尾页）—— 见 session-service；
// 2. **流式消息**（SSE 的 message_start / message_update / message_end）—— 见 sdk-session-host。
//    进行中的助手消息还没入库，投影窗口里根本没有它，所以这条必须单独接。

/** 只读取变换需要的字段，避免依赖具体消息类型。 */
interface MarkdownMessageLike {
  role?: unknown;
  content?: unknown;
}

function transformContentBlock(
  block: unknown,
  context: MarkdownTransformContext,
  options: { chain: MarkdownTransformerChain; messageId: string; useCache: boolean },
): { block: unknown; changed: boolean } {
  const record = asRecord(block);
  if (!record) return { block, changed: false };
  if (record.type === "text" && typeof record.text === "string") {
    // 与 TUI 的一处差别（有意，见文件头的分块说明）：TUI 渲染前会 `trim()` 正文并跳过空白块，
    // 这里**只跳过空白块**、不 trim —— 投影出来的 text 同时还要给复制/摘录用，trim 会悄悄改内容。
    if (record.text.trim() === "") return { block, changed: false };
    const next = transformMarkdownOnce({
      chain: options.chain,
      messageId: options.messageId,
      markdown: record.text,
      context,
      useCache: options.useCache,
    });
    return next === record.text ? { block, changed: false } : { block: { ...record, text: next }, changed: true };
  }
  // 思考块：`thinking` 是正文；延迟加载（deferred）时正文为空，这里不动，
  // 由按需加载思考正文的那条路径（getEntryThinking）负责转换。
  if (record.type === "thinking" && typeof record.thinking === "string" && record.thinking !== "") {
    const next = transformMarkdownOnce({
      chain: options.chain,
      messageId: options.messageId,
      markdown: record.thinking,
      context,
      useCache: options.useCache,
    });
    return next === record.thinking
      ? { block, changed: false }
      : { block: { ...record, thinking: next }, changed: true };
  }
  return { block, changed: false };
}

export interface TransformMessageOptions {
  chain: MarkdownTransformerChain;
  availableWidth: number;
  /**
   * 这条消息是否正在流式输出（SDK 调用点：流式每帧 true，结束那一帧 false）。
   * 与 SDK 一致：**用户消息恒 false**（`user-message.js` 传的是字面量 false）。
   */
  isStreaming: boolean;
  /** 记忆化用的消息 id；不给就用 `#stream`（流式帧内容每帧都变，调用方应传 useCache: false）。 */
  messageId?: string;
  useCache?: boolean;
}

/**
 * 变换**一条消息**的 markdown 正文（用户消息 / 助手正文 / 助手思考）。
 *
 * - 用户消息 → `messageType: "user"`（`isStreaming` 恒 false）；助手正文 → `"assistant"`、
 *   助手思考 → `"assistant-thinking"`；
 * - 其它角色（toolResult / custom / bashExecution / branchSummary…）**不动**：
 *   SDK 也只转换用户与助手的 markdown；
 * - 没有任何改动时返回**原对象**（调用方据此跳过重发/重渲染）。
 *
 * **有意分块（与 TUI 的差别，写在文件头那节）**：TUI 把连续 thinking 用 `\n\n` 拼成一次转换、
 * 用户消息把全部 text 块拼成一个字符串再转。这里**逐块**转换，因为投影里的块与磁盘 entry 是
 * **按下标一一对应**的（`getEntryThinking(sessionId, entryId, blockIndex)` 就是按这个下标回读磁盘），
 * 把 N 块并成 1 块会让下标错位、按需加载的思考正文对不上；而一次转换后的整段文本也无法可靠拆回 N 块。
 * 单块消息（绝大多数）两条路径完全一致。
 */
export function transformMessageMarkdown(
  message: unknown,
  options: TransformMessageOptions,
): unknown {
  const record = asRecord(message) as MarkdownMessageLike | null;
  const role = record?.role;
  const messageId = options.messageId ?? "#stream";
  const useCache = options.useCache !== false;

  if (role === "user") {
    const contextUser: MarkdownTransformContext = {
      messageType: "user",
      isStreaming: false,
      availableWidth: options.availableWidth,
    };
    const content = record?.content;
    if (typeof content === "string") {
      const next = transformMarkdownOnce({ chain: options.chain, messageId, markdown: content, context: contextUser, useCache });
      return next === content ? message : { ...(message as object), content: next };
    }
    if (Array.isArray(content)) {
      let changed = false;
      const blocks = content.map((block) => {
        const result = transformContentBlock(block, contextUser, { chain: options.chain, messageId, useCache });
        if (result.changed) changed = true;
        return result.block;
      });
      return changed ? { ...(message as object), content: blocks } : message;
    }
    return message;
  }

  if (role === "assistant" && Array.isArray(record?.content)) {
    let changed = false;
    const blocks = record.content.map((block) => {
      const blockRecord = asRecord(block);
      const type = blockRecord?.type === "thinking" ? "assistant-thinking" : "assistant";
      const result = transformContentBlock(
        block,
        { messageType: type, isStreaming: options.isStreaming, availableWidth: options.availableWidth },
        { chain: options.chain, messageId, useCache },
      );
      if (result.changed) changed = true;
      return result.block;
    });
    return changed ? { ...(message as object), content: blocks } : message;
  }

  return message;
}

/**
 * 变换一个**已经切片好的**投影上下文（分页窗口 / 首屏尾页）。
 *
 * 只处理窗口内的消息，且**不声称任何一条在流式输出**：进行中的助手消息还没入库、
 * 根本不在窗口里，窗口末尾通常是刚落盘的用户消息或上一条已结束的助手消息 ——
 * 把"整轮 run 在跑"当成"这条 entry 在流式"会把它错标成流式。
 * 真正的流式正文走 SSE 那条路径（见 transformMessageMarkdown 的调用点）。
 *
 * - 只在给定窗口内工作（不做第二次扫盘、不碰 leaf 之外的 entry）；
 * - 没有任何改动时返回**原对象**（避免无谓的重渲染与内存开销）。
 */
export function transformContextMarkdown<C>(
  context: C,
  options: {
    chain: MarkdownTransformerChain;
    availableWidth: number;
    useCache?: boolean;
  },
): C {
  const messages = (context as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return context;
  const entryIds = (context as { entryIds?: unknown }).entryIds;
  const useCache = options.useCache !== false;
  let changedAny = false;

  const nextMessages = messages.map((message, index) => {
    const entryId = Array.isArray(entryIds) && typeof entryIds[index] === "string"
      ? (entryIds[index] as string)
      : `#${index}`;
    const next = transformMessageMarkdown(message, {
      chain: options.chain,
      availableWidth: options.availableWidth,
      isStreaming: false,
      messageId: entryId,
      useCache,
    });
    if (next !== message) changedAny = true;
    return next;
  });

  if (!changedAny) return context;
  return { ...(context as object), messages: nextMessages } as C;
}
