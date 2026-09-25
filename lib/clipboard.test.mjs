import assert from "node:assert/strict";
import test from "node:test";

import { copyText } from "./clipboard.ts";

/** 最小 DOM 桩：只实现 copyText 用到的那几样。 */
function installDom({ execResult = true } = {}) {
  const calls = { exec: 0, select: 0, appended: 0, removed: 0 };
  const textarea = {
    value: "",
    style: {},
    setAttribute() {},
    select() { calls.select += 1; },
    setSelectionRange() {},
  };
  const body = {
    appendChild() { calls.appended += 1; },
    removeChild() { calls.removed += 1; },
  };
  const previous = { document: globalThis.document, navigator: globalThis.navigator };
  globalThis.document = {
    createElement: () => textarea,
    body,
    execCommand: (cmd) => {
      assert.equal(cmd, "copy");
      calls.exec += 1;
      return execResult;
    },
  };
  return {
    calls,
    textarea,
    restore() {
      if (previous.document === undefined) delete globalThis.document;
      else globalThis.document = previous.document;
      if (previous.navigator === undefined) delete globalThis.navigator;
      else Object.defineProperty(globalThis, "navigator", { value: previous.navigator, configurable: true, writable: true });
    },
  };
}

// Node 里 globalThis.navigator 是只读 getter，只能 defineProperty 覆盖（并在用完后删掉）。
function setClipboard(writeText) {
  Object.defineProperty(globalThis, "navigator", {
    value: writeText === undefined ? {} : { clipboard: { writeText } },
    configurable: true,
    writable: true,
  });
}

test("有 Clipboard API 且成功：用它，不碰回退路径", async () => {
  const dom = installDom();
  let wrote = null;
  setClipboard((text) => { wrote = text; return Promise.resolve(); });
  try {
    await copyText("hello");
    assert.equal(wrote, "hello");
    assert.equal(dom.calls.exec, 0, "不该走 execCommand 回退");
  } finally {
    dom.restore();
  }
});

test("Clipboard API 不存在（非安全上下文）：回退到 execCommand", async () => {
  const dom = installDom();
  setClipboard(undefined);
  try {
    await copyText("lan-http");
    assert.equal(dom.calls.exec, 1);
    assert.equal(dom.calls.appended, 1);
    assert.equal(dom.calls.removed, 1, "临时节点必须摘掉");
  } finally {
    dom.restore();
  }
});

test("Clipboard API 存在但被拒（权限策略/文档失焦）：仍要回退，不能静默失败", async () => {
  const dom = installDom();
  setClipboard(() => Promise.reject(new Error("NotAllowedError")));
  try {
    await copyText("denied");
    assert.equal(dom.calls.exec, 1, "writeText 被拒后必须走回退");
  } finally {
    dom.restore();
  }
});

test("两条路都失败：必须 reject，让调用方显示失败", async () => {
  const dom = installDom({ execResult: false });
  setClipboard(() => Promise.reject(new Error("NotAllowedError")));
  try {
    await assert.rejects(() => copyText("nope"));
  } finally {
    dom.restore();
  }
});

test("execCommand 返回 false 不算成功", async () => {
  const dom = installDom({ execResult: false });
  setClipboard(undefined);
  try {
    await assert.rejects(() => copyText("nope"));
  } finally {
    dom.restore();
  }
});

test("writeText 同步抛错时也回退", async () => {
  const dom = installDom();
  setClipboard(() => { throw new Error("sync boom"); });
  try {
    await copyText("sync");
    assert.equal(dom.calls.exec, 1);
  } finally {
    dom.restore();
  }
});
