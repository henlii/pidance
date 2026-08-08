/**
 * P5 回归门禁（静态）：把终稿验收固化为可回归证据。
 *
 * 只读源码文本断言，不启动 Next、不跑构建。防止未来改动把已下线的
 * 入口/行为复活（旧面板挂载、auto-name 按钮、工具 preset 收窄、撤回坞……）。
 *
 * 负向断言一律先 stripComments 再去匹配：注释/文档里残留的旧名不算数，
 * 只有真正出现在生产 JSX/代码中的形式才触发失败（允许注释中出现字符串）。
 * 正向断言（核心模块在位）对原始源码断言，防误删。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

/** 仓库根目录 URL（本测试位于 lib/ 下，向上取根）。 */
const ROOT = new URL("../", import.meta.url);

/**
 * 读取仓库内相对路径源码。
 * @param {string} rel 相对仓库根路径，如 "components/AppShell.tsx"
 */
function srcUrl(rel) {
  return new URL(rel, ROOT);
}

/**
 * 去除 TS/TSX 源码注释（行注释 // 与块注释），保留字符串字面量
 * （'、"、`，含反斜杠转义）内容不动，避免误伤 JSX 属性里的
 * xmlns="http://..." 等 URL。用于「断言生产 JSX 不存在」的负向门禁。
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      // 行注释：跳到行尾（保留换行，避免跨行拼接产生假阳性）
      i += 2;
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      // 块注释：整段丢弃
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 读取并去除注释后的源码。
 * @param {string} rel
 */
async function strippedSource(rel) {
  return stripComments(await readFile(srcUrl(rel), "utf8"));
}

test("AppShell.tsx 不再挂载 SubagentRunsPanel / LensDiagnosticsPanel（生产 JSX）", async () => {
  const src = await strippedSource("components/AppShell.tsx");

  // 允许注释中出现字符串；断言生产 JSX 不存在
  assert.doesNotMatch(src, /<SubagentRunsPanel/);
  assert.doesNotMatch(src, /<LensDiagnosticsPanel/);

  // 健全性：剥离注释后仍是可识别组件源码，防测试空转/防剥离过度
  assert.match(src, /export function AppShell\(/);
  assert.match(src, /<ChatWindow/);
  assert.match(src, /<SessionSidebar/);
  assert.match(src, /<CommandPalette/);
});

test("AppShell.tsx 无 auto-name 按钮（非注释形式）", async () => {
  const src = await strippedSource("components/AppShell.tsx");

  // auto-name / autoName / auto_name 均不得以非注释形式出现
  assert.doesNotMatch(src, /auto-?name|auto_name/i);

  // 健全性：auto 前缀词不影响其它内容
  assert.match(src, /export function AppShell\(/);
});

test("ChatWindow.tsx 不再挂载 RetractedMessagesDock / OmPanel / WorkspaceHistoryPanel", async () => {
  const src = await strippedSource("components/ChatWindow.tsx");

  for (const name of ["RetractedMessagesDock", "OmPanel", "WorkspaceHistoryPanel"]) {
    assert.doesNotMatch(src, new RegExp(`<${name}`));
  }

  // 健全性：现存面板/渲染物仍在（TodoPanel 等），防测试空转
  assert.match(src, /export function ChatWindow\(/);
  assert.match(src, /<MessageView/);
  assert.match(src, /<ChatInput/);
  assert.match(src, /<TodoPanel/);
  assert.match(src, /<ExtensionDialog/);
});

test("ChatInput.tsx 无工具 preset 选择器（非注释形式）", async () => {
  const src = await strippedSource("components/ChatInput.tsx");

  // 唯一含 preset 的位置是注释（RIGHT 条说明），剥离后不得再出现
  assert.doesNotMatch(src, /preset/i);
  // preset 常量/选择器/工具开关相关符号均不得出现
  assert.doesNotMatch(
    src,
    /TOOL_PRESET|PRESET_NONE|PRESET_DEFAULT|PRESET_FULL|getToolNamesForPreset|getPresetFromTools|setActiveToolsByName|getActiveTools/,
  );

  // 健全性
  assert.match(src, /export const ChatInput/);
});

test("useAgentSession 返回对象不含已下线回调（注释残留可豁免）", async () => {
  const raw = await readFile(srcUrl("hooks/useAgentSession.ts"), "utf8");
  const returnIdx = raw.lastIndexOf("return {");
  assert.ok(returnIdx >= 0, "useAgentSession.ts 应以 return { 收尾返回对象");
  // 只针对对外返回对象断言；注释（如 REFACTOR-DEAD 说明）剥离后不算数
  const returnBlock = stripComments(raw.slice(returnIdx));

  for (const name of [
    "handleToolPresetChange",
    "handleRetractMessage",
    "handleRestoreMessage",
    "handlePresetChange",
  ]) {
    assert.doesNotMatch(returnBlock, new RegExp(`\\b${name}\\b`));
  }

  // 健全性：live 回调仍在返回对象中，防误伤
  for (const name of ["handleSend", "handleFork", "handleNavigate", "handleThinkingLevelChange"]) {
    assert.match(returnBlock, new RegExp(`\\b${name}\\b`));
  }
});

test("P2/P3/P4 核心模块在位", () => {
  const modules = [
    // P2 统一收尾：自动跟随 / 渲染计划 / run 收尾
    "lib/chat-auto-follow.ts",
    "lib/chat-compositor.ts",
    "lib/finish-agent-run.ts",
    // P3 流式同构：会话命令独立 hook
    "hooks/useSessionCommands.ts",
    // P4 实时工具 UI：工具执行缓冲
    "lib/tool-execution-buffer.ts",
  ];
  for (const rel of modules) {
    assert.ok(existsSync(srcUrl(rel)), `${rel} 缺失——P${rel.startsWith("hooks") ? 3 : rel.includes("tool-execution-buffer") ? 4 : 2} 核心模块必须保留`);
  }
});
