/**
 * 工具显示元数据解析的语义与顺序（issue #75）。
 *
 * 重点验三件事：
 * 1. 顺序：与 SDK 一致，**后注册者胜**（同名工具后一份定义覆盖前一份）。
 * 2. 过滤：没有展示字段的定义不产生条目；非法形状（非 Map / 非对象 / 空 label）跳过。
 * 3. 降级：加载失败或没有任何声明 -> null，调用方走既有回退（不因缺元数据丢内容）。
 *
 * 用注入的假加载器：不加载真实扩展（真实扩展在别的用例里由父会话验证）。
 * 每处都带 bypassCache：扩展加载结果按 (cwd, agentDir) 共享缓存 30s，
 * 同 cwd 的后续用例会拿到前一个用例的结果，用例顺序就不再独立。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { collectToolDisplayMeta, resolveToolMetaProvider } = await jiti.import("./tool-display-meta.ts");

function extension(tools) {
  return { tools: new Map(tools.map(([name, definition]) => [name, { definition, sourceInfo: {} }])) };
}

test("collectToolDisplayMeta：抓 label 与 renderShell，且后注册者胜", () => {
  const extensions = [
    extension([["mcp", { name: "mcp", label: "MCP" }], ["bash", { name: "bash" }]]),
    // 同名工具的第二份定义（SDK 用 Map.set 覆盖，所以后者生效）
    extension([["mcp", { name: "mcp", label: "MCP: files" }], ["ask_advisor", { name: "ask_advisor", label: "Ask Advisor", renderShell: "self" }]]),
  ];
  const meta = collectToolDisplayMeta(extensions);
  assert.deepEqual(meta.get("mcp"), { label: "MCP: files" }, "同名工具必须取后注册的定义");
  assert.deepEqual(meta.get("ask_advisor"), { label: "Ask Advisor", renderShell: "self" });
  assert.equal(meta.has("bash"), false, "没有展示字段的定义不产生条目（调用方回退）");
});

test("collectToolDisplayMeta：只认 renderShell === \"self\"，其它值忽略", () => {
  const meta = collectToolDisplayMeta([
    extension([
      ["a", { name: "a", renderShell: "self" }],
      ["b", { name: "b", renderShell: "default" }],
      ["c", { name: "c", renderShell: "SELF" }],
      ["d", { name: "d", label: "  Padded label  " }],
    ]),
  ]);
  assert.deepEqual(meta.get("a"), { renderShell: "self" });
  assert.equal(meta.has("b"), false, "renderShell: default 不产生条目");
  assert.equal(meta.has("c"), false, "大小写不匹配不算 self");
  assert.deepEqual(meta.get("d"), { label: "Padded label" }, "label 两侧空白去掉");
});

test("collectToolDisplayMeta：非法形状一律跳过，不抛错", () => {
  const meta = collectToolDisplayMeta([
    null,
    {},
    { tools: "not-a-map" },
    { tools: new Map([[42, { definition: { label: "x" } }]]) },
    { tools: new Map([["ok", null]]) },
    { tools: new Map([["empty-label", { definition: { label: "   " } }]]) },
    { tools: new Map([["good", { definition: { label: "Good" } }]]) },
  ]);
  assert.deepEqual([...meta.keys()], ["good"]);
});

test("resolveToolMetaProvider：拿不到扩展（加载失败 / 无声明）返回 null", async () => {
  const failing = await resolveToolMetaProvider({
    cwd: "/tmp/x",
    bypassCache: true,
    loaderFactory: () => async () => { throw new Error("load failed"); },
  });
  assert.equal(failing, null, "加载失败降级为 null");

  const empty = await resolveToolMetaProvider({
    cwd: "/tmp/x",
    bypassCache: true,
    loaderFactory: () => async () => ({ extensions: [], runtime: {}, errors: [] }),
  });
  assert.equal(empty, null, "没有任何声明时返回 null");
});

test("resolveToolMetaProvider：命中返回元数据，未知名返回 null", async () => {
  const provider = await resolveToolMetaProvider({
    cwd: "/tmp/x",
    bypassCache: true,
    loaderFactory: () => async () => ({
      extensions: [extension([["lsp_fix", { name: "lsp_fix", label: "LSP: Fix" }]])],
      runtime: {},
      errors: [],
    }),
  });
  assert.ok(provider, "有声明时必须给出解析器");
  assert.deepEqual(provider("lsp_fix"), { label: "LSP: Fix" });
  assert.equal(provider("unknown_tool"), null);
});
