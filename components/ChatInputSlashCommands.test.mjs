/**
 * 内置斜杠命令面板的**接线**守住（分类逻辑在 lib/builtin-slash-actions.test.mjs）。
 *
 * 为什么要钉源码形状：这些接线错了不会报错 —— 面板列出来了但按下去没反应、或者
 * 命令被当成普通消息发给模型、或者描述渲染成 i18n 键名。三种都只有用户能发现。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");

test("面板名单来自分类表，描述走 i18n（不再是硬编码列表、不再渲染键名）", () => {
  assert.match(source, /BUILTIN_SLASH_PALETTE/, "面板没接分类表");
  assert.match(source, /function builtinSlashCommands\(t: \(key: TranslationKey\) => string\)/, "描述没经过翻译");
  assert.match(source, /description: t\(entry\.descriptionKey as TranslationKey\)/, "描述键没翻成人话");
  assert.match(source, /const commands = \[\.\.\.builtinSlashCommands\(t\), \.\.\.\(slashCommands \?\? \[\]\)\];/);
  // 反面契约：以前那张硬编码清单不能再回来（它会绕过分类表）
  assert.doesNotMatch(source, /const BUILTIN_SLASH_COMMANDS: SlashCommandPaletteItem\[\] = \[/, "硬编码清单又回来了");
});

test("两条提交路径都先接管界面类命令（普通发送 + 运行中入队）", () => {
  assert.equal(
    (source.match(/if \(runUiSlashCommand\(base\)\) \{/g) ?? []).length,
    2,
    "handleSend 与 sendQueued 都要接管，否则运行中 /model 会被排进 follow-up 队列",
  );
});

test("扩展注册的同名命令优先，终端命令给可见提示而不是当消息发出去", () => {
  assert.match(
    source,
    /if \(\(slashCommands \?\? \[\]\)\.some\(\(command\) => command\.name\.toLowerCase\(\) === name\)\) return false;/,
    "扩展命令必须先让路（扩展可以注册与内置重名的命令）",
  );
  assert.match(source, /if \(resolved\.kind === "excluded"\) \{/);
  assert.match(source, /notifyLocal\(t\("input_commandUnsupported", \{ command: name \}\) \+ " —— " \+ resolved\.reason, "warning"\);/);
});

test("/model 与 /thinking 带参数直接生效，参数非法降级到选择器或明说", () => {
  assert.match(source, /const level = resolveThinkingLevelArgument\(args\);/);
  assert.match(source, /notifyLocal\(t\("input_thinkingLevelUnknown", \{ level: args \}\), "error"\);/);
  assert.match(source, /onThinkingLevelChange\?\.\(level\);/);
  assert.match(source, /const picked = resolveModelArgument\(args, modelList \?\? \[\]\);/);
  assert.match(source, /onModelChange\?\.\(picked\.provider, picked\.id, modelClickThinkingLevel\(cached, thinkingFallback\)\)/);
  // 必须看结果：返回 false 表示「没真的生效」，那时界面上的模型名只是乐观值，
  // 用户会以为切了 —— 所以要在界面上明说。
  assert.match(source, /if \(applied === false\) notifyLocal\(t\("input_commandFailed"\), "error"\);/);
  assert.match(source, /notifyLocal\(t\("input_modelNotFound", \{ value: args \}\), "warning"\);/);
});

test("界面动作与导出都有真实落点", () => {
  assert.match(source, /onUiAction\(resolved\.action\)/, "界面动作没透传给 AppShell");
  assert.match(source, /link\.href = buildSessionExportHtmlHref\(sessionId\);/, "导出没走既有下载链接");
  assert.match(source, /getNoticeQueueStore\(\)\.enqueue\(\{ sessionId: sessionId \?\? null, message, type \}\);/);
});

test("AppShell 把四个界面动作接到既有入口上", () => {
  const shell = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(shell, /const handleBuiltinUiAction = useCallback\(\(action: BuiltinSlashUiAction\) => \{/);
  assert.match(shell, /case "openSettings":[\s\S]{0,120}setSettingsOpen\(true\);/);
  assert.match(shell, /case "newSession":[\s\S]{0,60}handleNewSession\(\);/);
  assert.match(shell, /case "resumeSession":[\s\S]{0,160}setPaletteOpen\(true\);/);
  assert.match(shell, /case "openTree":[\s\S]{0,60}handleSelectRightTab\("branch"\);/);
  assert.match(shell, /onUiAction=\{handleBuiltinUiAction\}/, "没传给 ChatWindow");
  const window = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  assert.match(window, /onUiAction=\{onUiAction\}/, "ChatWindow 没继续往下传");
});
