/**
 * 内置斜杠命令的 Web 落点映射。
 *
 * 这张表的价值在于「分类要说清楚」：哪些由宿主 RPC 处理、哪些由界面自己做、哪些明确不做。
 * 所以测试的重点不是「函数能跑」，而是：
 *   1. 面板里的每条命令都能被解析（不能有「列出来了但按下去没反应」的项）；
 *   2. **排除表被钉住**（有人无声地把某条命令挪走/加进来，这里要红）；
 *   3. `/thinking` `/model` 的参数解析在歧义/非法时不猜。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  BUILTIN_SLASH_PALETTE,
  BUILTIN_SLASH_HOST_COMMANDS,
  BUILTIN_SLASH_UI_ACTIONS,
  BUILTIN_SLASH_EXCLUDED,
  resolveBuiltinSlashCommand,
  resolveThinkingLevelArgument,
  resolveModelArgument,
} = await jiti.import("./builtin-slash-actions.ts");

test("面板里的每条命令都能落到某一边（host / ui），不留「点了没反应」的项", () => {
  for (const entry of BUILTIN_SLASH_PALETTE) {
    const resolved = resolveBuiltinSlashCommand(entry.name);
    assert.ok(
      resolved.kind === "host" || resolved.kind === "ui",
      `${entry.name} 在面板里但没有落点：${JSON.stringify(resolved)}`,
    );
  }
});

test("宿主命令与 UI 命令各就各位，且两边不重叠", () => {
  assert.deepEqual([...BUILTIN_SLASH_HOST_COMMANDS].sort(), ["compact", "copy", "name", "reload", "session"]);
  for (const name of BUILTIN_SLASH_HOST_COMMANDS) {
    assert.equal(resolveBuiltinSlashCommand(name).kind, "host");
    assert.equal(BUILTIN_SLASH_UI_ACTIONS[name], undefined, "同一条命令不能既走宿主又走界面");
  }
  for (const [name, action] of Object.entries(BUILTIN_SLASH_UI_ACTIONS)) {
    const resolved = resolveBuiltinSlashCommand(name);
    assert.deepEqual(resolved, { kind: "ui", action });
  }
});

test("Web 落点：设置 / 模型 / 思考 / 新建 / 恢复 / 分支树 / 导出", () => {
  assert.deepEqual(Object.keys(BUILTIN_SLASH_UI_ACTIONS).sort(), [
    "export", "model", "new", "resume", "settings", "thinking", "tree",
  ]);
  assert.equal(resolveBuiltinSlashCommand("settings").action, "openSettings");
  assert.equal(resolveBuiltinSlashCommand("tree").action, "openTree");
  assert.equal(resolveBuiltinSlashCommand("export").action, "exportSessionHtml");
});

test("排除表被钉住：终端专有 / 已有别的入口，逐条带理由", () => {
  assert.deepEqual(Object.keys(BUILTIN_SLASH_EXCLUDED).sort(), [
    "bug", "changelog", "clone", "fork", "hotkeys", "import", "login", "logout", "quit", "scoped-models", "share", "trust",
  ]);
  for (const [name, reason] of Object.entries(BUILTIN_SLASH_EXCLUDED)) {
    assert.equal(typeof reason, "string");
    assert.ok(reason.trim().length > 0, `${name} 的排除理由不能是空的`);
    assert.deepEqual(resolveBuiltinSlashCommand(name), { kind: "excluded", reason });
  }
});

test("不在表里的名字一律 unknown（扩展/提示词/技能注册的命令不能被吞掉）", () => {
  for (const name of ["mcp", "advisor", "unknown-thing", ""]) {
    assert.equal(resolveBuiltinSlashCommand(name).kind, "unknown", `${name} 应交给宿主`);
  }
  // 大小写不敏感，但面板里用的都是小写名
  assert.equal(resolveBuiltinSlashCommand("MODEL").kind, "ui");
});

test("/thinking 参数：只认那七档，大小写与空格容错，其余返回 null", () => {
  assert.equal(resolveThinkingLevelArgument("high"), "high");
  assert.equal(resolveThinkingLevelArgument("  XHIGH  "), "xhigh");
  assert.equal(resolveThinkingLevelArgument("off"), "off");
  for (const bad of ["", "   ", "turbo", "1", "xxhigh"]) {
    assert.equal(resolveThinkingLevelArgument(bad), null, `${JSON.stringify(bad)} 不该被接受`);
  }
});

test("/model 参数：provider/model 精确匹配；id 或名字只在唯一命中时算数", () => {
  const models = [
    { id: "grok-4.6", provider: "cpa", name: "Grok 4.6" },
    { id: "deepseek-v4.1-flash", provider: "cpa", name: "DeepSeek Flash" },
    { id: "gpt-5.6-luna", provider: "other", name: "Luna" },
  ];
  assert.deepEqual(resolveModelArgument("cpa/grok-4.6", models), models[0]);
  assert.equal(resolveModelArgument("cpa/does-not-exist", models), null, "provider 对上但 id 不对要 null");
  assert.equal(resolveModelArgument("nope/grok-4.6", models), null);
  assert.deepEqual(resolveModelArgument("deepseek-v4.1-flash", models), models[1], "唯一 id 命中");
  assert.deepEqual(resolveModelArgument("Luna", models), models[2], "唯一名字命中");
  assert.equal(resolveModelArgument("grok-4.6", models)?.id, "grok-4.6", "id 命中");
  assert.equal(resolveModelArgument("", models), null);
  assert.equal(resolveModelArgument("   ", models), null);
});

test("/model 参数：同名歧义不猜（返回 null，让调用方退回打开选择器）", () => {
  const models = [
    { id: "a", provider: "p1", name: "同名" },
    { id: "b", provider: "p2", name: "同名" },
  ];
  assert.equal(resolveModelArgument("同名", models), null);
  assert.equal(resolveModelArgument("a", models)?.provider, "p1", "id 仍然唯一");
});
