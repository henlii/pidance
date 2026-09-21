/**
 * #27 A2 门禁：**打开 / attach 会话不得 wake**。
 *
 * 契约（产品决定 2026-09-21）：打开空闲会话只读磁盘投影，不创建 live host、不抢 writer 租约；
 * 只有**发送握手**才 `?wake=1`（等价 ensureLive）+ 连流。31415 与 31416 共用 agentDir 时，
 * 「打开即预热」会让仅浏览会话就占住另一进程的 writer。
 *
 * 为什么用静态门禁而不是行为测试：这条约束的价值在于**将来别被顺手加回来**（例如某个新功能
 * 想在打开时预热上下文）。行为测试只能覆盖当下已有的路径；源码门禁能拦住新增调用点。
 *
 * 失败时怎么办：如果你的新功能确实需要在打开时唤醒 host，那是在改产品契约 —— 先改
 * `AGENTS.md` 与 `pidance-runtime` / `pidance-sse` skill 里的表述，再来扩展本文件的允许清单。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("../", import.meta.url).pathname;
const STATE_ROUTE = "app/api/sessions/[id]/state/route.ts";
const REGISTRY = "lib/browser-session-runtime-registry.ts";

const read = (rel) => readFile(join(ROOT, rel), "utf8");

test("#27 A2 门禁：state 路由只有在显式 ?wake=1 时才 ensureLive（默认不预热）", async () => {
  const src = await read(STATE_ROUTE);
  const lines = src.split("\n");

  // wake 的判定必须是「显式 ?wake=1」——不接受任何等价默认值。
  assert.match(
    src,
    /searchParams\.get\("wake"\) === "1"/,
    "state 路由必须用 `searchParams.get(\"wake\") === \"1\"` 判定唤醒：默认不 wake",
  );

  const ensureLines = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.includes("ensureLive("));
  assert.equal(
    ensureLines.length,
    1,
    `state 路由只允许一处 ensureLive（预热入口唯一且必须带 wake 门）；实际 ${ensureLines.length} 处`,
  );

  const { index } = ensureLines[0];
  const window = lines.slice(Math.max(0, index - 4), index + 1).join("\n");
  assert.match(
    window,
    /if \(wake && !result\.live\)/,
    "ensureLive 必须紧跟在 `if (wake && !result.live)` 门内：否则打开空闲会话就会预热（A2 破坏）",
  );
});

test("#27 A2 门禁：唤醒调用只允许出现在发送握手路径（attach / 打开路径零 wake）", async () => {
  const src = await read(REGISTRY);
  const lines = src.split("\n");

  // `?wake=1` 只允许出现在 wake 依赖自己的实现里。
  const wakeUrlLines = lines.map((line, index) => ({ line, index: index + 1 })).filter(({ line }) => line.includes("wake=1"));
  assert.equal(
    wakeUrlLines.length,
    1,
    `?wake=1 只允许出现在 lib/.../wake() 的实现里；实际 ${wakeUrlLines.length} 处（第 ${wakeUrlLines.map((l) => l.index).join(", ")} 行）`,
  );

  // `deps.wake(...)` 只允许一处，且必须被「非新会话才 wake」的门守着。
  const callSites = lines.map((line, index) => ({ line, index })).filter(({ line }) => /deps\.wake\(/.test(line));
  assert.equal(
    callSites.length,
    1,
    "只允许发送握手一处调用 deps.wake；新增调用点会让「打开会话」重新变成抢占 writer（A2 破坏）",
  );
  assert.match(
    lines.slice(Math.max(0, callSites[0].index - 1), callSites[0].index + 1).join("\n"),
    /if \(!newSessionJustEnsured && deps\.wake\)/,
    "deps.wake 必须只在「非刚 ensure 的旧会话」分支里调用",
  );

  // 其余提到 wake 的行只允许是注释或该依赖自身的实现细节 —— 任何新用法都会落到这里失败。
  const allowed = [
    /^\s*(\/\/|\*|\/\*)/,            // 注释
    /wake\?: \(/,                    // 依赖声明
    /deps\.wake/,                    // 受门的调用点
    /async wake\(sessionId, signal\)/, // 依赖实现
    /const wake = await fetch\(/,     // 实现内部的本地变量
    /if \(!wake\.ok\)/,
    /wakeBody/,
    /wake\.status/,
  ];
  const offenders = lines
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => line.includes("wake"))
    .filter(({ line }) => !allowed.some((pattern) => pattern.test(line)));
  assert.deepEqual(
    offenders,
    [],
    `这些行的 wake 用法不在允许清单里（打开 / attach 路径不得 wake）：\n`
      + offenders.map(({ line, index }) => `  ${REGISTRY}:${index}: ${line.trim()}`).join("\n"),
  );
});

test("#27 A2 门禁：会话打开链路（hook / 侧栏）完全不发 wake 请求", async () => {
  for (const rel of ["hooks/useAgentSession.ts", "components/SessionSidebar.tsx"]) {
    const src = await read(rel);
    assert.ok(
      !src.includes("wake=1") && !/\?wake\b/.test(src),
      `${rel} 不得带 wake 参数：打开会话（含热状态 GET、侧栏列表）只读投影，不预热 host`,
    );
  }
});
