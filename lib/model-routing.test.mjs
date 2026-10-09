/**
 * 虚拟模型路由显示：什么时候挂「→ 实际模型」，什么时候不挂。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { routedModelSuffix } = await jiti.import("./model-routing.ts");

test("选中的就是实际用的：不显示（普通模型不该拖一条没信息量的尾巴）", () => {
  assert.equal(
    routedModelSuffix({ id: "gpt-5.6-luna", provider: "cpa" }, { provider: "cpa", modelId: "gpt-5.6-luna" }),
    null,
  );
});

test("虚拟模型：选中的与派发的不一样 → 显示实际派发的模型与档位", () => {
  assert.deepEqual(
    routedModelSuffix({ id: "gpt-5.6-luna", provider: "cpa", thinkingLevel: "medium" }, { provider: "jev", modelId: "auto" }),
    { id: "gpt-5.6-luna", thinkingLevel: "medium" },
  );
});

test("同一模型但供应商不同 → 也算换了（路由到别家）", () => {
  assert.deepEqual(
    routedModelSuffix({ id: "gpt-5.6-luna", provider: "cpa" }, { provider: "openai-codex", modelId: "gpt-5.6-luna" }),
    { id: "gpt-5.6-luna", thinkingLevel: null },
  );
});

test("没有路由读数 / 读数残缺 / 还没选过模型：按各自规则处理", () => {
  assert.equal(routedModelSuffix(null, { provider: "cpa", modelId: "x" }), null);
  assert.equal(routedModelSuffix(undefined, null), null);
  assert.equal(routedModelSuffix({ id: "", provider: "cpa" }, null), null, "空 id 不显示");
  assert.deepEqual(
    routedModelSuffix({ id: "gpt-5.6-luna", provider: "cpa" }, null),
    { id: "gpt-5.6-luna", thinkingLevel: null },
    "还没选过模型时，实际用的是哪个更有用",
  );
});
