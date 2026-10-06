import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  SESSION_LAZY_LOAD_MAX_COUNT,
  DEFAULT_SESSION_LAZY_LOAD_COUNT,
  DEFAULT_SESSION_LAZY_LOAD,
  sanitizeSessionLazyLoadCount,
  parseSessionLazyLoadSetting,
  sessionLazyLoadLimit,
  loadSessionLazyLoadSettingFromStorage,
  saveSessionLazyLoadSettingToStorage,
  SESSION_LAZY_LOAD_STORAGE_KEY,
} = await jiti.import("./session-lazy-load.ts");

/** 内存版 storage（与 lib/unread-sessions-storage.test.mjs 同一套注入写法）。 */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    dump: () => Object.fromEntries(map),
  };
}

test("条数清洗：合法整数通过，字符串数字按数字处理", () => {
  assert.equal(sanitizeSessionLazyLoadCount(1), 1);
  assert.equal(sanitizeSessionLazyLoadCount(37), 37);
  assert.equal(sanitizeSessionLazyLoadCount(500), 500);
  assert.equal(sanitizeSessionLazyLoadCount("30"), 30, "表单输入是字符串，应当当数字看");
  assert.equal(sanitizeSessionLazyLoadCount(" 42 "), 42);
});

test("条数清洗：非法值回落 20，超上限夹到 500", () => {
  assert.equal(DEFAULT_SESSION_LAZY_LOAD_COUNT, 20);
  for (const bad of [0, -5, 30.5, Number.NaN, Number.POSITIVE_INFINITY, "abc", "", null, undefined, {}, []]) {
    assert.equal(sanitizeSessionLazyLoadCount(bad), 20, `${JSON.stringify(bad)} 应回落 20`);
  }
  assert.equal(sanitizeSessionLazyLoadCount(501), SESSION_LAZY_LOAD_MAX_COUNT, "超上限保留意图、夹到服务端能力上限");
  assert.equal(sanitizeSessionLazyLoadCount(99999), SESSION_LAZY_LOAD_MAX_COUNT);
});

test("设置解析：缺省 = 勾选 + 20，只有显式关闭才是不勾选", () => {
  assert.deepEqual(parseSessionLazyLoadSetting(null), { enabled: true, count: 20 });
  assert.deepEqual(parseSessionLazyLoadSetting(undefined), { enabled: true, count: 20 });
  assert.deepEqual(parseSessionLazyLoadSetting("垃圾"), { enabled: true, count: 20 });
  assert.deepEqual(DEFAULT_SESSION_LAZY_LOAD, { enabled: true, count: 20 });
  // 只关了开关、没给条数 → 条数回落默认，开关保持关
  assert.deepEqual(parseSessionLazyLoadSetting({ enabled: false }), { enabled: false, count: 20 });
  assert.deepEqual(parseSessionLazyLoadSetting({ enabled: false, count: 60 }), { enabled: false, count: 60 });
  assert.deepEqual(parseSessionLazyLoadSetting({ count: 60 }), { enabled: true, count: 60 });
  // 脏条数不拖累开关
  assert.deepEqual(parseSessionLazyLoadSetting({ enabled: false, count: "x" }), { enabled: false, count: 20 });
});

test("请求形态（核心行为）：勾选带 limit=配置值，不勾选返回 null（全量、不带 limit）", () => {
  // 勾选
  assert.equal(sessionLazyLoadLimit({ enabled: true, count: 20 }), 20);
  assert.equal(sessionLazyLoadLimit({ enabled: true, count: 200 }), 200);
  assert.equal(sessionLazyLoadLimit({ enabled: true, count: "35" }), 35);
  // 不勾选 → null：调用方据此**不加 limit 参数**（服务端不切片）
  assert.equal(sessionLazyLoadLimit({ enabled: false, count: 20 }), null);
  assert.equal(sessionLazyLoadLimit({ enabled: false, count: 500 }), null);
  // 不勾选时即使给了 atLeast（换色重取）也不能变成「带 limit」
  assert.equal(sessionLazyLoadLimit({ enabled: false, count: 20 }, 480), null);
  // 勾选时 atLeast 抬高下限（换色重取要覆盖已加载的窗口），但不超过 500
  assert.equal(sessionLazyLoadLimit({ enabled: true, count: 20 }, 480), 480);
  assert.equal(sessionLazyLoadLimit({ enabled: true, count: 300 }, 100), 300);
  assert.equal(sessionLazyLoadLimit({ enabled: true, count: 20 }, 9000), SESSION_LAZY_LOAD_MAX_COUNT);
  assert.equal(sessionLazyLoadLimit({ enabled: true, count: 20 }, -3), 20);
});

test("存储往返：写入前清洗（越界值不落盘），损坏输入回落默认", () => {
  const storage = memoryStorage();
  saveSessionLazyLoadSettingToStorage(storage, { enabled: false, count: 20 });
  assert.deepEqual(storage.dump()[SESSION_LAZY_LOAD_STORAGE_KEY], JSON.stringify({ enabled: false, count: 20 }));
  saveSessionLazyLoadSettingToStorage(storage, { enabled: true, count: 9999 });
  assert.deepEqual(
    loadSessionLazyLoadSettingFromStorage(storage),
    { enabled: true, count: 500 },
    "越界值落盘前就被夹住",
  );
  assert.deepEqual(loadSessionLazyLoadSettingFromStorage(memoryStorage()), { enabled: true, count: 20 }, "没存过 → 默认");
  assert.deepEqual(
    loadSessionLazyLoadSettingFromStorage(memoryStorage({ [SESSION_LAZY_LOAD_STORAGE_KEY]: "{不是 JSON" })),
    { enabled: true, count: 20 },
  );
  const throwing = { getItem: () => { throw new Error("privacy mode"); }, setItem: () => { throw new Error("quota"); }, removeItem: () => {} };
  assert.deepEqual(loadSessionLazyLoadSettingFromStorage(throwing), { enabled: true, count: 20 }, "存储不可用 → 默认，不抛");
  saveSessionLazyLoadSettingToStorage(throwing, { enabled: true, count: 30 });
});

test("调用点契约：三处 params 请求都按配置决定带不带 limit（不勾选时不带）", () => {
  const source = readFileSync(fileURLToPath(new URL("../hooks/useAgentSession.ts", import.meta.url)), "utf8");
  // 向上翻页那处多一个「跳转专用页宽」覆盖（limitOverride），条件化写法照旧。
  assert.equal(
    (source.match(/if \((?:lazyLoadLimit|pageLimit) !== null\) params\.set\("limit", String\((?:lazyLoadLimit|pageLimit)\)\);/g) ?? []).length,
    3,
    "首屏 tail / 向上翻页 / 分支尾窗 三处都要条件化 limit",
  );
  assert.match(
    source,
    /if \(lazyLoadLimit !== null\) query\.set\("limit", String\(lazyLoadLimit\)\);/,
    "换色重取的 URL 构造也要条件化 limit",
  );
  assert.doesNotMatch(source, /limit: String\(DEFAULT_SESSION_(TAIL_LIMIT|HISTORY_PAGE)\)/, "旧硬编码常量不应再出现在请求里");
  assert.match(source, /loadSessionLazyLoadSetting, sessionLazyLoadLimit/, "调用点要引用本模块的两个函数");
  assert.match(source, /from "@\/lib\/session-lazy-load"/, "从本模块导入（不再依赖旧的硬编码常量）");
});

test("服务端前提：不带 limit 且无 before/after/around 时返回**完整上下文**（不切片）", () => {
  // 本功能的「不勾选 = 全量」完全依赖这条既有分支：parseContextLimitParam 缺省返回 null，
  // service 的 else 分支返回整条 leaf 并置 hasMoreBefore:false（客户端因此不会再翻页）。
  // 把它钉住，免得将来有人给这条 else 分支补上默认切片、让开关静默失效。
  const service = readFileSync(fileURLToPath(new URL("./session-service.ts", import.meta.url)), "utf8");
  // 只看分支形状不够：必须确认「不切片」分支真的整包返回 —— 在它里面加一次 slice(0,100)
  // 这种改动静默失效开关，形状断言完全看不出来（这条正是反向验证踩到的坑）。
  const marker = service.indexOf("} else if (limit !== null) {");
  assert.ok(marker > 0, "有切片分支");
  const elseStart = service.indexOf("} else {", marker);
  assert.ok(elseStart > marker, "也有不切片的 else 分支");
  const branch = service.slice(elseStart, service.indexOf("\n      }", elseStart)); // 整个 else 分支体（到该分支的收尾大括号）
  assert.ok(branch.length > 0, "能截出 else 分支的体");
  assert.match(branch, /\.\.\.full/, "全量分支要整包展开 full");
  assert.doesNotMatch(branch, /slice\(/, "全量分支里不得再切片（否则「不勾选=全量」静默失效）");
  const window = readFileSync(fileURLToPath(new URL("./session-context-window.ts", import.meta.url)), "utf8");
});
test("设置页契约：会话页有开关 + 条数输入，改动立刻落盘，条数失焦收口", () => {
  const source = readFileSync(fileURLToPath(new URL("../components/AgentDefaultsConfig.tsx", import.meta.url)), "utf8");
  assert.match(source, /t\("defaults_sessionLazyLoad"\)/, "复选框要有文案");
  assert.match(source, /t\("defaults_sessionLazyLoadCount"\)/, "条数输入要有文案");
  assert.match(source, /t\("defaults_sessionLazyLoadHint"\)/, "要有说明（不勾选=全量的代价）");
  assert.match(source, /saveSessionLazyLoadSetting\(next\)/, "改动要立刻落盘（本地偏好，不进 agent settings 草稿）");
  assert.match(source, /disabled=\{!lazyLoad\.enabled\}/, "不勾选时条数输入不可用");
  assert.match(source, /sanitizeSessionLazyLoadCount\(lazyLoadCountText\)/, "失焦时把半成品收口");
  // 中英文案都要在（缺一条就会在另一种语言下露出 key）
  for (const file of ["../lib/locales/en.ts", "../lib/locales/zh-CN.ts"]) {
    const locale = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    for (const key of ["defaults_sessionSection", "defaults_sessionLazyLoad", "defaults_sessionLazyLoadCount", "defaults_sessionLazyLoadHint"]) {
      assert.match(locale, new RegExp(`  ${key}:`), `${file} 缺 ${key}`);
    }
  }
});
test("反向哨兵：不勾选判定只认 enabled === false", () => {
  // 把 sessionLazyLoadLimit 的 early return 改坏后，这两条会立刻变红（报告里有两次反向验证记录）。
  assert.equal(sessionLazyLoadLimit({ enabled: false, count: 20 }), null);
  assert.equal(sessionLazyLoadLimit({ enabled: false, count: 20 }, 480), null);
  assert.ok(sessionLazyLoadLimit({ enabled: true, count: 20 }) !== null, "勾选时必须给出条数，否则等于永远全量");
});
