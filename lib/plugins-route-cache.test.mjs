/**
 * 插件装卸/开关之后必须让「扩展注册的 provider」与模型目录缓存失效。
 *
 * 为什么是源码契约断言而不是行为断言：`app/api/plugins/route.ts` 直接 import
 * `lib/plugin-install.ts`，安装/卸载会真的跑 npm、需要网络与真实插件源，单测里没有注入面
 * （路由本身也只暴露 POST，没有 createXHandler 之类的注入口）。这条契约的价值在于**回归闸门**：
 * 谁把失效调用删掉，这里立刻变红。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app/api/plugins/route.ts", import.meta.url), "utf8");

test("插件动作之后同时失效扩展 provider 缓存与模型缓存", () => {
  assert.match(source, /invalidateExtensionProvidersCache\(\)/, "必须调用扩展 provider 失效入口");
  assert.match(source, /invalidateModelsCache\(\)/, "必须调用模型缓存失效入口");

  // 两个失效调用必须落在动作分派**之后**（放在之前等于刚清完又被本次结果填回去）
  const dispatchIndex = source.indexOf('body.action === "install"');
  const invalidateIndex = source.indexOf("invalidateExtensionProvidersCache()", dispatchIndex);
  assert.ok(dispatchIndex > -1, "找不到动作分派");
  assert.ok(invalidateIndex > dispatchIndex, "失效调用必须在动作分派之后");
});
