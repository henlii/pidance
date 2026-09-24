/**
 * 插件自定义 entry 的渲染器解析（issue #71）。
 *
 * 纯逻辑 + 注入加载器：不加载真实扩展、不读任何凭据、不触网。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { collectEntryRenderers, collectMessageRenderers, resolveEntryLinesProvider, resolveMessageLinesProvider } =
  await jiti.import("./extension-entry-renderers.ts");

const entry = (customType, data) => ({
  type: "custom",
  id: "e1",
  customType,
  data,
  timestamp: "2026-01-01T00:00:00.000Z",
});

test("collectEntryRenderers：按扩展顺序先注册者胜，非法条目跳过", () => {
  const first = () => ({ render: () => ["first"] });
  const second = () => ({ render: () => ["second"] });
  const renderers = collectEntryRenderers([
    { entryRenderers: new Map([["qa.entry", first], ["qa.other", second]]) },
    { entryRenderers: new Map([["qa.entry", second], ["", second], ["qa.broken", 42]]) },
    { entryRenderers: { not: "a map" } },
    {},
  ]);
  assert.equal(renderers.get("qa.entry"), first);
  assert.equal(renderers.get("qa.other"), second);
  assert.equal(renderers.has(""), false);
  assert.equal(renderers.has("qa.broken"), false);
  assert.equal(renderers.size, 2);
});

test("resolveEntryLinesProvider：命中渲染器才出内容，其余一律 null", async () => {
  const loaderFactory = () => async () => ({
    extensions: [
      {
        entryRenderers: new Map([
          ["qa.entry", (e) => ({ render: () => [`data=${JSON.stringify(e.data)}`] })],
        ]),
      },
    ],
    runtime: {},
    errors: [],
  });
  const provider = await resolveEntryLinesProvider({ cwd: "/tmp/qa-entry-1", loaderFactory });
  assert.equal(typeof provider, "function");
  // entry 原样交给渲染器（插件读 entry.data）
  assert.deepEqual(provider(entry("qa.entry", { ok: 1 })), ['data={"ok":1}']);
  assert.equal(provider(entry("qa.unknown", {})), null);
  assert.equal(provider(null), null);
  assert.equal(provider({ customType: 42 }), null);
  assert.equal(provider({}), null);
});

test("resolveEntryLinesProvider：渲染器抛错 / 返回 undefined / 输出畸形都不显示", async () => {
  const loaderFactory = () => async () => ({
    extensions: [
      {
        entryRenderers: new Map([
          ["qa.throw", () => { throw new Error("renderer boom"); }],
          ["qa.empty", () => undefined],
          ["qa.malformed", () => ({ render: () => "not-an-array" })],
        ]),
      },
    ],
    runtime: {},
    errors: [],
  });
  const provider = await resolveEntryLinesProvider({ cwd: "/tmp/qa-entry-2", loaderFactory });
  assert.equal(provider(entry("qa.throw", {})), null);
  assert.equal(provider(entry("qa.empty", {})), null);
  assert.equal(provider(entry("qa.malformed", {})), null);
});

test("resolveEntryLinesProvider：加载失败 / 没有 entry 渲染器 → null（保持历史行为）", async () => {
  const failing = await resolveEntryLinesProvider({
    cwd: "/tmp/qa-entry-3",
    loaderFactory: () => async () => { throw new Error("load boom"); },
  });
  assert.equal(failing, null);

  const none = await resolveEntryLinesProvider({
    cwd: "/tmp/qa-entry-4",
    loaderFactory: () => async () => ({ extensions: [{}], runtime: {}, errors: [] }),
  });
  assert.equal(none, null);
});

// ---------------------------------------------------------------------------
// 自定义消息（issue #76）：实时路径本来就有渲染，读盘路径原本退回原文。

test("collectMessageRenderers：按扩展顺序先注册者胜，非法条目跳过", () => {
  const first = () => ({ render: () => ["first"] });
  const second = () => ({ render: () => ["second"] });
  const renderers = collectMessageRenderers([
    { messageRenderers: new Map([["qa.msg", first], ["qa.other", second]]) },
    { messageRenderers: new Map([["qa.msg", second], ["", second], ["qa.broken", 42]]) },
    { messageRenderers: { not: "a map" } },
    {},
  ]);
  assert.equal(renderers.get("qa.msg"), first);
  assert.equal(renderers.get("qa.other"), second);
  assert.equal(renderers.has(""), false);
  assert.equal(renderers.has("qa.broken"), false);
  assert.equal(renderers.size, 2);
});

test("resolveMessageLinesProvider：命中渲染器才覆盖，其余一律 null（退回原文）", async () => {
  const loaderFactory = () => async () => ({
    extensions: [
      {
        messageRenderers: new Map([
          // 真实插件（pi-subagents 的 subagent-notify）就是读 message.content / details 的。
          ["qa.msg", (m) => ({ render: () => [`msg=${JSON.stringify(m.content)} details=${JSON.stringify(m.details)}`] })],
          ["qa.throw", () => { throw new Error("renderer boom"); }],
          ["qa.empty", () => undefined],
          ["qa.malformed", () => ({ render: () => "not-an-array" })],
          ["qa.blank", () => ({ render: () => [] })],
        ]),
      },
    ],
    runtime: {},
    errors: [],
  });
  const provider = await resolveMessageLinesProvider({ cwd: "/tmp/qa-msg-1", loaderFactory });
  assert.equal(typeof provider, "function");
  const message = { role: "custom", customType: "qa.msg", content: "hi", details: { status: "completed" } };
  assert.deepEqual(provider(message), ['msg="hi" details={"status":"completed"}']);
  assert.equal(provider({ customType: "qa.unknown" }), null);
  assert.equal(provider({ customType: "qa.throw" }), null);
  assert.equal(provider({ customType: "qa.empty" }), null);
  assert.equal(provider({ customType: "qa.malformed" }), null);
  assert.equal(provider({ customType: "qa.blank" }), null, "空行数组等于没有渲染，不能盖住原文");
  assert.equal(provider(null), null);
  assert.equal(provider({ customType: 42 }), null);
});

test("resolveMessageLinesProvider：加载失败 / 没有消息渲染器 → null", async () => {
  const failing = await resolveMessageLinesProvider({
    cwd: "/tmp/qa-msg-2",
    loaderFactory: () => async () => { throw new Error("load boom"); },
  });
  assert.equal(failing, null);

  const none = await resolveMessageLinesProvider({
    cwd: "/tmp/qa-msg-3",
    loaderFactory: () => async () => ({ extensions: [{}], runtime: {}, errors: [] }),
  });
  assert.equal(none, null);
});
