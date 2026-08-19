import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { expandTerminalSend, parseTerminalPadConfig, DEFAULT_TERMINAL_KEYS, comboToPadItem, stripAnsi } = await jiti.import("./terminal-pad.ts");

test("expandTerminalSend 解析常见转义", () => {
  assert.equal(expandTerminalSend("\\e"), "\u001b");
  assert.equal(expandTerminalSend("\\t"), "\t");
  assert.equal(expandTerminalSend("\\x03"), "\u0003");
  assert.equal(expandTerminalSend("\\e[A"), "\u001b[A");
  assert.equal(expandTerminalSend("ls\\n"), "ls\n");
});

test("parseTerminalPadConfig 缺字段回退默认快捷键、命令为空", () => {
  const empty = parseTerminalPadConfig(null);
  assert.equal(empty.keys.length, DEFAULT_TERMINAL_KEYS.length);
  assert.deepEqual(empty.commands, []);
  const bad = parseTerminalPadConfig({ keys: [{ label: "x" }], commands: [{ id: "a", label: "ls", send: "ls\\n" }] });
  assert.equal(bad.keys.length, DEFAULT_TERMINAL_KEYS.length);
  assert.equal(bad.commands.length, 1);
  assert.equal(bad.commands[0].id, "a");
});

test("comboToPadItem 由组合键生成标签和发送串", () => {
  const ctrlC = comboToPadItem({ ctrl: true, alt: false, shift: false }, { kind: "char", label: "c", ch: "c" });
  assert.equal(ctrlC.label, "Ctrl-C");
  assert.equal(expandTerminalSend(ctrlC.send), "\u0003");
  const up = comboToPadItem({ ctrl: false, alt: false, shift: false }, { kind: "special", label: "↑", send: "\\e[A" });
  assert.equal(up.label, "↑");
  assert.equal(expandTerminalSend(up.send), "\u001b[A");
});

test("stripAnsi 去掉颜色码保留正文", () => {
  assert.equal(stripAnsi("\u001b[32mhi\u001b[0m"), "hi");
});
