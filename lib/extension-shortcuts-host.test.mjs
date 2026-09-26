/**
 * 插件快捷键的宿主侧集成（issue #105）：注册 → 状态投影 → 执行。
 *
 * 纯规则在 `lib/extension-shortcuts.test.mjs`；这里验的是「真链路」：
 * 扩展用 `pi.registerShortcut` 注册、宿主从**它自己的** runner 用**有效键位**解析、
 * 清单进状态投影、`run_extension_shortcut` 真的把 handler 叫起来并给它**完整扩展 ctx**。
 *
 * 冲突矩阵在这里是**真验**（issue #105 审查要求）：判定来自 SDK 的 `getShortcuts`（TUI 用的同一个
 * 函数），但前提是宿主把「有效键位」传进去 —— 传空对象时内置表为空、一条都不会被跳过，
 * 那正是这次要修掉的缺口：
 * - 保留键位（app.interrupt = f7，由临时 agent dir 的 keybindings.json 指定）→ 注册被**跳过**；
 * - 非保留内置键（tui.editor.jumpForward = ctrl+]）→ **插件胜**并记诊断；
 * - 两个插件同键 → **后者胜**。
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

test("插件快捷键：有效键位下保留键被跳过、非保留内置键插件胜、后者胜、执行给完整 ctx", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "shortcut-host-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "shortcut-host-agent-"));
  const extDir = mkdtempSync(join(tmpdir(), "shortcut-host-ext-"));
  const markerPath = join(extDir, "handler-ran.json");

  // 用户键位：把保留动作 app.interrupt 改到 f7，而且用**旧名**写（interrupt）。
  // 这一条同时覆盖两件事：有效键位真的读到了用户文件，以及旧名映射生效（lib/extension-shortcuts.ts
  // 的 RESERVED_LEGACY_KEYBINDING_NAMES）。旧名认不出来的话，f7 会被当成空闲键让插件绑上。
  writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify({ interrupt: "f7" }));

  const first = writeShortcutExtension(
    extDir,
    "qaShortcutFirst",
    [
      ["f7", "conflicts with app.interrupt (reserved)"],
      ["ctrl+]", "conflicts with a non-reserved builtin"],
      ["ctrl+p", "browser reserved"],
      ["ctrl+alt+7", "first wins only if alone"],
    ],
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

    // ① 保留键位：SDK 必须**跳过**这个注册（有效键位里有 app.interrupt = f7）。
    //    我们仍然把它列出来（否则用户会以为插件压根没注册），但标成不可用。
    assert.equal(byKey.get("f7")?.available, false, `f7 应被 SDK 跳过，实际 ${JSON.stringify(byKey.get("f7"))}`);
    assert.equal(byKey.get("f7")?.reason, "sdk-conflict");
    assert.equal(byKey.get("f7")?.extensionPath.includes("qaShortcutFirst"), true);

    // ② 非保留内置键（tui.editor.jumpForward = ctrl+]）：插件胜，并留下 SDK 的诊断。
    assert.equal(byKey.get("ctrl+]")?.available, true, "非保留内置键应被插件覆盖");
    const diagnostics = state.extensionShortcutDiagnostics;
    assert.ok(Array.isArray(diagnostics), "状态投影必须带 extensionShortcutDiagnostics");
    assert.ok(
      diagnostics.some((entry) => String(entry.message).includes("ctrl+]")),
      `诊断里应有 ctrl+] 的冲突说明，实际 ${JSON.stringify(diagnostics)}`,
    );

    // ③ 浏览器保留：进清单但不可绑。
    assert.equal(byKey.get("ctrl+p")?.available, false);
    assert.equal(byKey.get("ctrl+p")?.reason, "browser-reserved");

    // ④ 两插件同键：后注册者胜。
    assert.equal(byKey.get("ctrl+alt+7")?.available, true);
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

    // 被 SDK 跳过的键：命令通道必须拒绝执行（否则「UI 说不可用、服务端照样跑」）。
    assert.deepEqual(
      await host.send({ type: "run_extension_shortcut", key: "f7" }),
      { ok: false, error: "unknown-shortcut" },
    );
    // 静态判定为不可用的键同样拒绝（清单里的不可用项也在协议里出现，不能靠调用方自觉）。
    assert.deepEqual(
      await host.send({ type: "run_extension_shortcut", key: "ctrl+p" }),
      { ok: false, error: "unavailable-shortcut" },
    );

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
