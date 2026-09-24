import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * 定位请求的消费方必须始终挂载。
 *
 * 背景（审查阻断）：消费逻辑原先住在 MessageNavRail，而 ChatWindow 在 ≤640px
 * 不渲染导航条、导航条在没有提问时自己也返回 null —— 手机端点全文搜索命中只会
 * 切会话、不滚动。所以这里用源码形状断言把「消费方在 ChatWindow、机制在共享 hook」
 * 钉住，防止哪天又被挪回导航条。
 */
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("定位请求由 ChatWindow 消费，不再挂在导航条上", () => {
  const chatWindow = read("../components/ChatWindow.tsx");
  assert.match(chatWindow, /if \(!entryJumpRequest \|\| entryJumpRequest\.sessionId !== session\?\.id \|\| loading\) return;/, "ChatWindow 未消费定位请求");
  // 只在 nonce/会话/loading 变化时重跑：跳转实现身份会随 agentRunning 变
  assert.match(chatWindow, /\}, \[entryJumpRequest, session\?\.id, loading\]\);/, "消费 effect 绑了 jumpTo 身份（运行态一变就重跳）");
  assert.match(chatWindow, /jumpToRef\.current\(entryId\)/, "未走 ref 取最新跳转实现");
  assert.match(chatWindow, /onEntryJumpHandledRef\.current\?\.\(\)/, "成功/超限未回报上层清请求");

  const rail = read("../components/MessageNavRail.tsx");
  assert.ok(!rail.includes("jumpRequest"), "导航条不应再持有定位请求（手机端不挂载，会静默漏掉）");
  assert.ok(!rail.includes("jumpToEntry"), "导航条不应再直接调 jumpToEntry（机制归 useMessageJump）");
});

test("useMessageJump：窗口内命中也要进入浏览历史，且不依赖导航条存在", () => {
  const hook = read("./useMessageJump.ts");
  assert.match(hook, /const immediate = await waitForTarget\(\);[\s\S]{0,400}notifyBrowsingHistory\(\);/, "窗口内命中未进入浏览历史（会被切会话钉底拉回底部）");
  assert.match(hook, /railHandleRef\.current\?\.setActive\(entryId\)/, "高亮写入未走可空注册（手机端没有导航条）");
  assert.match(hook, /railHandleRef\.current\?\.syncActive\(\)/, "收尾校正未走可空注册");
  assert.match(hook, /entryId: string\): Promise<boolean>/, "jumpTo 签名变化，导航条与 ChatWindow 都依赖它");

  const rail = read("../components/MessageNavRail.tsx");
  assert.match(rail, /railHandleRef\.current = \{ setActive: setActiveEntryId, syncActive \};/, "导航条未把高亮能力注册给跳转机制");
});
