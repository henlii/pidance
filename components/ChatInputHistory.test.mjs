/**
 * 输入框历史回溯的**接线**守住（行为逻辑在 lib/input-history.test.mjs）。
 *
 * 这条为什么值得单独钉：接错了不会报错，只会「按 ↑ 没反应」或者更糟 ——
 * 把多行草稿里上下移动光标的行为抢掉。所以同时断言「接管条件」在位。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");

test("↑/↓ 取回历史：只在浮层没开、光标在首行/末行时接管，并把光标放到末尾", () => {
  assert.match(source, /import \{ createInputHistory, type InputHistory \} from "@\/lib\/input-history";/);
  assert.match(source, /if \(!inputHistoryRef\.current\) inputHistoryRef\.current = createInputHistory\(\);/);
  assert.match(source, /if \(\(e\.key === "ArrowUp" \|\| e\.key === "ArrowDown"\) && !isComposing\) \{/);
  // 接管条件：首行按下、末行按上才接管（多行草稿里不许多占光标移动）
  assert.match(source, /const onFirstLine = !beforeCaret\.includes\("\\n"\);/);
  assert.match(source, /const onLastLine = !afterCaret\.includes\("\\n"\);/);
  // 取到内容才拦截；填进去之后光标放末尾（否则会被放到开头，接着打字就是倒着写）
  assert.match(source, /if \(recall !== null && recall !== undefined\) \{/);
  assert.match(source, /node\.setSelectionRange\(len, len\);/);
});

test("提交成功后记进历史（五条路径都要记）", () => {
  // 普通发送 / 运行中入队 / 内置命令（宿主）/ 界面类内置命令的两条接管点（handleSend 与 sendQueued）
  assert.equal(
    (source.match(/inputHistoryRef\.current\?\.push\(base\);/g) ?? []).length,
    5,
    "有提交路径没记历史：排队发出去或走内置命令的内容就回溯不到",
  );
});
