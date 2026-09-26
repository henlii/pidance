/**
 * Kitty 图形协议序列 → 结构化图片（issue #104）。
 *
 * 为什么需要这一层：pi-tui 的 `Image` 组件在**有图片能力**时把整张图编码成一条
 * `\x1b_G…\x1b\\` 序列（可能分多块，见 `terminal-image.js` 的 `encodeKitty`），
 * 并把它当作**渲染出来的第一行**、后面补 `rows-1` 个空行占位。
 * 本仓库的渲染桥随后要过「行数 / 单行长度 / 总字符」三道上限，而一张图的 base64
 * 轻易就超过「单行 4000 字符」与「总计 200KB」——不先把图摘出来，**整段渲染**
 * （包括旁边的正常文本）会被一起判为超限而丢弃。
 *
 * 所以顺序是：渲染 → 摘图（本模块）→ 文本再过上限。摘出来的图随渲染结果一起下发，
 * 客户端用真 `<img>` 画；文本侧把那条序列换成空行（或降级说明），行序与终端一致。
 *
 * 协议事实（对照 `pi-tui/dist/terminal-image.js` 的 `encodeKitty` / `deleteKittyImage`）：
 *   `\x1b_G<params>;<base64>\x1b\\`，params 是逗号分隔的 `k=v`；
 *   - `a=T` 传输并显示；`a=d` 删除（`d=I|A|a` 决定释放范围）；`a=p` 只放置无载荷；
 *   - `f=100` 固定表示 PNG（**mime 不在序列里**，只能按这个判）；
 *   - `i=<id>` 图片 id（我们用它把分块拼起来）；
 *   - `c=` / `r=` 是列/行数（组件算好后才带上，缺失时按 1 处理）；
 *   - `m=1` 表示「还有后续块」，`m=0` 表示最后一块；**首块带全部参数**，
 *     中间块只有 `m=1`、末块只有 `m=0`。
 */

/** 单张图片的 base64 上限。
 *
 * 依据：终端截图类图片（pi-tui 默认按 800×600 估尺寸）编码后通常几十到几百 KB；
 * 4MB base64（≈3MB 二进制）能容纳一张 4K 截屏，同时把「一次渲染能带多少数据」
 * 限制在 JSON/SSE 可以轻松承载的量级（仓库里 proxyClientMaxBodySize 是 512MB，
 * 但单条消息不该以 MB 计）。超过就降级成可见说明，不整段丢弃。 */
export const MAX_KITTY_IMAGE_BASE64 = 4 * 1024 * 1024;

/** 一次渲染里所有图片的 base64 合计上限（防止一个组件塞很多张图）。 */
export const MAX_KITTY_TOTAL_BASE64 = 8 * 1024 * 1024;

/** 图片 id 缺失时用的回退 id（正常情况下 pi-tui 一定会带 `i=`）。 */
const FALLBACK_IMAGE_ID = "image";

/** 一条图形序列：`\x1b_G…\x1b\\`。 */
const KITTY_PREFIX = "\x1b_G";
const KITTY_TERMINATOR = "\x1b\\";

/** 图片被降级的原因（可见降级，不是静默丢弃）。 */
export type RenderedImageFallbackReason =
  | "too-large"
  | "unsupported-format"
  | "incomplete"
  | "empty";

/** 一张可从渲染结果里还原出来的图片。 */
export interface RenderedImage {
  /** Kitty 图片 id（`i=`）；同一次渲染内唯一。 */
  id: string;
  /** 由 `f=` 推出来的 mime（只有 PNG 可判，其余走降级）。 */
  mime: string;
  base64: string;
  /** 终端里占的列/行数（`c=`/`r=`，缺失时 1）。 */
  cols: number;
  rows: number;
  /** 图片起点在 `lines` 里的下标（0 基）——客户端按它把 `<img>` 放回原位。 */
  lineIndex: number;
}

/** 没还原成图片的那条序列所占的位置（客户端渲染一句本地化说明）。 */
export interface RenderedImageFallback {
  lineIndex: number;
  reason: RenderedImageFallbackReason;
}

export interface ExtractedKittyImages {
  /** 文本行：图片序列已被摘走（原位置留空行，后端会补 `rows-1` 个空行占位）。 */
  lines: string[];
  images: RenderedImage[];
  /** 摘不出来的图片位置（客户端按 i18n 文案渲染可见说明）。 */
  fallbacks: RenderedImageFallback[];
}

interface ParsedSequence {
  params: Map<string, string>;
  payload: string;
}

interface PendingImage {
  id: string;
  params: Map<string, string>;
  chunks: string[];
  size: number;
}

function parseIntParam(params: Map<string, string>, key: string): number | null {
  const raw = params.get(key);
  if (raw === undefined) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** `f=100` → PNG；其余格式码（RGB/RGBA 裸数据）在本项目里无法作为 `<img>` 显示。 */
function mimeFromFormat(params: Map<string, string>): string | null {
  const format = params.get("f");
  if (format === undefined || format === "100") return "image/png";
  return null;
}

/** 宽松的 base64 校验：只认标准字母表与 `=` 补位（坏载荷不该被当成图片发下去）。 */
function isLikelyBase64(value: string): boolean {
  if (value.length === 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

/**
 * 从一行里切出所有图形序列。
 *
 * 返回「去掉序列后的行」与解析结果；没有序列时 `head === null`（调用方走快路径，不复制字符串）。
 */
function splitSequences(line: string): { rest: string; sequences: ParsedSequence[] } | null {
  let index = line.indexOf(KITTY_PREFIX);
  if (index === -1) return null;
  let rest = "";
  const sequences: ParsedSequence[] = [];
  let cursor = 0;
  for (;;) {
    index = line.indexOf(KITTY_PREFIX, cursor);
    if (index === -1) {
      rest += line.slice(cursor);
      break;
    }
    rest += line.slice(cursor, index);
    const bodyStart = index + KITTY_PREFIX.length;
    const end = line.indexOf(KITTY_TERMINATOR, bodyStart);
    if (end === -1) {
      // 没有终止符：后面这段不是完整序列，原样留作文本（宁可显示乱码也不吞掉内容）。
      rest += line.slice(index);
      break;
    }
    const body = line.slice(bodyStart, end);
    const semicolon = body.indexOf(";");
    const rawParams = semicolon === -1 ? body : body.slice(0, semicolon);
    const payload = semicolon === -1 ? "" : body.slice(semicolon + 1);
    const params = new Map<string, string>();
    for (const part of rawParams.split(",")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      params.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
    sequences.push({ params, payload });
    cursor = end + KITTY_TERMINATOR.length;
  }
  return { rest, sequences };
}
/**
 * 把渲染出来的行摘成「文本行 + 图片」。
 *
 * 规则：
 * - 分块按 `i=` 归并，`m=1` 累积、`m=0`（或缺 `m`）结算；
 * - 删除指令（`a=d`）与「只放置无载荷」（`a=p`）不产出图片；
 * - 结算时校验格式、体积与 base64 形状；任一条不过 → 该位置记一条 fallback；
 * - 渲染结束时仍未收到 `m=0` 的分块 → `incomplete`（不显示半张图）。
 */
export function extractKittyImages(lines: string[]): ExtractedKittyImages {
  const outLines: string[] = [];
  const images: RenderedImage[] = [];
  const fallbacks: RenderedImageFallback[] = [];
  const pending = new Map<string, PendingImage>();
  /** 正在传输中的图片（分块续块**不带 `i=`**，只能靠这个状态归并，见协议）。 */
  let open: PendingImage | null = null;
  let total = 0;

  const settle = (lineIndex: number, entry: PendingImage, hasMore: boolean) => {
    if (hasMore) return;
    pending.delete(entry.id);
    const mime = mimeFromFormat(entry.params);
    const base64 = entry.chunks.join("");
    if (base64.length === 0) {
      fallbacks.push({ lineIndex, reason: "empty" });
      return;
    }
    if (mime === null) {
      fallbacks.push({ lineIndex, reason: "unsupported-format" });
      return;
    }
    if (!isLikelyBase64(base64)) {
      fallbacks.push({ lineIndex, reason: "unsupported-format" });
      return;
    }
    if (entry.size > MAX_KITTY_IMAGE_BASE64 || total + entry.size > MAX_KITTY_TOTAL_BASE64) {
      // 记在 fallback 里换可见说明：超限时**不**把文本也一起丢掉。
      fallbacks.push({ lineIndex, reason: "too-large" });
      return;
    }
    total += entry.size;
    images.push({
      id: entry.id,
      mime,
      base64,
      cols: parseIntParam(entry.params, "c") ?? 1,
      rows: parseIntParam(entry.params, "r") ?? 1,
      lineIndex,
    });
  };

  lines.forEach((line, lineIndex) => {
    const split = typeof line === "string" ? splitSequences(line) : null;
    if (!split) {
      outLines.push(line);
      return;
    }
    for (const sequence of split.sequences) {
      const action = sequence.params.get("a");
      const hasMore = sequence.params.get("m") === "1";
      if (action === "d" || action === "p") continue;
      const explicitId = sequence.params.get("i");
      let entry: PendingImage;
      if (explicitId !== undefined) {
        // 显式 id：新的一次传输（同 id 重传也按新图处理），参数以它为最新。
        entry = { id: explicitId, params: sequence.params, chunks: [], size: 0 };
        pending.set(entry.id, entry);
      } else if (open) {
        // 续块：不带 i=，归属**当前正在传输**的那张图（参数沿用首块）。
        entry = open;
      } else {
        entry = { id: FALLBACK_IMAGE_ID, params: sequence.params, chunks: [], size: 0 };
        pending.set(entry.id, entry);
      }
      if (sequence.payload.length > 0) {
        entry.chunks.push(sequence.payload);
        entry.size += sequence.payload.length;
      }
      open = hasMore ? entry : null;
      settle(lineIndex, entry, hasMore);
    }
    // 序列被摘走后，原位置留空行；同一行里剩下的文字（罕见）保留。
    outLines.push(split.rest);
  });

  // 渲染结束还没结算的：分块不完整（没有 m=0），不显示半张图。
  for (const entry of pending.values()) {
    const lineIndex = outLines.length - 1;
    fallbacks.push({ lineIndex: Math.max(0, lineIndex), reason: "incomplete" });
  }

  return { lines: outLines, images, fallbacks };
}

/**
 * 两组图片是否完全相同。
 *
 * 用途：插件界面每次重渲都会推一帧，而 base64 很容易是几百 KB —— 图片没变时**不该重发**
 * （调用方据此省略字段，客户端保留上一帧的图片）。逐字段比较字符串，不额外分配。
 */
export function sameRenderedImages(
  previous: RenderedImage[] | undefined,
  next: RenderedImage[],
): boolean {
  if (!previous || previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    const before = previous[index];
    const after = next[index];
    if (
      before.id !== after.id
      || before.mime !== after.mime
      || before.base64 !== after.base64
      || before.lineIndex !== after.lineIndex
      || before.rows !== after.rows
      || before.cols !== after.cols
    ) return false;
  }
  return true;
}

/** 降级说明列表是否完全相同（理由与 sameRenderedImages 相同：没变就不重发）。 */
export function sameImageFallbacks(
  previous: RenderedImageFallback[] | undefined,
  next: RenderedImageFallback[],
): boolean {
  if (!previous || previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index].lineIndex !== next[index].lineIndex || previous[index].reason !== next[index].reason) {
      return false;
    }
  }
  return true;
}

/**
 * 把「有图片但消费方不支持图片」的输出降级成纯文本行：每个图片/降级位置换成一句说明。
 *
 * 给旧接口的薄包装用（它们只返回 `string[]`）——保持行数不变，并在原来的位置
 * 留下**可见**的说明，而不是一个空白行（静默丢弃是明确被禁止的降级方式）。
 */
export function withImageFallbackLines(
  output: { lines: string[]; images: RenderedImage[]; fallbacks: RenderedImageFallback[] },
): string[] {
  if (output.images.length === 0 && output.fallbacks.length === 0) return output.lines;
  const lines = [...output.lines];
  // 追加而不是整行覆盖：序列与文字同处一行时（少见但合法），剩下的文字不能被吃掉。
  const mark = (lineIndex: number, text: string) => {
    const current = lines[lineIndex];
    if (current === undefined) return;
    lines[lineIndex] = current === "" ? text : `${current} ${text}`;
  };
  for (const image of output.images) mark(image.lineIndex, `[image: ${image.mime}]`);
  for (const fallback of output.fallbacks) mark(fallback.lineIndex, `[image unavailable: ${fallback.reason}]`);
  return lines;
}
