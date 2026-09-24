import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

test("规范化 locale 并安全解析持久化值", async () => {
  const { normalizeLocale, parsePersistedLocale } = await jiti.import("./i18n.tsx");
  assert.equal(normalizeLocale("zh-Hans"), "zh-CN");
  assert.equal(normalizeLocale("fr"), "en");
  assert.equal(parsePersistedLocale("not json"), null);
  assert.equal(parsePersistedLocale(JSON.stringify("zh")), "zh-CN");
  assert.equal(parsePersistedLocale(JSON.stringify({ locale: "en" })), "en");
  assert.equal(parsePersistedLocale(JSON.stringify("fr")), null);
  assert.equal(parsePersistedLocale(JSON.stringify({ locale: "fr" })), null);
  assert.equal(parsePersistedLocale(JSON.stringify({ locale: "" })), null);
  assert.equal(normalizeLocale("fr-FR"), "en");
});

test("插值、英文回退和 Intl 映射", async () => {
  const { createTranslator, getIntlLocale } = await jiti.import("./i18n.tsx");
  assert.equal(createTranslator("en")("chatInputPlaceholder"), "Message Pi...");
  assert.equal(createTranslator("zh-CN")("close"), "关闭");
  assert.equal(createTranslator("en")("localeName", { unused: "x" }), "English");
  assert.equal(getIntlLocale("zh-CN"), "zh-CN");
  assert.equal(getIntlLocale("en"), "en-US");
});

test("设置页字段标签：中英均有文案，中文保留 settings.json 原始键名", async () => {
  const { en } = await jiti.import("./locales/en.ts");
  const { zhCN } = await jiti.import("./locales/zh-CN.ts");
  const keys = [
    "defaults_unset",
    "defaults_reserveTokens",
    "defaults_keepRecentTokens",
    "defaults_maxRetries",
    "defaults_baseDelayMs",
    "defaults_httpProxy",
    "defaults_httpIdleTimeoutMs",
    "defaults_sessionDir",
    "defaults_shellPath",
    "defaults_externalEditor",
    "defaults_defaultProjectTrust",
    "defaults_doubleEscapeAction",
    "defaults_transport",
    "defaults_transportAuto",
    "defaults_transportSse",
    "defaults_transportWebsocket",
    "models_extensionProvidersFailed",
    "models_costInput",
    "models_costOutput",
    "models_costCacheRead",
    "models_costCacheWrite",
    "models_compatDeveloperRole",
    "models_compatReasoningEffort",
    "models_compatStore",
    "models_compatUsageInStreaming",
    "models_compatStrictMode",
    "models_compatSessionAffinityHeaders",
    "models_compatLongCacheRetention",
    "models_compatReasoningContentOnAssistant",
    "models_compatThinkingAsText",
    "skills_searchPlaceholder",
    "input_thinkingOff",
    "input_thinkingMinimal",
    "input_thinkingLow",
    "input_thinkingMedium",
    "input_thinkingHigh",
    "input_thinkingXhigh",
    "input_thinkingMax",
    "message_writtenThisTurn",
    "message_openWrittenFile",
    "message_writtenFilesExpand",
    "message_writtenFilesCollapse",
  ];
  for (const key of keys) {
    assert.ok(en[key]?.trim(), `en 缺 ${key}`);
    assert.ok(zhCN[key]?.trim(), `zh 缺 ${key}`);
    // 中文侧必须有中文，英文侧不得混入中文（防止漏译与语言泄漏）。
    assert.match(zhCN[key], /[\u4e00-\u9fff]/, `zh ${key} 没有中文`);
    assert.doesNotMatch(en[key], /[\u4e00-\u9fff]/, `en ${key} 混入了中文`);
  }
  // 原始键名只在中文侧保留，便于和 settings.json 对照。
  assert.match(zhCN.defaults_sessionDir, /sessionDir/);
  assert.match(zhCN.defaults_transport, /transport/);
  assert.doesNotMatch(en.defaults_sessionDir, /sessionDir/);
});

function makeMemoryStorage(initial = {}) {
  /** @type {Map<string, string>} */
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

test("locale：读取规范键与缺失回退", async () => {
  const { readPersistedLocale, I18N_STORAGE_KEY } = await jiti.import("./i18n.tsx");
  const storage = makeMemoryStorage({ [I18N_STORAGE_KEY]: JSON.stringify("zh-CN") });
  assert.equal(readPersistedLocale(storage), "zh-CN");
  assert.equal(readPersistedLocale(makeMemoryStorage()), null);
});
