/**
 * 带附件发送成功后的**草稿归属**回归（issue #42 第四轮复核 H3）。
 *
 * 成功回执只能结算「本次发送捕获的那份草稿版本」：发送在途时用户可能已经切到
 * 别的会话、或在同一会话里继续编辑，旧实现用 clearInput() 清「当前输入框」，
 * 于是 A 的附件发完会把 B 未发送的内容一起清掉。这里从真实 ChatInput 源码里
 * 抽出 handleSend / settleSentDraft 驱动，注入可控的 onSend 与草稿存储。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const SOURCE = new URL("./ChatInput.tsx", import.meta.url);

/** 从组件源码里取出一个 useCallback 定义（与 docs 里的复核探针同一手法）。 */
function callback(name, env) {
  const text = readFileSync(SOURCE, "utf8");
  const tree = ts.createSourceFile("ChatInput.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer
      && ts.isCallExpression(node.initializer)) {
      expression = node.initializer.arguments[0].getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(expression, `Missing callback: ${name}`);
  const js = ts.transpileModule(`const extracted = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(env), `${js}; return extracted;`)(...Object.values(env));
}

/** 与 components/ChatInput.tsx 的 attachmentIdentity 一致（附件身份 = 引用路径优先）。 */
function attachmentIdentity(image) {
  const path = image.media?.original?.path ?? image.original?.path;
  return path ?? `${image.mimeType}:${image.data?.slice(0, 64) ?? ""}`;
}

function image(path, mimeType = "image/png") {
  return { mimeType, media: { original: { path } } };
}

/**
 * 最小输入框环境：草稿存储 + 受控 onSend。
 * `calls` 记录对外可见的副作用（清空 / 写入 / 归还），用来断言「清了谁」。
 */
function composer(initial) {
  const drafts = { ...initial.drafts };
  const calls = { cleared: [], values: [], images: [], uploads: [], inserted: [] };
  const valueRef = { current: initial.value };
  const draftKeyRef = { current: initial.draftKey };
  const attachedImagesRef = { current: initial.attachedImages };
  const attachedUploadsRef = { current: initial.attachedUploads ?? [] };
  const sentDraftRef = { current: null };
  const env = {
    value: initial.value,
    attachedImages: initial.attachedImages,
    attachedUploads: initial.attachedUploads ?? [],
    hasReadyUploads: (initial.attachedUploads ?? []).some((item) => item.status === "ready" && item.path),
    hasUploading: false,
    hasFailedAttachments: false,
    isStreaming: false,
    onAudioUnlock() {},
    onBuiltinCommand: null,
    onPromptWithStreamingBehavior: null,
    valueRef,
    draftKeyRef,
    attachedImagesRef,
    attachedUploadsRef,
    sentDraftRef,
    attachmentIdentity,
    getDraft: (key) => drafts[key] ?? null,
    setDraft: (key, draft) => { drafts[key] = draft; calls.values.push([key, draft.value]); },
    clearDraft: (key) => { delete drafts[key]; calls.cleared.push(key); },
    clearInput: () => { calls.cleared.push(draftKeyRef.current); },
    insertIfEmptyLocal: (text) => { calls.inserted.push(text); },
    composeMessageWithUploads: (base) => base,
    attachmentBinaryBlocks: () => [],
    t: (key) => key,
    setValue: (next) => { valueRef.current = next; calls.values.push(["live", next]); },
    setAttachedImages: (update) => {
      attachedImagesRef.current = update(attachedImagesRef.current);
      calls.images.push(attachedImagesRef.current.map(attachmentIdentity));
    },
    setAttachedUploads: (update) => {
      attachedUploadsRef.current = update(attachedUploadsRef.current);
      calls.uploads.push(attachedUploadsRef.current.map((item) => item.path));
    },
    onSend: initial.onSend,
  };
  env.settleSentDraft = callback("settleSentDraft", env);
  env.handleSend = callback("handleSend", env);
  return { env, drafts, calls, draftKeyRef, valueRef, attachedImagesRef, attachedUploadsRef, sentDraftRef };
}

test("H3-a：带附件发送成功只结算 A 的草稿，不清 B 的输入框", async () => {
  let resolveSend;
  const gate = new Promise((resolve) => { resolveSend = resolve; });
  const state = composer({
    drafts: { A: { value: "A-message", images: [image("/a.png")] }, B: { value: "B-message", images: [] } },
    draftKey: "A",
    value: "A-message",
    attachedImages: [image("/a.png")],
    onSend: () => gate,
  });
  const send = state.env.handleSend();
  // 回执在途：用户切到会话 B 并正在编辑。
  state.draftKeyRef.current = "B";
  resolveSend(true);
  await send;

  assert.deepEqual(state.calls.cleared, ["A"], "只作废发送的那份草稿（A），绝不清当前输入框（B）");
  assert.equal(state.drafts.B?.value, "B-message", "B 未发送的内容必须原样保留");
  assert.equal(state.drafts.A, undefined, "A 已发送的草稿版本被结算掉");
});

test("H3-b：同一会话在途期间继续编辑，保留新输入、只移除已发送部分", async () => {
  let resolveSend;
  const gate = new Promise((resolve) => { resolveSend = resolve; });
  const sent = image("/sent.png");
  const typed = image("/typed.png");
  const state = composer({
    drafts: { A: { value: "sent text", images: [sent] } },
    draftKey: "A",
    value: "sent text",
    attachedImages: [sent],
    onSend: () => gate,
  });
  const send = state.env.handleSend();
  // 回执在途：用户又敲了一行、并贴了另一张图。
  state.valueRef.current = "sent text\n\nnew line";
  state.attachedImagesRef.current = [sent, typed];
  resolveSend(true);
  await send;

  assert.deepEqual(state.calls.cleared, [], "用户的新编辑不能被清掉");
  assert.deepEqual(state.calls.values.at(-1), ["live", "new line"], "只移除已发送的正文");
  assert.deepEqual(state.calls.images.at(-1), ["/typed.png"], "只移除已发送的图片");
});

test("H3-c：内容没变才按整条清空（原有行为保持）", async () => {
  const state = composer({
    drafts: { A: { value: "A-message", images: [image("/a.png")] } },
    draftKey: "A",
    value: "A-message",
    attachedImages: [image("/a.png")],
    onSend: async () => true,
  });
  await state.env.handleSend();
  assert.deepEqual(state.calls.cleared, ["A"], "内容未变：整条清空");
});

test("H3-d：纯文本路径保持乐观清空与失败恢复", async () => {
  const state = composer({
    drafts: { A: { value: "", images: [] } },
    draftKey: "A",
    value: "plain text",
    attachedImages: [],
    onSend: async () => false,
  });
  await state.env.handleSend();
  assert.deepEqual(state.calls.cleared, ["A"], "纯文本点击即乐观清空");
  assert.deepEqual(state.calls.values, [["A", "plain text"]], "失败后按发送时的 draftKey 恢复");
  assert.deepEqual(state.calls.inserted, ["plain text"]);
});
