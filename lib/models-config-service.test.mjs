import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getSanitizedModelsConfig,
  ModelsConfigError,
  resolveProviderSecrets,
  saveModelsConfig,
  SECRET_MASK,
  validateAndNormalize,
} from "./models-config-service.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

const KNOWN_KEY = "sk-test-secret-1234567890";
const KNOWN_HEADER_AUTH = "Bearer test-secret-token";
const KNOWN_HEADER_X = "x-secret-value";
const KNOWN_MODEL_HEADER = "model-level-secret";
const KNOWN_OVERRIDE_HEADER = "session=secret-cookie";

function fixtureConfig() {
  return {
    providers: {
      "test-provider": {
        baseUrl: "https://api.example.com/v1",
        api: "openai-completions",
        apiKey: KNOWN_KEY,
        headers: {
          "X-Custom": "plain-value",
          Authorization: KNOWN_HEADER_AUTH,
          "x-api-key": KNOWN_HEADER_X,
        },
        models: [
          { id: "m1", name: "Model 1", headers: { "X-Model": "m1-h", Authorization: KNOWN_MODEL_HEADER } },
        ],
        modelOverrides: {
          "m2": { headers: { "X-Override": "o1", Cookie: KNOWN_OVERRIDE_HEADER } },
        },
      },
    },
  };
}

function writeFixture(dir) {
  const modelsPath = join(dir, "models.json");
  writeFileSync(modelsPath, JSON.stringify(fixtureConfig(), null, 2), "utf8");
  return modelsPath;
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mc-service-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function isConflict(error) {
  return error instanceof ModelsConfigError && error.code === "conflict";
}

function isBadRequest(error) {
  return error instanceof ModelsConfigError && error.code === "bad-request";
}

// ── GET 脱敏投影 ─────────────────────────────────────────────────────────────

test("GET 投影含 apiKey 原值，敏感 header 仍打码", () => {
  withDir((dir) => {
    const modelsPath = writeFixture(dir);
    const result = getSanitizedModelsConfig(modelsPath);
    const serialized = JSON.stringify(result);

    // apiKey 下发（与 raw JSON 一致）；敏感 header 继续打码
    assert.ok(serialized.includes(KNOWN_KEY), "应包含 apiKey 原值");
    assert.ok(!serialized.includes(KNOWN_HEADER_AUTH), "不得泄露 Authorization 头");
    assert.ok(!serialized.includes(KNOWN_HEADER_X), "不得泄露 x-api-key 头");
    assert.ok(!serialized.includes(KNOWN_MODEL_HEADER), "不得泄露 model 级敏感头");
    assert.ok(!serialized.includes(KNOWN_OVERRIDE_HEADER), "不得泄露 override 级敏感头");

    const p = result.providers["test-provider"];
    assert.equal(p.apiKeyConfigured, true);
    assert.equal(p.apiKey, KNOWN_KEY);
    assert.equal(p.headers.Authorization, SECRET_MASK);
    assert.equal(p.headers["x-api-key"], SECRET_MASK);
    assert.equal(p.headers["X-Custom"], "plain-value");
    assert.equal(p.headersConfigured, true);
    assert.equal(p.models[0].headers.Authorization, SECRET_MASK);
    assert.equal(p.models[0].headers["X-Model"], "m1-h");
    assert.equal(p.modelOverrides["m2"].headers.Cookie, SECRET_MASK);
    assert.equal(p.modelOverrides["m2"].headers["X-Override"], "o1");

    const stats = statSync(modelsPath);
    assert.equal(result.baseline.mtimeMs, stats.mtimeMs);
    assert.equal(result.baseline.size, stats.size);
  });
});

test("GET 未配置 apiKey 的 provider 返回 apiKeyConfigured=false", () => {
  withDir((dir) => {
    const modelsPath = join(dir, "models.json");
    writeFileSync(modelsPath, JSON.stringify({ providers: { plain: { baseUrl: "https://x" } } }), "utf8");
    const result = getSanitizedModelsConfig(modelsPath);
    assert.equal(result.providers.plain.apiKeyConfigured, false);
    assert.ok(!("apiKey" in result.providers.plain) || result.providers.plain.apiKey === undefined);
    assert.ok(!("headers" in result.providers.plain));
  });
});

test("GET 缺失文件返回空配置与 null baseline", () => {
  withDir((dir) => {
    const result = getSanitizedModelsConfig(join(dir, "models.json"));
    assert.deepEqual(result.providers, {});
    assert.equal(result.baseline, null);
  });
});

test("GET models.json 损坏时降级为空配置且不抛错", () => {
  withDir((dir) => {
    const modelsPath = join(dir, "models.json");
    writeFileSync(modelsPath, "{ invalid json", "utf8");
    const result = getSanitizedModelsConfig(modelsPath);
    assert.deepEqual(result.providers, {});
    assert.ok(result.baseline, "损坏文件仍返回基线以便覆盖修复");
  });
});

// ── PUT 保留/删除/更新语义 ───────────────────────────────────────────────────

test("PUT 未提交 apiKey/敏感 header → 服务器现值不变", () => {
  withDir((dir) => {
    const modelsPath = writeFixture(dir);
    const baseline = getSanitizedModelsConfig(modelsPath).baseline;
    // 客户端持有 GET 投影（无 apiKey、敏感 header 打码），只改 baseUrl 后回存
    const clientView = getSanitizedModelsConfig(modelsPath);
    const incoming = {
      providers: {
        "test-provider": {
          ...clientView.providers["test-provider"],
          baseUrl: "https://new.example.com/v1",
        },
      },
    };
    const result = saveModelsConfig(modelsPath, incoming, baseline);
    assert.equal(result.success, true);
    assert.ok(result.baseline);

    const after = JSON.parse(readFileSync(modelsPath, "utf8"));
    assert.equal(after.providers["test-provider"].apiKey, KNOWN_KEY, "未提交 apiKey 应保留");
    assert.equal(after.providers["test-provider"].headers.Authorization, KNOWN_HEADER_AUTH, "掩码敏感头应保留现值");
    assert.equal(after.providers["test-provider"].headers["x-api-key"], KNOWN_HEADER_X);
    assert.equal(after.providers["test-provider"].headers["X-Custom"], "plain-value");
    assert.equal(after.providers["test-provider"].baseUrl, "https://new.example.com/v1");
    assert.equal(after.providers["test-provider"].models[0].headers.Authorization, KNOWN_MODEL_HEADER, "model 级掩码头应保留");
    assert.equal(after.providers["test-provider"].modelOverrides["m2"].headers.Cookie, KNOWN_OVERRIDE_HEADER);
    // 投影专用字段不得落盘
    assert.ok(!("apiKeyConfigured" in after.providers["test-provider"]));
    assert.ok(!("headersConfigured" in after.providers["test-provider"]));
  });
});

test("PUT 显式 apiKey: null → 删除；header 键 null → 删除", () => {
  withDir((dir) => {
    const modelsPath = writeFixture(dir);
    const baseline = getSanitizedModelsConfig(modelsPath).baseline;
    const incoming = {
      providers: {
        "test-provider": {
          baseUrl: "https://api.example.com/v1",
          api: "openai-completions",
          apiKey: null,
          headers: { "X-Custom": null },
        },
      },
    };
    saveModelsConfig(modelsPath, incoming, baseline);
    const after = JSON.parse(readFileSync(modelsPath, "utf8"));
    const provider = after.providers["test-provider"];
    assert.ok(!("apiKey" in provider), "null 应删除 apiKey");
    assert.ok(!("X-Custom" in provider.headers), "null 应删除该 header");
    assert.deepEqual(Object.keys(provider.headers), ["Authorization", "x-api-key"], "未提交键应保留");
  });
});

test("PUT 新 apiKey / 新 header 值 → 更新", () => {
  withDir((dir) => {
    const modelsPath = writeFixture(dir);
    const baseline = getSanitizedModelsConfig(modelsPath).baseline;
    const incoming = {
      providers: {
        "test-provider": {
          baseUrl: "https://api.example.com/v1",
          api: "openai-completions",
          apiKey: "sk-new-key",
          headers: { "X-Custom": "updated-value" },
        },
      },
    };
    saveModelsConfig(modelsPath, incoming, baseline);
    const after = JSON.parse(readFileSync(modelsPath, "utf8"));
    assert.equal(after.providers["test-provider"].apiKey, "sk-new-key");
    assert.equal(after.providers["test-provider"].headers["X-Custom"], "updated-value");
  });
});

test("resolveProviderSecrets：不修改入参，按保留/删除/掩码/更新语义合并", () => {
  const current = { apiKey: "server-key", headers: { Authorization: "server-auth", "X-Keep": "keep" } };
  assert.equal(resolveProviderSecrets({ apiKey: "sk-new" }, current).apiKey, "sk-new");
  assert.equal(resolveProviderSecrets({ apiKey: SECRET_MASK }, current).apiKey, "server-key");
  assert.equal(resolveProviderSecrets({ apiKey: "" }, current).apiKey, "server-key");
  assert.ok(!("apiKey" in resolveProviderSecrets({ apiKey: null }, current)));
  assert.equal(resolveProviderSecrets({}, current).apiKey, "server-key", "未提交 apiKey 应保留服务器现值");

  const headers = resolveProviderSecrets(
    { headers: { Authorization: SECRET_MASK, "X-Keep": null, "X-Add": "v" } },
    current,
  ).headers;
  assert.equal(headers.Authorization, "server-auth", "掩码敏感头保留现值");
  assert.ok(!("X-Keep" in headers), "null 删除");
  assert.equal(headers["X-Add"], "v", "新值写入");

  const incoming = { apiKey: "sk-new" };
  resolveProviderSecrets(incoming, current);
  assert.equal(incoming.apiKey, "sk-new", "不得修改入参");
});

test("validateAndNormalize：剔除投影字段并拒绝非法结构", () => {
  const normalized = validateAndNormalize({
    providers: {
      p: { baseUrl: "https://x", apiKeyConfigured: true, headersConfigured: true },
    },
  });
  assert.ok(!("apiKeyConfigured" in normalized.providers.p));
  assert.ok(!("headersConfigured" in normalized.providers.p));

  assert.throws(() => validateAndNormalize("oops"), isBadRequest);
  assert.throws(() => validateAndNormalize({ providers: "oops" }), isBadRequest);
  assert.throws(() => validateAndNormalize({ providers: { p: 42 } }), isBadRequest);
  assert.throws(() => validateAndNormalize({ providers: { p: { models: [{ id: "" }] } } }), isBadRequest);
  assert.throws(() => validateAndNormalize({ providers: { p: { apiKey: 123 } } }), isBadRequest);
  assert.throws(() => validateAndNormalize({ providers: { p: { headers: { "X": 5 } } } }), isBadRequest);
});

// ── 409 冲突检测 ─────────────────────────────────────────────────────────────

test("PUT baseline 不匹配 → 409 冲突且不覆盖文件", () => {
  withDir((dir) => {
    const modelsPath = writeFixture(dir);
    assert.throws(
      () => saveModelsConfig(modelsPath, { providers: {} }, { mtimeMs: 1, size: 1 }),
      isConflict,
    );
    assert.ok(readFileSync(modelsPath, "utf8").includes(KNOWN_KEY), "冲突时不得覆盖原文件");
  });
});

test("PUT baseline 存在但文件已被删除 → 409 冲突", () => {
  withDir((dir) => {
    const modelsPath = writeFixture(dir);
    const baseline = getSanitizedModelsConfig(modelsPath).baseline;
    rmSync(modelsPath);
    assert.throws(
      () => saveModelsConfig(modelsPath, { providers: {} }, baseline),
      isConflict,
    );
  });
});

test("PUT 无 baseline 时直接写入（新文件/首次保存路径）", () => {
  withDir((dir) => {
    const modelsPath = join(dir, "models.json");
    const result = saveModelsConfig(modelsPath, { providers: { p: { baseUrl: "https://x" } } }, null);
    assert.equal(result.success, true);
    assert.ok(existsSync(modelsPath));
  });
});

// ── schema / 大小上限 ────────────────────────────────────────────────────────

test("PUT 非法结构 → bad-request 且文件保持原状", () => {
  withDir((dir) => {
    const modelsPath = writeFixture(dir);
    const baseline = getSanitizedModelsConfig(modelsPath).baseline;
    assert.throws(() => saveModelsConfig(modelsPath, "not-an-object", baseline), isBadRequest);
    assert.throws(() => saveModelsConfig(modelsPath, { providers: { p: "oops" } }, baseline), isBadRequest);
    assert.throws(() => saveModelsConfig(modelsPath, { providers: { p: { models: [{ id: "" }] } } }, baseline), isBadRequest);
    assert.throws(() => saveModelsConfig(modelsPath, { providers: { p: { apiKey: 123 } } }, baseline), isBadRequest);
    assert.ok(readFileSync(modelsPath, "utf8").includes(KNOWN_KEY), "校验失败不得写入");
  });
});

test("PUT 超过 provider/model 数量上限 → bad-request", () => {
  withDir((dir) => {
    const modelsPath = writeFixture(dir);
    const baseline = getSanitizedModelsConfig(modelsPath).baseline;
    const manyProviders = {
      providers: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`p${i}`, {}])),
    };
    assert.throws(() => saveModelsConfig(modelsPath, manyProviders, baseline), isBadRequest);
    const manyModels = {
      providers: { p: { models: Array.from({ length: 600 }, (_, i) => ({ id: `m${i}` })) } },
    };
    assert.throws(() => saveModelsConfig(modelsPath, manyModels, baseline), isBadRequest);
  });
});

test("PUT 超过 1MiB 总字节上限 → bad-request", () => {
  withDir((dir) => {
    const modelsPath = writeFixture(dir);
    const baseline = getSanitizedModelsConfig(modelsPath).baseline;
    const oversized = {
      providers: {
        p: {
          models: Array.from({ length: 512 }, (_, i) => ({ id: `m${i}`, name: "x".repeat(4000) })),
        },
      },
    };
    assert.throws(() => saveModelsConfig(modelsPath, oversized, baseline), isBadRequest);
    assert.ok(readFileSync(modelsPath, "utf8").includes(KNOWN_KEY), "超限不得写入");
  });
});

// ── 原子写 ───────────────────────────────────────────────────────────────────

test("保存成功后目录无残留临时文件", () => {
  withDir((dir) => {
    const modelsPath = writeFixture(dir);
    const baseline = getSanitizedModelsConfig(modelsPath).baseline;
    saveModelsConfig(modelsPath, { providers: { "test-provider": { baseUrl: "https://x", api: "openai-completions", apiKey: "sk-new" } } }, baseline);
    const leftovers = readdirSync(dir).filter((name) => name.startsWith(".models-config-") && name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
    const saved = JSON.parse(readFileSync(modelsPath, "utf8"));
    assert.equal(saved.providers["test-provider"].apiKey, "sk-new");
  });
});
