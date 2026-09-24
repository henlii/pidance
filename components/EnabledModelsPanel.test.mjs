/**
 * 「可用模型」面板的接线契约：cwd 必须传下去。
 *
 * 为什么是接线断言而不是渲染断言：这两条链路（面板→路由、设置页→面板）只是把 cwd 透传，
 * 真正的语义在服务端（项目级只读、项目扩展按 cwd 解析）；不带 cwd 时服务端会退回
 * process.cwd()，在 Electron/多项目下静默用错项目 —— 这种错没有可见报错，只能靠契约钉住。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("./EnabledModelsPanel.tsx", import.meta.url), "utf8");
const modelsConfig = readFileSync(new URL("./ModelsConfig.tsx", import.meta.url), "utf8");
const settingsView = readFileSync(new URL("./SettingsView.tsx", import.meta.url), "utf8");

test("面板把 cwd 带给 /api/models/enabled（GET 与 POST）", () => {
  const uses = panel.match(/api\/models\/enabled\$\{cwdQuery\}/g) ?? [];
  assert.equal(uses.length, 2, "GET 与 POST 两处都要带上 cwdQuery");
  assert.doesNotMatch(panel, /fetch\("\/api\/models\/enabled"/, "不得再有写死的裸路径请求");
  assert.match(panel, /export function EnabledModelsPanel\(\{ onModelsChanged, cwd \}/);
});

test("ModelsConfig 把 cwd 带给扩展 provider 请求与面板", () => {
  assert.match(modelsConfig, /api\/auth\/all-providers\$\{query\}/, "扩展 provider 请求要带 cwd");
  assert.match(
    modelsConfig,
    /<EnabledModelsPanel onModelsChanged=\{onAuthStateChange\} cwd=\{cwd\} \/>/,
    "面板要拿到会话 cwd",
  );
  assert.match(modelsConfig, /encodeURIComponent\(cwd\)/, "cwd 要按既有写法编码");
});

test("SettingsView 把会话 cwd 交给 ModelsConfig", () => {
  assert.match(settingsView, /<ModelsConfig embedded[^>]*cwd=\{cwd \?\? undefined\}/);
});

test("扩展 provider 加载失败的原因必须展示，不静默丢弃", () => {
  assert.match(modelsConfig, /extensionProvidersError/, "要把服务端的降级原因读出来");
  assert.match(
    modelsConfig,
    /t\("models_extensionProvidersFailed", \{ error: extensionProvidersError \}\)/,
    "要用 i18n 文案渲染出来",
  );
});
