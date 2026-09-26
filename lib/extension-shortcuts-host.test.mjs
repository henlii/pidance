/**
 * 插件快捷键的宿主侧集成（issue #105）：注册 → 状态投影 → 执行。
 *
 * 纯规则在 `lib/extension-shortcuts.test.mjs`；这里验的是「真链路」：
 * 扩展用 `pi.registerShortcut` 注册、宿主从**它自己的** runner 解析、清单进状态投影、
 * `run_extension_shortcut` 真的把 handler 叫起来并给它**完整扩展 ctx**。
 *
 * 冲突矩阵（保留键位被跳过、两插件同键后者胜）**只验「继承到了」**，不在这里重写规则：
 * 判定本身来自 SDK 的 `getShortcuts`（TUI 用的同一个函数，见 lib/extension-shortcuts.ts 注释）。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { startSdkSessionHost } = await jiti.import("./sdk-session-host.ts");

/** 写一个只注册快捷键的扩展文件，返回路径。`from` 用来区分「哪个扩展的 handler 跑了」。 */
function writeShortcutExtension(dir, name, registrations, markerPath) {
  const lines = [
    "import { writeFileSync } from \"node:fs\";",
    `export default function ${name}(pi) {`,
  ];
  for (const [key, description] of registrations) {
    lines.push(
      `  pi.registerShortcut(${JSON.stringify(key)}, {`,
      `    description: ${JSON.stringify(description)},`,
      "    handler: async (ctx) => {",
      `      writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({`,
      `        from: ${JSON.stringify(name)},`,
      "        cwd: ctx.cwd,",
      "        hasUI: ctx.hasUI === true,",
      "        hasNotify: typeof ctx.ui?.notify === \"function\",",
      "        isIdle: typeof ctx.isIdle === \"function\",",
      "      }));",
      "    },",
      "  });",
    );
  }
  lines.push("}", "");
  const path = join(dir, `${name}.ts`);
  writeFileSync(path, lines.join("\n"));
  return path;
}

test("插件快捷键：投影给出可用性，执行命令把完整 ctx 交给 handler", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "shortcut-host-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "shortcut-host-agent-"));
  const extDir = mkdtempSync(join(tmpdir(), "shortcut-host-ext-"));
  const markerPath = join(extDir, "handler-ran.json");

  // 两个扩展（都写进临时 agent dir 的 settings.json，不碰真实环境）：
  // - 两者都注册 ctrl+alt+7 → 后者胜；
  // - 前者还注册 ctrl+o（保留键位 app.tools.expand 的默认键）→ 应被 SDK 跳过；
  // - 前者还注册 ctrl+p（浏览器保留）→ 出现在清单里但标为不可用。
  const first = writeShortcutExtension(
    extDir,
    "qaShortcutFirst",
    [["ctrl+alt+7", "first wins only if alone"], ["ctrl+o", "reserved builtin key"], ["ctrl+p", "browser reserved"]],
    markerPath,
  );
  const second = writeShortcutExtension(extDir, "qaShortcutSecond", [["ctrl+alt+7", "later wins"]], markerPath);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [first, second] }));

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let host;
  try {
    host = await startSdkSessionHost({
      sessionId: "__new__shortcut_test",
      sessionFile: "",
      cwd,
      agentDir,
      toolNames: [],
      idleTimeoutMs: 60_000,
    });

    const state = await host.send({ type: "get_state" });
    const shortcuts = state.extensionShortcuts;
    assert.ok(Array.isArray(shortcuts), "状态投影必须带 extensionShortcuts");
    const byKey = new Map(shortcuts.map((entry) => [entry.key, entry]));

    // 可用性判定（本仓库自己的规则，见 lib/extension-shortcuts.test.mjs）
    assert.ok(byKey.has("ctrl+alt+7"), `清单里应有 ctrl+alt+7，实际 ${JSON.stringify(shortcuts)}`);
    assert.equal(byKey.get("ctrl+alt+7").available, true);
    assert.equal(byKey.get("ctrl+p").available, false, "Ctrl+P 是浏览器打印，Web 上不能绑");
    assert.equal(byKey.get("ctrl+p").reason, "browser-reserved");

    // SDK 的保留表在这里**空转**：Pidance 没有键位配置界面，传给 getShortcuts 的是「用户覆盖」
    // （通常是空对象），而 buildBuiltinKeybindings 只按这份配置自己列出内置键位 —— 没有内置键位，
    // 于是不会跳过任何注册。真正拦住这些键的是我们自己的三张表（浏览器 / 壳 / 编辑键）：
    // ctrl+o 是 app.tools.expand 的默认键，也是浏览器的「打开文件」，所以清单里仍然不可绑；
    // 18 个保留键位的默认键全部落在不可用集合内，由 lib/extension-shortcuts.test.mjs 的防漂移用例锁住。
    assert.ok(byKey.has("ctrl+o"), "SDK 保留表空转：注册不该被跳过（拦截靠本项目自己的表）");
    assert.equal(byKey.get("ctrl+o").available, false, "Ctrl+O 是浏览器打开文件，Web 上不可绑");
    assert.equal(byKey.get("ctrl+o").reason, "browser-reserved");
    // 两插件同键：后注册者胜（extensions 按 settings.json 的 packages 顺序加载）。
    assert.ok(
      String(byKey.get("ctrl+alt+7").extensionPath).includes("qaShortcutSecond"),
      `同键应后者胜，实际 ${byKey.get("ctrl+alt+7").extensionPath}`,
    );

    // 真执行：跑的是**后者**的 handler，并且它拿到完整 ctx。
    const ran = await host.send({ type: "run_extension_shortcut", key: "ctrl+alt+7" });
    assert.deepEqual(ran, { ok: true });
    assert.equal(existsSync(markerPath), true, "handler 必须被调用");
    const observed = JSON.parse(readFileSync(markerPath, "utf8"));
    assert.equal(observed.from, "qaShortcutSecond", "同键必须跑后者，而不是先注册的那个");
    assert.equal(observed.cwd, cwd);
    assert.equal(observed.hasUI, true);
    assert.equal(observed.hasNotify, true);
    assert.equal(observed.isIdle, true);

    // 保留了键名归一化：大小写/顺序不同也能命中。
    assert.deepEqual(
      await host.send({ type: "run_extension_shortcut", key: "ALT+CTRL+7" }),
      { ok: true },
    );

    // 未注册的键、非法键：如实回报，不假装跑过。
    assert.deepEqual(
      await host.send({ type: "run_extension_shortcut", key: "ctrl+alt+8" }),
      { ok: false, error: "unknown-shortcut" },
    );
    assert.deepEqual(
      await host.send({ type: "run_extension_shortcut", key: "hyper+9" }),
      { ok: false, error: "invalid-shortcut" },
    );
  } finally {
    if (host) await host.destroy?.();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    t.after(() => {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(extDir, { recursive: true, force: true });
    });
  }
});
