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
    clearInput: () => {
      calls.cleared.push(draftKeyRef.current);
      valueRef.current = "";
      attachedImagesRef.current = [];
      attachedUploadsRef.current = [];
      calls.values.push(["live", ""]);
      calls.images.push([]);
    },
    insertIfEmptyLocal: (text) => { calls.inserted.push(text); },
    prependDraftText: (text) => {
      const combined = [text, valueRef.current].filter((part) => String(part).trim()).join("\n\n");
      valueRef.current = combined;
      calls.values.push(["live", combined]);
    },
    appendAttachedImages: (images) => {
      if (!images?.length) return;
      const known = new Set(attachedImagesRef.current.map(attachmentIdentity));
      attachedImagesRef.current = [
        ...attachedImagesRef.current,
        ...images.filter((image) => !known.has(attachmentIdentity(image))),
      ];
      calls.images.push(attachedImagesRef.current.map(attachmentIdentity));
    },
    composeMessageWithUploads: (base) => base,
    attachmentBinaryBlocks: () => [],
    imageToDraftImage: (image) => image,
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
  env.restoreSentDraft = callback("restoreSentDraft", env);
  env.handleSend = callback("handleSend", env);
  return { env, drafts, calls, draftKeyRef, valueRef, attachedImagesRef, attachedUploadsRef, sentDraftRef };
}

test("H3-a：带图发送立刻清空 A，回执不得清 B", async () => {
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
  assert.deepEqual(state.calls.cleared, ["A"], "带图也必须在回执前移交编辑器");
  assert.equal(state.valueRef.current, "");
  assert.deepEqual(state.attachedImagesRef.current, []);
  state.draftKeyRef.current = "B";
  resolveSend(true);
  await send;
  assert.equal(state.drafts.B?.value, "B-message", "B 未发送的内容必须原样保留");
  assert.deepEqual(state.calls.cleared, ["A"], "成功回执不得再清当前输入框");
});

test("H3-b：同一会话在途期间的新编辑，成功回执必须原样保留", async () => {
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
  assert.equal(state.valueRef.current, "");
  state.valueRef.current = "new line";
  state.attachedImagesRef.current = [typed];
  resolveSend(true);
  await send;
  assert.equal(state.valueRef.current, "new line", "后来打的字不能被回执清掉");
  assert.deepEqual(state.attachedImagesRef.current.map(attachmentIdentity), ["/typed.png"]);
});

test("H3-c：带图发送成功不再二次清空", async () => {
  const state = composer({
    drafts: { A: { value: "A-message", images: [image("/a.png")] } },
    draftKey: "A",
    value: "A-message",
    attachedImages: [image("/a.png")],
    onSend: async () => true,
  });
  await state.env.handleSend();
  assert.deepEqual(state.calls.cleared, ["A"]);
  assert.equal(state.valueRef.current, "");
});

test("H3-d：纯文本失败把载荷还给原草稿", async () => {
  const state = composer({
    drafts: { A: { value: "", images: [] } },
    draftKey: "A",
    value: "plain text",
    attachedImages: [],
    onSend: async () => false,
  });
  await state.env.handleSend();
  assert.deepEqual(state.calls.cleared, ["A"], "点击即乐观清空");
  assert.equal(state.valueRef.current, "plain text", "拒绝后正文回到输入框");
});

test("带图：点击后、回执前输入框与预览已空", async () => {
  let resolveSend;
  const gate = new Promise((resolve) => { resolveSend = resolve; });
  const pic = image("/photo.png");
  const state = composer({
    drafts: { A: { value: "see this", images: [pic] } },
    draftKey: "A",
    value: "see this",
    attachedImages: [pic],
    onSend: (msg, images) => {
      assert.equal(msg, "see this");
      assert.equal(images?.length, 1, "提交载荷仍带图");
      return gate;
    },
  });
  const send = state.env.handleSend();
  assert.equal(state.valueRef.current, "");
  assert.deepEqual(state.attachedImagesRef.current, []);
  resolveSend(true);
  await send;
  assert.equal(state.valueRef.current, "", "成功后不得把图和字填回来");
});

test("I6：成功回执不得改写后来输入", async () => {
  let resolveSend;
  const gate = new Promise((resolve) => { resolveSend = resolve; });
  const sent = image("/sent.png");
  const state = composer({
    drafts: { A: { value: "hello", images: [sent] } },
    draftKey: "A",
    value: "hello",
    attachedImages: [sent],
    onSend: () => gate,
  });
  const send = state.env.handleSend();
  state.valueRef.current = "hellohello";
  const writesBefore = state.calls.values.length;
  resolveSend(true);
  await send;
  assert.deepEqual(state.calls.values.slice(writesBefore), []);
  assert.equal(state.valueRef.current, "hellohello");
});
