/**
 * 工具显示元数据解析的语义与顺序（issue #75）。
 *
 * 重点验四件事：
 * 1. 顺序：与 SDK `ExtensionRunner.getToolDefinition` 一致，**先注册者胜**
 *    （活路径就是查那张表，两条路径必须同规则，否则同一张卡片刷新前后会换名字）。
 * 2. 过滤：没有展示字段的定义不产生条目；非法形状（非 Map / 非对象 / 空 label）跳过；
 *    **label 与工具名同名（忽略大小写）视为没声明名字** —— SDK 内置工具就是这么写的。
 * 3. 自家工具：`send_file_to_user` 由宿主 inline 注册，读盘时不在扩展表里，必须显式登记，
 *    否则同一张卡片刷新后会从「Send file to user」退回「Send_file_to_user」。
 * 4. 降级：加载失败 -> null；加载成功但扩展没有声明时仍给出解析器（自家工具那条还在）。
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

const OWN_TOOL = "send_file_to_user";

function extension(tools) {
  return { tools: new Map(tools.map(([name, definition]) => [name, { definition, sourceInfo: {} }])) };
}

test("collectToolDisplayMeta：抓 label 与 renderShell，且先注册者胜（与 SDK runner 同规则）", () => {
  const extensions = [
    extension([["mcp", { name: "mcp", label: "MCP" }], ["bash", { name: "bash" }]]),
    // 同名工具的第二份定义：扩展 runner 的 getToolDefinition 取**先**命中的那个
    extension([["mcp", { name: "mcp", label: "MCP: files" }], ["ask_advisor", { name: "ask_advisor", label: "Ask Advisor", renderShell: "self" }]]),
  ];
  const meta = collectToolDisplayMeta(extensions);
  assert.deepEqual(meta.get("mcp"), { label: "MCP" }, "同名工具取先注册的定义（与活路径同规则）");
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

test("collectToolDisplayMeta：label 精确等于工具名视为没声明名字（内置自称写法）", () => {
  const meta = collectToolDisplayMeta([
    extension([
      // SDK 内置工具的写法：label 就是那个小写工具名。采纳它会把标题从 `Bash` 变成 `bash`。
      ["bash", { name: "bash", label: "bash" }],
      // 精确同名 label 被忽略，但 renderShell 独立生效（内置 edit 就是这个形状）
      ["edit", { name: "edit", label: "edit", renderShell: "self" }],
      // 真插件用大小写做显示改进（pi-mcp-adapter 给 `mcp` 的 label 就是 `MCP`）——必须保留
      ["mcp", { name: "mcp", label: "MCP" }],
    ]),
  ]);
  assert.equal(meta.has("bash"), false, "精确同名的 label 不产生名字");
  assert.deepEqual(meta.get("edit"), { renderShell: "self" }, "同名 label 被忽略，self 仍生效");
  assert.deepEqual(meta.get("mcp"), { label: "MCP" }, "只差大小写的 label 是显示改进，保留");
});

test("collectToolDisplayMeta：非法形状一律跳过，自家工具总在表里", () => {
  const meta = collectToolDisplayMeta([
    null,
    {},
    { tools: "not-a-map" },
    { tools: new Map([[42, { definition: { label: "x" } }]]) },
    { tools: new Map([["ok", null]]) },
    { tools: new Map([["empty-label", { definition: { label: "   " } }]]) },
    { tools: new Map([["good", { definition: { label: "Good" } }]]) },
  ]);
  assert.deepEqual([...meta.keys()].filter((name) => name !== OWN_TOOL), ["good"]);
  assert.deepEqual(
    meta.get(OWN_TOOL),
    { label: "Send file to user" },
    "宿主 inline 注册的工具必须显式登记：读盘投影看不到它的定义",
  );
});

test("collectToolDisplayMeta：扩展已经声明了自家工具时用扩展那份（不重复登记）", () => {
  const meta = collectToolDisplayMeta([
    extension([[OWN_TOOL, { name: OWN_TOOL, label: "扩展自己的名字" }]]),
  ]);
  assert.deepEqual(meta.get(OWN_TOOL), { label: "扩展自己的名字" });
});

test("resolveToolMetaProvider：加载失败返回 null；扩展没声明时仍给出解析器（自家工具那条在）", async () => {
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
  assert.ok(empty, "加载成功就要给解析器：自家工具的名字不依赖扩展");
  assert.deepEqual(empty(OWN_TOOL), { label: "Send file to user" });
  assert.equal(empty("unknown_tool"), null, "未知名仍返回 null（调用方回退）");
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
