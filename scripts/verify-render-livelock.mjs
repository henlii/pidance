/**
 * 验证：超大工具输出 × 高频重渲时，事件循环还能不能跑定时器（2026-10-07 31415 卡死事故）。
 *
 * 跑法（要能在工作区解析到 jiti / pi-tui，所以必须放在仓库里跑）：
 *   cd <repo> && node scripts/verify-render-livelock.mjs
 *
 * 复刻的是事故现场那条路径：真 pi-tui 的 `Box(背景色) > Markdown(55 万字符)`，
 * 插件每 80ms invalidate 一次（pi-advisor-flow 的 spinner），宿主按 lib/tool-render-scheduler.ts
 * 的限频重渲；同时挂一个 100ms 的「心跳」定时器（对应租约心跳 / SSE heartbeat）。
 *
 * 期望：改前（固定 100ms 间隔）渲染占满墙钟、心跳被饿死；改后（lib/render-budget.ts 的开销预算）
 * 渲染占比回到约 1/4，心跳照常。
 */

import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { Markdown, Box } from "@earendil-works/pi-tui";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { createRenderBudget } = await jiti.import("../lib/render-budget.ts");
const { createToolRenderScheduler } = await jiti.import("../lib/tool-render-scheduler.ts");

const id = (t) => t;
const theme = { heading: id, link: id, linkUrl: id, code: id, codeBlock: id, codeBlockBorder: id, quote: id, quoteBorder: id, hr: id, listBullet: id, bold: id, italic: id, strikethrough: id, underline: id };
const para = "The advisor streams prose back in deltas. Each delta re-renders the whole partial output, so cost grows with total length, not with the delta size. ";
function makeText(chars) {
  let out = "";
  while (out.length < chars) out += `## Section ${Math.floor(out.length / 2000)}\n\n${para.repeat(6)}\n\n- ${para.slice(0, 80)}\n- ${para.slice(0, 60)}\n\n`;
  return out.slice(0, chars);
}
const TEXT = makeText(550_000);
const renderOnce = () => {
  const box = new Box(1, 0, (t) => `\x1b[48;5;236m${t}\x1b[49m`);
  box.addChild(new Markdown(TEXT, 0, 0, theme));
  return box.render(100).length;
};

async function run({ label, budgeted, ms = 6000 }) {
  const budget = budgeted ? createRenderBudget({ baseMs: 100 }) : null;
  let renders = 0;
  const scheduler = createToolRenderScheduler({
    minIntervalMs: budget ? () => budget.minIntervalMs() : 100,
    recompute: () => {
      const t0 = performance.now();
      const lines = renderOnce();
      const cost = performance.now() - t0;
      renderMs += cost;
      if (budget) budget.record(cost);
      renders += 1;
      return { lines };
    },
    emit: () => {},
  });
  // 插件自己的 spinner：每 80ms 一次 invalidate（事故里 pi-advisor-flow 就是这样）
  const invalidate = setInterval(() => scheduler.request("k"), 80);
  // 「租约心跳 / SSE heartbeat」：同一个事件循环里的 100ms 定时器
  let ticks = 0;
  let maxGap = 0;
  let renderMs = 0;
  let last = performance.now();
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks += 1;
  }, 100);
  const started = performance.now();
  await new Promise((r) => setTimeout(r, ms));
  const wall = performance.now() - started;
  clearInterval(invalidate);
  clearInterval(heartbeat);
  scheduler.dispose();
  const expected = Math.round(wall / 100);
  const duty = renderMs / wall;
  console.log(`${label}: 重渲 ${renders} 次 / ${(wall / 1000).toFixed(1)}s；渲染占墙钟 ${(duty * 100).toFixed(0)}%；心跳 ${ticks}/${expected} 次，最大间隔 ${maxGap.toFixed(0)}ms`);
  return { renders, ticks, expected, maxGap, duty };
}

const fixed = await run({ label: "改前（固定 100ms 间隔）", budgeted: false });
const budgeted = await run({ label: "改后（开销预算）", budgeted: true });
console.log("\n结论：", fixed.duty > 0.9 ? "固定间隔下渲染占满事件循环（复现事故）" : "未复现",
  "|", budgeted.duty < 0.4 ? "预算把渲染占比压回 1/4，心跳照常（修好）" : "预算下占比仍偏高");
console.log("注：单次渲染是同步的，它仍会把一个 100ms 定时器最多推后「一次渲染」的时长 —— 要保证的是渲染不占满事件循环，而不是单次不卡。");
