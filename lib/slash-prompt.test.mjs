import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isImmediateSlashPrompt } = await jiti.import("./slash-prompt.ts");

test("isImmediateSlashPrompt：仅识别斜杠命令", () => {
  assert.equal(isImmediateSlashPrompt("/btw what time"), true);
  assert.equal(isImmediateSlashPrompt("  /compact"), true);
  assert.equal(isImmediateSlashPrompt("btw what time"), false);
  assert.equal(isImmediateSlashPrompt("please /btw later"), false);
  assert.equal(isImmediateSlashPrompt(""), false);
});

test("Host 与 hook 对斜杠走 SDK prompt，不 busy 排队", async () => {
  const { readFile } = await import("node:fs/promises");
  const host = await readFile(new URL("./sdk-session-host.ts", import.meta.url), "utf8");
  const hook = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  assert.match(host, /isImmediateSlashPrompt/);
  assert.match(host, /await session\.prompt\(parsed\.message/);
  const fn = hook.slice(hook.indexOf("const handlePromptWithStreamingBehavior"), hook.indexOf("const handleFollowUp = "));
  assert.match(fn, /message\.trim\(\)\.startsWith\("\/"\)/);
  assert.match(fn, /type:\s*"prompt"/);
  assert.ok(
    fn.indexOf('startsWith("/")') < fn.indexOf('behavior === "followUp"'),
    "斜杠必须先于 follow-up 队列",
  );
});

