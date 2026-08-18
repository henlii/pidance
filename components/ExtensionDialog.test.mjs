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

const {
  createInlineSelectState,
  resolveInlineSelectState,
  selectInlineOption,
  selectInlineOther,
  setInlineOtherDraft,
  getInlineSelectSubmission,
  canSubmitInlineSelect,
  isOtherOptionLabel,
  shouldAppendOtherOption,
  ExtensionDialog,
} = await jiti.import("./ExtensionDialog.tsx");
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

// ── 纯状态 helper ──────────────────────────────────────────────────────────

test("select 暂存：点击 option 只更新 selectedValue，不提交", () => {
  let state = createInlineSelectState("r1");
  assert.equal(getInlineSelectSubmission(state), null);
  assert.equal(canSubmitInlineSelect(state), false);

  state = selectInlineOption(state, "苹果");
  assert.equal(state.selectedValue, "苹果");
  assert.equal(state.otherSelected, false);
  assert.deepEqual(getInlineSelectSubmission(state), { value: "苹果" });
  assert.equal(canSubmitInlineSelect(state), true);

  state = selectInlineOption(state, "香蕉");
  assert.equal(state.selectedValue, "香蕉");
  assert.deepEqual(getInlineSelectSubmission(state), { value: "香蕉" });
});

test("Other：trim 非空才能提交；空白 draft 不可提交", () => {
  let state = createInlineSelectState("r1");
  state = selectInlineOther(state);
  assert.equal(state.otherSelected, true);
  assert.equal(state.selectedValue, null);
  assert.equal(getInlineSelectSubmission(state), null);

  state = setInlineOtherDraft(state, "   ");
  assert.equal(getInlineSelectSubmission(state), null);
  assert.equal(canSubmitInlineSelect(state), false);

  state = setInlineOtherDraft(state, "  自定义  ");
  assert.deepEqual(getInlineSelectSubmission(state), { value: "自定义" });
});

test("option 与 Other 切换不误提交旧值", () => {
  let state = createInlineSelectState("r1");
  state = selectInlineOption(state, "A");
  assert.deepEqual(getInlineSelectSubmission(state), { value: "A" });

  state = selectInlineOther(state);
  state = setInlineOtherDraft(state, "自定义");
  // Other 选中后 selectedValue 清空，提交为 draft
  assert.equal(state.selectedValue, null);
  assert.deepEqual(getInlineSelectSubmission(state), { value: "自定义" });

  // 切回普通 option：otherSelected 关闭，提交为 option 值（draft 可残留但不参与）
  state = selectInlineOption(state, "B");
  assert.equal(state.otherSelected, false);
  assert.deepEqual(getInlineSelectSubmission(state), { value: "B" });

  // 再进 Other：draft 仍在但需 otherSelected 才生效
  state = selectInlineOther(state);
  assert.deepEqual(getInlineSelectSubmission(state), { value: "自定义" });
  state = setInlineOtherDraft(state, "");
  assert.equal(getInlineSelectSubmission(state), null);
});

test("request id 切换时 resolve 重置 selection/draft", () => {
  let state = createInlineSelectState("old");
  state = selectInlineOption(state, "旧选项");
  state = setInlineOtherDraft(selectInlineOther(state), "旧草稿");

  const resolved = resolveInlineSelectState(state, "new");
  assert.equal(resolved.requestId, "new");
  assert.equal(resolved.selectedValue, null);
  assert.equal(resolved.otherSelected, false);
  assert.equal(resolved.otherDraft, "");
  assert.equal(getInlineSelectSubmission(resolved), null);

  // 同 id 保留
  const same = resolveInlineSelectState(state, "old");
  assert.equal(same, state);
});

test("Other 标签识别与去重：Other/其他/输入内容/编号前缀", () => {
  assert.equal(isOtherOptionLabel("Other", "Other"), true);
  assert.equal(isOtherOptionLabel("OTHER", "Other"), true);
  assert.equal(isOtherOptionLabel("其他", "其他"), true);
  assert.equal(isOtherOptionLabel("  other  ", "Other"), true);
  assert.equal(isOtherOptionLabel("别的", "其他"), false);
  assert.equal(isOtherOptionLabel("别的", "别的"), true);
  assert.equal(isOtherOptionLabel("输入内容", "其他"), true);
  assert.equal(isOtherOptionLabel("4. 输入内容", "其他"), true);
  assert.equal(isOtherOptionLabel("4、输入内容", "其他"), true);
  assert.equal(isOtherOptionLabel("4. Type something.", "其他"), true);
  assert.equal(isOtherOptionLabel("在从事护理工作", "其他"), false);

  assert.equal(shouldAppendOtherOption(["A", "B"], "Other"), true);
  assert.equal(shouldAppendOtherOption(["A", "Other"], "Other"), false);
  assert.equal(shouldAppendOtherOption(["A", "其他"], "Other"), false);
  assert.equal(shouldAppendOtherOption(["A", "OTHER"], "Other"), false);
  assert.equal(shouldAppendOtherOption(["A", "别的"], "别的"), false);
  assert.equal(shouldAppendOtherOption(["1. A", "4. 输入内容"], "其他"), false);
});

// ── SSR / source contract ──────────────────────────────────────────────────

test("SSR select：option 为暂存按钮含 aria-pressed，底部 Submit/Cancel，含 Other", () => {
  const html = renderCard({
    request: request("select", { options: ["一", "二"] }),
    onRespond: () => {},
  });

  assert.ok(html.includes("aria-pressed="));
  assert.ok(html.includes("一"));
  assert.ok(html.includes("二"));
  // locale Other 附加
  assert.ok(html.includes("Other") || html.includes("其他"));
  assert.ok(html.includes("extension_submit") === false);
  assert.ok(html.includes("aria-label=\"Submit\"") || html.includes("aria-label=\"提交\""));
  assert.ok(html.includes("aria-label=\"Cancel\"") || html.includes("aria-label=\"取消\""));
  // 无多题字段
  assert.doesNotMatch(html, /questions|answers|queue|Next|步骤/);
  // 选中背景语义变量在源码中使用（初始无选中时背景为 --bg）
  assert.ok(source.includes("var(--bg-selected)"));
  assert.ok(source.includes("aria-pressed"));
});

test("SSR select：options 已含 Other 时不重复附加", () => {
  const html = renderCard({
    request: request("select", { options: ["A", "Other"] }),
    onRespond: () => {},
  });
  // 仅一个 Other 文案按钮（不含额外 locale 重复项）
  const otherMatches = html.match(/>Other</g) ?? [];
  assert.equal(otherMatches.length, 1);
});

test("SSR select：已有「输入内容」哨兵时不附加「其他」，选项竖排", () => {
  const html = renderCard({
    request: request("select", { options: ["1. 选项甲", "4. 输入内容"] }),
    onRespond: () => {},
  });
  assert.ok(html.includes("1. 选项甲"));
  assert.ok(html.includes("4. 输入内容"));
  assert.equal((html.match(/>其他</g) ?? []).length, 0);
  assert.ok(html.includes("flex-direction:column"));
});

test("SSR confirm：原交互保留 Cancel + Confirm，无 select 暂存结构", () => {
  const html = renderCard({
    request: request("confirm", { message: "确认操作？" }),
    onRespond: () => {},
  });
  assert.ok(html.includes("确认操作？") || html.includes("确认操作"));
  assert.ok(html.includes("aria-label=\"Confirm\"") || html.includes("aria-label=\"确认\""));
  assert.ok(html.includes("aria-label=\"Cancel\"") || html.includes("aria-label=\"取消\""));
  assert.doesNotMatch(html, /aria-pressed/);
  assert.doesNotMatch(html, /extension_otherPlaceholder|Enter a custom value/);
});

test("SSR input：原交互保留 input + Submit/Cancel，Enter/Escape 在源码中", () => {
  const html = renderCard({
    request: request("input", { placeholder: "输入内容" }),
    onRespond: () => {},
  });
  assert.ok(html.includes("placeholder=\"输入内容\"") || html.includes("输入内容"));
  assert.ok(html.includes("aria-label=\"Submit\"") || html.includes("aria-label=\"提交\""));
  assert.ok(html.includes("aria-label=\"Cancel\"") || html.includes("aria-label=\"取消\""));
  assert.match(source, /event\.key === "Enter"/);
  assert.match(source, /event\.key === "Escape"/);
  assert.doesNotMatch(html, /aria-pressed/);
});

test("source contract：request-scoped state、respondOnce 每 id 一次、无卸载 effect 响应、无多题协议", () => {
  assert.ok(source.includes("createInlineSelectState"));
  assert.ok(source.includes("resolveInlineSelectState"));
  assert.ok(source.includes("getInlineSelectSubmission"));
  assert.ok(source.includes("respondedRequestRef"));
  assert.ok(source.includes("boundRequestId"));
  // 无 useEffect 卸载伪造响应
  assert.doesNotMatch(source, /useEffect\s*\(/);
  // 无多题协议字段
  assert.doesNotMatch(source, /\bquestions\b|\banswers\b|\bqueue\b|onNext|stepCount/);
  // i18n 键
  assert.ok(source.includes("extension_other"));
  assert.ok(source.includes("extension_selectAnOption"));
  assert.ok(source.includes("extension_otherPlaceholder"));
  assert.ok(source.includes("extension_submit"));
  assert.ok(source.includes("extension_cancel"));
  // 无硬编码 Other UI 文案作为按钮文案（通过 t()）
  assert.ok(source.includes("t(\"extension_other\")"));
});

test("source contract：inert 覆盖 disabled/expired/responded", () => {
  assert.ok(source.includes("const inert = disabled || expired || responded"));
  assert.ok(source.includes("requestHasExpired"));
});

