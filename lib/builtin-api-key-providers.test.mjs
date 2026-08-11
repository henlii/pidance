import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { BUILTIN_API_KEY_PROVIDERS } = await jiti.import("./builtin-api-key-providers.ts");

test("内置 API key 供应商列表非空且无 OAuth id", () => {
  assert.ok(BUILTIN_API_KEY_PROVIDERS.length >= 10);
  const ids = new Set(BUILTIN_API_KEY_PROVIDERS.map((p) => p.id));
  assert.ok(ids.has("openai"));
  assert.ok(ids.has("openrouter"));
  assert.ok(!ids.has("openai-codex"));
  assert.ok(!ids.has("github-copilot"));
});
