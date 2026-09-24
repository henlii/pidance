/**
 * 对端抢锁的**发现路径**必须存在且是轻量的。
 *
 * 背景（issue #89）：锁定态来自另一个进程持有的租约文件，本进程没有事件可订阅；而空闲
 * 且事件流活着时状态刷新是 2 分钟一档（RECONCILE_IDLE_MS），用它发现「对端刚抢走写权」
 * 会让用户盯着可编辑的输入框等两分钟。所以未上锁时要有一条只读探针。这里用源码形状断言
 * 把三件事钉住：① 未上锁走 /lock、上锁走既有 1s /state；② 探针只读（不得打 /state、
 * 要有可见性守卫、失败要保留现状而不是清掉锁定条）；③ 常量名与窗口可被脚本 A12 读回。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("未上锁时用 /lock 探针发现对端抢锁，上锁后仍用 /state 短轮询感知释放", () => {
  const hook = read("./useAgentSession.ts");
  assert.match(
    hook,
    /const SESSION_LOCK_PROBE_MS = 3_000;/,
    "探针间隔常量缺失或改了值（脚本 A12 的等待窗口从这行读回，别悄悄改）",
  );
  assert.match(
    hook,
    /const interval = lockedByOther[\s\S]{0,80}\? window\.setInterval\(refreshLock, 1_000\)[\s\S]{0,80}: window\.setInterval\(probeLock, SESSION_LOCK_PROBE_MS\);/,
    "上锁/未上锁两条轮询路径没有分开",
  );
});

test("探针本身只读且轻量：不打 /state、有可见性守卫、失败保留现状", () => {
  const hook = read("./useAgentSession.ts");
  const start = hook.indexOf("const probeLock = () => {");
  assert.ok(start > 0, "未找到 probeLock 定义");
  // 精确取到函数体结束（下一个缩进的 };），避免把后面的注释/refreshLock 也算进探针。
  const end = hook.indexOf("\n    };", start);
  assert.ok(end > start, "未找到 probeLock 的函数体结束");
  const probe = hook.slice(start, end);
  assert.match(probe, /\/lock`, \{ cache: "no-store" \}\)/, "探针没有打 /lock");
  assert.ok(!probe.includes("/state"), "探针里打了 /state —— 空闲期每 3s 一次完整状态投影，会把收紧掉的轮询开销加回来");
  assert.match(probe, /document\.visibilityState !== "visible"\) return;/, "探针缺可见性守卫");
  assert.match(probe, /response\.ok \? response\.json\(\) : null/, "探针没有忽略失败响应");
  assert.match(
    probe,
    /if \(cancelled \|\| !hot \|\| sessionIdRef\.current !== sid\) return;/,
    "探针在失败/换会话时应保持现状（503 不能清掉已显示的锁定条）",
  );
});

test("只读条仍优先于锁定条，且注释写明了理由", () => {
  const chatWindow = read("../components/ChatWindow.tsx");
  const branch = chatWindow.match(/\) : isReadOnly && session \? \(([\s\S]{0,500}?)\) : lockedByOther \? \(/);
  assert.ok(branch, "只读/锁定两条分支的先后顺序变了（同时成立时显示哪个是有意的决定）");
  assert.match(branch[1], /只读优先于「被对端持有」/, "优先级决定没有留下理由");
});
