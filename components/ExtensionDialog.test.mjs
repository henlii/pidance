import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

const { ExtensionDialog, dialogRemainingSeconds } = await jiti.import("./ExtensionDialog.tsx");
const { I18nProvider } = await jiti.import("../lib/i18n.tsx");

const sourcePath = fileURLToPath(new URL("./ExtensionDialog.tsx", import.meta.url));
const source = readFileSync(sourcePath, "utf8");

function request(method, fields = {}) {
  return {
    type: "extension_ui_request",
    id: fields.id ?? "req-1",
    method,
    title: fields.title ?? "请选择",
    ...fields,
  };
}

function renderCard(props) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ExtensionDialog, props),
    ),
  );
}

// ── SSR / source contract（对齐 TUI 原生 select：纯列表 + 点击即返回）─────────

test("SSR select：纯选项列表，无 Submit、无 Other 输入框，保留 Cancel", () => {
  const html = renderCard({
    request: request("select", { options: ["一", "二", "3. Type something."] }),
    onRespond: () => {},
  });

  assert.ok(html.includes("一"));
  assert.ok(html.includes("二"));
  // 哨兵是普通选项：原样展示，不被特殊化为输入框
  assert.ok(html.includes("3. Type something."));
  // 无 locale 附加 Other 项、无 textarea（无手动输入框）、无 Submit 按钮
  assert.ok(!html.includes(">Other<"));
  assert.ok(!html.includes(">其他<"));
  assert.ok(!html.includes("<textarea"));
  assert.ok(!html.includes("aria-label=\"Submit\""));
  assert.ok(!html.includes("aria-label=\"提交\""));
  // Cancel 保留（对应 TUI Esc 取消）
  assert.ok(html.includes("aria-label=\"Cancel\"") || html.includes("aria-label=\"取消\""));
  // 选项点击即返回（对齐 TUI extension-selector 的 Enter 即返回）
  assert.ok(source.includes("respondOnce({ value: option })"));
});

test("SSR select：空 options 时仅保留 Cancel，不崩溃", () => {
  const html = renderCard({
    request: request("select", { options: [] }),
    onRespond: () => {},
  });
  assert.ok(html.includes("aria-label=\"Cancel\"") || html.includes("aria-label=\"取消\""));
});

test("SSR confirm：原交互保留 Cancel + Confirm", () => {
  const html = renderCard({
    request: request("confirm", { message: "确认继续？" }),
    onRespond: () => {},
  });
  assert.ok(html.includes("确认继续？"));
  assert.ok(html.includes("aria-label=\"Cancel\"") || html.includes("aria-label=\"取消\""));
  assert.ok(html.includes("aria-label=\"Confirm\"") || html.includes("aria-label=\"确认\""));
});

test("SSR input：原交互保留 input + Submit/Cancel", () => {
  const html = renderCard({
    request: request("input", { placeholder: "输入内容" }),
    onRespond: () => {},
  });
  assert.ok(html.includes("input"));
  assert.ok(html.includes("placeholder=\"输入内容\""));
  assert.ok(html.includes("aria-label=\"Submit\"") || html.includes("aria-label=\"提交\""));
  assert.ok(html.includes("aria-label=\"Cancel\"") || html.includes("aria-label=\"取消\""));
});

test("SSR editor：textarea + Submit/Cancel，prefill 回填", () => {
  const html = renderCard({
    request: request("editor", { prefill: "草稿内容" }),
    onRespond: () => {},
  });
  assert.ok(html.includes("<textarea"));
  assert.ok(html.includes("草稿内容"));
  assert.ok(html.includes("aria-label=\"Submit\"") || html.includes("aria-label=\"提交\""));
  assert.ok(html.includes("aria-label=\"Cancel\"") || html.includes("aria-label=\"取消\""));
});

test("source contract：respondOnce 每 id 一次、无卸载 effect 响应、无多题协议", () => {
  // respondOnce 有幂等守卫（respondedRequestRef）
  assert.ok(source.includes("respondedRequestRef.current === boundRequestId"));
  // 没有任何「自动响应」的 effect：onRespond 只在 respondOnce 里被调用一次。
  // 不能用 /useEffect[\s\S]*onRespond/ 这种位置型断言 —— 倒计时 effect 在它之前，会误报。
  assert.equal((source.match(/onRespond\(/g) ?? []).length, 1, "onRespond 只应在 respondOnce 里调用");
  assert.match(source, /const respondOnce = \(response[\s\S]*?onRespond\(response\);/);
  // 无多题/步骤字段
  const html = renderCard({
    request: request("select", { options: ["一"] }),
    onRespond: () => {},
  });
  assert.doesNotMatch(html, /questions|answers|queue|Next|步骤/);
});

test("source contract：inert 覆盖 disabled/expired/responded", () => {
  assert.ok(source.includes("const inert = disabled || expired || responded;"));
});

test("SSR/source：面板与输入框同宽同中线，内容区可滚动", () => {
  const html = renderCard({
    request: request("select", { options: ["一"] }),
    onRespond: () => {},
  });
  // 宽度改由共享的 CSS 变量表达式给出（min(var(--pidance-chat-column-width, 兜底), 100%)）
  assert.match(html, /width:min\(var\(--pidance-chat-column-width, \d+px\), 100%\)/, "面板未使用与输入框一致的宽度（取自共享表达式）");
  assert.ok(!html.includes("min(560px, 100%)"), "面板仍保留旧的窄栏宽度");
  assert.ok(html.includes("extension-panel-body"), "内容区走 GUI 外壳滚动区");
  assert.ok(html.includes("extension-panel-footer"), "操作区固定在面板底部");
  // 面板自身不再带 padding：由 ChatWindow 按输入框同款内边距与 820 宽度包裹
  const chatWindow = readFileSync(fileURLToPath(new URL("./ChatWindow.tsx", import.meta.url)), "utf8");
  const block = chatWindow.slice(
    chatWindow.indexOf("const chatInputElement"),
    chatWindow.indexOf("const aboveEditorWidgets"),
  );
  assert.ok(block.includes("CHAT_INPUT_SIDE_PADDING"), "扩展面板未按输入框同款内边距包裹");
  assert.ok(block.includes("maxWidth: CHAT_COLUMN_MAX_WIDTH_CSS"), "扩展面板未按输入框同款宽度包裹");
});

// ── 提问区可读性：右上「关闭」只留给非 select；面板可展开/收回 ────────────────

test("SSR：标题行不再有任何「关闭/收起」按钮，取消留在底栏", () => {
  for (const req of [request("select", { options: ["一"] }), request("input", { placeholder: "写点什么" })]) {
    const html = renderCard({ request: req, onRespond: () => {} });
    assert.ok(!/>关闭</.test(html) && !/>Close</.test(html), `${req.method} 仍渲染「关闭」按钮`);
    assert.ok(!/aria-label="关闭"/.test(html), `${req.method} 的「关闭」按钮仍在 DOM 里`);
    // 「收起/展开」也不再是按钮：整行标题就是开关
    assert.ok(!/>收回</.test(html) && !/>Collapse</.test(html), `${req.method} 仍渲染「收回」按钮`);
    assert.ok(/aria-label="取消"|aria-label="Cancel"/.test(html), `${req.method} 丢了底栏「取消」`);
  }
});

test("SSR：面板带展开/收回开关，默认展开（可收回）", () => {
  const html = renderCard({
    request: request("select", { options: ["一"] }),
    onRespond: () => {},
  });
  assert.match(html, /aria-expanded="true"/, "缺展开开关的初始态");
  assert.ok(/aria-label="收回"|aria-label="Collapse"/.test(html), "默认展开时标题行应标为可收回");
  assert.ok(html.includes("extension-panel-shell--expanded"), "默认应为展开态（长提问默认能看全）");
  assert.ok(!/aria-label="展开"/.test(html), "展开文案只在收回后出现");
  // 整行标题就是开关：header 上带 role=button + aria-expanded（不再靠独立按钮）
  assert.match(html, /class="extension-panel-header"[^>]*role="button"/, "标题行不是折叠开关");
});

test("CSS 契约：提问区可滚、展开态提高高度上限（含窄屏规则）", () => {
  const css = readFileSync(fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8");
  // 规则从行首开始才是基础规则（避免匹配到 `.extension-panel-shell--expanded .extension-panel-title`）
  const titleMatch = /^\.extension-panel-title \{([^}]*)\}/m.exec(css);
  assert.ok(titleMatch, "找不到 .extension-panel-title");
  const titleRule = titleMatch[1];
  assert.match(titleRule, /overflow-y:\s*auto/, "提问区（标题）不可滚动 —— 长提问会被外壳裁掉");
  assert.match(titleRule, /max-height:\s*min\(30vh, 240px\)/, "提问区缺高度上限");
  assert.match(css, /\.extension-panel-shell--expanded\s*\{\s*max-height:\s*min\(78vh, 900px\)/, "缺展开态高度");
  // 展开必须同时抬高提问区上限，否则长提问仍停在收起态的小滚动区里
  assert.match(css, /\.extension-panel-shell--expanded \.extension-panel-title\s*\{\s*max-height:\s*60vh/, "展开态未抬高提问区上限");
  assert.ok(
    css.includes("calc(100dvh - 96px - env(safe-area-inset-top) - env(safe-area-inset-bottom))"),
    "缺窄屏展开态高度（移动端展开后要顶到视口可用高度）",
  );
});

// ── Issue #100：对话框超时倒计时 ─────────────────────────────────────────────

test("#100 dialogRemainingSeconds：向上取整、过期归零、没有绝对时刻返回 null", () => {
  assert.equal(dialogRemainingSeconds(1_000_000 + 5_000, 1_000_000), 5, "剩余 5s");
  assert.equal(dialogRemainingSeconds(1_000_000 + 4_200, 1_000_000), 5, "不足 1s 也要向上取整");
  assert.equal(dialogRemainingSeconds(1_000_000 + 1, 1_000_000), 1);
  assert.equal(dialogRemainingSeconds(1_000_000, 1_000_000), 0, "到点即 0");
  assert.equal(dialogRemainingSeconds(1_000_000 - 5_000, 1_000_000), 0, "过期后不出现负数");
  for (const absent of [undefined, null, "100", NaN, Infinity]) {
    assert.equal(dialogRemainingSeconds(absent, 1_000_000), null, String(absent));
  }
});

test("#100 SSR：带 expiresAt 时显示剩余秒数，且读屏不播报每秒变化", () => {
  const html = renderCard({
    request: request("select", { options: ["一"], expiresAt: Date.now() + 60_000 }),
    onRespond: () => {},
  });
  assert.match(html, /剩余\s*\d+\s*秒|\d+s left/, "没有显示剩余秒数");
  assert.ok(html.includes('aria-live="off"'), "倒计时必须 aria-live=off（每秒变化不该被读屏播报）");
  // 未过期：不显示「已过期」状态
  assert.ok(!html.includes(">已过期<") && !html.includes(">Expired<"));
});

test("#100 SSR：已过期时给「已过期」状态并禁用按钮（客户端不自己关面板）", () => {
  const html = renderCard({
    request: request("confirm", { message: "确认？", expiresAt: Date.now() - 1_000 }),
    onRespond: () => {},
  });
  assert.ok(html.includes(">已过期<") || html.includes(">Expired<"), "缺少已过期状态");
  assert.ok(html.includes("disabled"), "过期后按钮必须禁用（宿主已按取消结算）");
  // 过期时不再显示倒计时数字。两种语言都要断言：SSR 默认语言是 en（lib/i18n.tsx），
  // 只排除中文的话这条断言在默认路径上恒真（审查发现）。
  assert.doesNotMatch(html, /剩余\s*\d+\s*秒/, "过期后不该再显示倒计时（中文）");
  assert.doesNotMatch(html, /\d+\s*s left/, "过期后不该再显示倒计时（英文，SSR 默认语言）");
});

// 审查修复：本端不能回答（只读 / 会话被对端写持有）时过去完全看不到倒计时，
// 而那时用户最需要知道宿主什么时候把它收走。底栏右侧只放一个元素。
test("#100 SSR 审查修复：disabled（本端不能回答）时也显示剩余秒数", () => {
  const html = renderCard({
    request: request("select", { options: ["一"], expiresAt: Date.now() + 60_000 }),
    disabled: true,
    onRespond: () => {},
  });
  assert.match(html, /剩余\s*\d+\s*秒|\d+s left/, "本端不能回答时也要能看到宿主何时收回面板");
  assert.doesNotMatch(html, /等待结束|Waiting ended/, "有倒计时时不再叠加状态文案（两者都是 margin-left:auto）");
  assert.ok(html.includes("disabled"), "按钮仍然禁用");
});

test("#100 SSR 审查修复：disabled 且没有倒计时 → 仍是「等待结束」", () => {
  const html = renderCard({
    request: request("select", { options: ["一"] }),
    disabled: true,
    onRespond: () => {},
  });
  assert.match(html, /等待结束|Waiting ended/, "没有超时的阻塞面板仍要说明为什么点不动");
  assert.doesNotMatch(html, /剩余|s left/, "没有 expiresAt 就不该有倒计时");
});

test("#100 SSR：没有 expiresAt（宿主没给 timeout）时完全不显示倒计时", () => {
  const html = renderCard({
    request: request("input", { placeholder: "占位" }),
    onRespond: () => {},
  });
  assert.doesNotMatch(html, /剩余|s left/, "未传 timeout 不该出现倒计时");
  assert.ok(!html.includes(">已过期<") && !html.includes(">Expired<"));
});

test("#100 source contract：倒计时自己走且隐藏标签页不重渲", () => {
  assert.ok(source.includes("setInterval(tick, 1000)"), "倒计时必须有计时器（只靠状态轮询会晚一个周期）");
  assert.ok(
    source.includes('document.visibilityState === "hidden"'),
    "隐藏标签页不该重渲（多端约定）",
  );
  assert.ok(source.includes('addEventListener("visibilitychange"'), "可见时要补算一次剩余时间");
  assert.ok(source.includes("dialogRemainingSeconds(expiresAt, now)"), "剩余秒数必须每次重算，不能自己递减");
  assert.ok(!/remainingSeconds\s*-=|remainingSeconds--/.test(source), "不能自己递减（挂起/节流后会漂移）");
});
