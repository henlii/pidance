/**
 * 主题注册表与「当前主题」的验收（issue #97）：清单、只加载不切换、切换、
 * 未知名不动当前主题、用户主题目录、缺键回退、以及渲染桥把 SDK 的 `Theme` 类
 * 当实例类用（`instanceof` 通过、全局槽位与当前主题是同一个对象）。
 *
 * 隔离：`PI_CODING_AGENT_DIR` 指向临时目录（默认参数也落在里面），全程不碰真实 `~/.pi/agent`。
 *
 * 注：主题是**进程级**状态，所以每个用例先 `resetPiThemeForTests()` 把当前主题清回未加载。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = mkdtempSync(join(tmpdir(), "pidance-theme-"));
mkdirSync(join(agentDir, "themes"), { recursive: true });
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const bridge = await jiti.import("./tui-render-bridge.ts");
const registry = await jiti.import("./pi-theme-registry.ts");
// 宿主注入的就是这个类（见 lib/sdk-session-host.ts 的 setPiThemeConstructor）。
const { Theme: SdkTheme } = await import("@earendil-works/pi-coding-agent");
const SDK_THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

test.after(() => {
  rmSync(agentDir, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

function freshTheme() {
  bridge.setPiThemeConstructor(SdkTheme);
  bridge.resetPiThemeForTests();
  return bridge.loadPiTheme();
}

test("当前主题是 SDK Theme 的实例，且写进了 SDK 的全局槽位（同一个对象）", () => {
  const theme = freshTheme();
  assert.ok(theme, "内置 dark 副本应可加载");
  assert.ok(theme instanceof SdkTheme, "实例必须是 SDK 的 Theme 类（插件的 instanceof 判定与 setTheme(Theme) 分支）");
  assert.equal(theme.name, "dark");
  assert.equal(globalThis[SDK_THEME_KEY], theme, "槽位必须指向**同一个**实例，不是等价的新对象");
});

test("宿主还没注入 Theme 类时不缓存 null（注入后能恢复）", () => {
  bridge.setPiThemeConstructor(null);
  bridge.resetPiThemeForTests();
  assert.equal(bridge.loadPiTheme(), null, "没有实例类时渲染桥应回退（不渲染）");
  bridge.setPiThemeConstructor(SdkTheme);
  assert.ok(bridge.loadPiTheme(), "注入后必须能加载（证明前面那次没有被记成“主题坏了”）");
});

test("清单含 dark / light，内置主题不给假的文件路径", () => {
  const names = registry.listPiThemes(agentDir).map((info) => info.name);
  assert.ok(names.includes("dark") && names.includes("light"), `清单应含内置主题，实际：${names.join(",")}`);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), "清单按名字排序");
  const dark = registry.listPiThemes(agentDir).find((info) => info.name === "dark");
  assert.equal(dark.path, undefined, "内置主题是打包进产物的 JSON 副本，没有可读文件路径");
});

test("getTheme 只加载不切换（加载 light 之后当前主题仍是 dark）", () => {
  const current = freshTheme();
  const light = registry.loadPiThemeByName("light", agentDir);
  assert.ok(light);
  assert.ok(light instanceof SdkTheme);
  assert.equal(light.name, "light");
  assert.notEqual(light, current, "每次按名加载是独立实例");
  assert.equal(bridge.loadPiTheme(), current, "getTheme 不得改动当前主题");
  assert.equal(globalThis[SDK_THEME_KEY], current, "槽位也不得被 getTheme 改写");
});

test("getTheme 对未知 / 非法名字返回 undefined，不抛错", () => {
  for (const name of ["nope", "", "light/dark", 42, null, undefined, { name: "light" }]) {
    assert.equal(registry.loadPiThemeByName(name, agentDir), undefined, `名字 ${JSON.stringify(name)} 应返回 undefined`);
  }
});

test("setTheme(名字) 切换当前主题并同步槽位；未知名字保持当前主题不变", () => {
  freshTheme();
  const switched = registry.setPiTheme("light", agentDir);
  assert.deepEqual(switched, { success: true, name: "light" });
  const light = bridge.loadPiTheme();
  assert.equal(light.name, "light");
  assert.equal(globalThis[SDK_THEME_KEY], light);

  const failed = registry.setPiTheme("does-not-exist", agentDir);
  assert.equal(failed.success, false);
  assert.match(String(failed.error), /does-not-exist/);
  assert.equal(bridge.loadPiTheme(), light, "失败不得把当前主题换掉（SDK 会静默退回 dark，这里不跟）");
});

test("setTheme(实例) 直接切换；参数类型不对回报失败", () => {
  freshTheme();
  const dark = registry.loadPiThemeByName("dark", agentDir);
  const ok = registry.setPiTheme(dark, agentDir);
  assert.equal(ok.success, true);
  assert.equal(bridge.loadPiTheme(), dark);
  assert.equal(globalThis[SDK_THEME_KEY], dark);
  for (const bogus of [42, null, {}, { notATheme: true }]) {
    assert.equal(registry.setPiTheme(bogus, agentDir).success, false, `${JSON.stringify(bogus)} 应失败`);
  }
});

test("用户主题目录：列出、按名加载、可切换；坏文件与超限文件被忽略", () => {
  const themesDir = join(agentDir, "themes");
  // 用户主题必须是**完整**主题：SDK 的 Theme 构造器会为 scrollbarTrack/thinkingMax
  // 这类键补回退（`?? muted` / `?? thinkingXhigh`），缺到回退也解不了就抛错、主题被忽略。
  // 所以这里拿内置 dark 的完整副本改名当用户主题。
  const full = JSON.parse(readFileSync(new URL("./pi-themes/dark.json", import.meta.url), "utf8"));
  const good = join(themesDir, "my-theme.json");
  writeFileSync(good, JSON.stringify({ ...full, name: "my-theme" }), "utf8");
  writeFileSync(join(themesDir, "broken.json"), "{ not json", "utf8");
  writeFileSync(join(themesDir, "no-colors.json"), JSON.stringify({ name: "no-colors" }), "utf8");
  writeFileSync(join(themesDir, "huge.json"), JSON.stringify({ ...full, name: "huge", pad: "x".repeat(registry.MAX_USER_THEME_BYTES) }), "utf8");
  writeFileSync(join(themesDir, "not-json.txt"), JSON.stringify({ ...full, name: "txt" }), "utf8");

  const infos = registry.listPiThemes(agentDir);
  const mine = infos.find((info) => info.name === "my-theme");
  assert.ok(mine, `用户主题应在清单里，实际：${infos.map((i) => i.name).join(",")}`);
  assert.equal(mine.path, good, "用户主题给真实文件路径");
  for (const ignored of ["broken", "no-colors", "huge", "txt"]) {
    assert.equal(infos.some((info) => info.name === ignored), false, `${ignored} 应被忽略`);
  }

  const loaded = registry.loadPiThemeByName("my-theme", agentDir);
  assert.ok(loaded);
  assert.equal(loaded.name, "my-theme");
  assert.equal(loaded.sourcePath, good, "用户主题的 sourcePath 指向它的文件");
  freshTheme();
  assert.equal(registry.setPiTheme("my-theme", agentDir).success, true);
  assert.equal(bridge.loadPiTheme().name, "my-theme");

  rmSync(good);
});

test("缺键回退与背景键分类：searchMatchBg 走背景、scrollbarTrack 回退 muted", () => {
  const full = JSON.parse(readFileSync(new URL("./pi-themes/dark.json", import.meta.url), "utf8"));
  const colors = { ...full.colors, searchMatchBg: "#123456" };
  delete colors.scrollbarTrack;
  const theme = bridge.createPiThemeFromJson({ ...full, colors });
  assert.ok(theme);
  // 显式给的 searchMatchBg 必须落进背景色表（BG_COLOR_KEYS 漏键时它会被当成前景色，
  // 于是 bg() 抛错、fg() 反而成功）。
  assert.equal(theme.bg("searchMatchBg", "x"), "\u001b[48;2;18;52;86mx\u001b[49m");
  assert.throws(() => theme.fg("searchMatchBg", "x"), /Unknown theme color/);
  // SDK 构造器的回退：scrollbarTrack 缺失时用 muted。
  assert.equal(theme.getFgAnsi("scrollbarTrack"), theme.getFgAnsi("muted"));
  assert.throws(() => theme.fg("definitelyNotAColor", "x"), /Unknown theme color/);
});

test("形状不对的主题 JSON 不构造实例（外部数据按未知输入处理）", () => {
  for (const bad of [null, undefined, 42, "x", {}, { colors: "nope" }, { colors: {} }, { colors: { text: 5 } }]) {
    assert.equal(bridge.createPiThemeFromJson(bad), null, `${JSON.stringify(bad)} 不应构造出主题`);
  }
});

test("文本样式在非 TTY 进程里仍输出转义（chalk level 0 的补偿）", () => {
  const theme = freshTheme();
  // 与 TUI（chalk level 3）逐字节一致；SDK 的原实现走 chalk，在非 TTY 下返回纯文本。
  assert.equal(theme.bold("x"), "\u001b[1mx\u001b[22m");
  assert.equal(theme.italic("x"), "\u001b[3mx\u001b[23m");
  assert.equal(theme.underline("x"), "\u001b[4mx\u001b[24m");
  assert.equal(theme.inverse("x"), "\u001b[7mx\u001b[27m");
  assert.equal(theme.strikethrough("x"), "\u001b[9mx\u001b[29m");
  // 颜色路径本来就走 SDK 自己的 ANSI 拼装（不经过 chalk）。
  assert.equal(theme.fg("accent", "x"), `${theme.getFgAnsi("accent")}x\u001b[39m`);
});

test("主题切换会通知订阅者（已渲染的插件行据此重算）", () => {
  freshTheme();
  let calls = 0;
  const unsubscribe = bridge.onPiThemeChange(() => {
    calls += 1;
  });
  registry.setPiTheme("light", agentDir);
  assert.equal(calls, 1);
  unsubscribe();
  registry.setPiTheme("dark", agentDir);
  assert.equal(calls, 1, "退订之后不再收到通知");
});

test("文本样式与 chalk level 3 逐字节一致（含多行、CRLF、已有 ESC、嵌套）", () => {
  const theme = freshTheme();
  assert.equal(theme.bold("x"), "\u001b[1mx\u001b[22m");
  // 多行：chalk 在每个换行处**先关后开**（浏览器逐行解析 ANSI，只包首尾会让第二行丢样式）
  assert.equal(theme.bold("a\nb"), "\u001b[1ma\u001b[22m\n\u001b[1mb\u001b[22m");
  assert.equal(theme.italic("a\r\nb"), "\u001b[3ma\u001b[23m\r\n\u001b[3mb\u001b[23m");
  // 文本里已有的 ESC：chalk 不重开，这里也不重开
  assert.equal(theme.bold("a\u001b[31mb"), "\u001b[1ma\u001b[31mb\u001b[22m");
  // 嵌套：外层包内层
  assert.equal(theme.bold(theme.italic("x")), "\u001b[1m\u001b[3mx\u001b[23m\u001b[22m");
});

test("createLivePiTheme：同一个视图对象在切主题后给出新主题的颜色", () => {
  const dark = freshTheme();
  const view = bridge.createLivePiTheme();
  const before = view.fg("accent", "x");
  assert.equal(before, dark.fg("accent", "x"));
  registry.setPiTheme("light", agentDir);
  const current = bridge.loadPiTheme();
  assert.equal(view.fg("accent", "x"), current.fg("accent", "x"), "视图必须解析**当前**主题");
  assert.notEqual(view.fg("accent", "x"), before, "light 与 dark 的 accent 不同色，必须能看出来");
  // 数据字段仍然是数据（issue #72 的旧 Proxy 把它们变成了函数）
  assert.equal(typeof view.sourcePath, typeof current.sourcePath);
  assert.equal(view.name, current.name);
  // 方法绑定到当前实例，不能丢 this
  assert.equal(typeof view.getFgAnsi("accent"), "string");
});
