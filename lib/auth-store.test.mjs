import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  deleteCredential,
  getCredential,
  isProviderConfigured,
  listCredentialProviders,
  loadAuthFile,
  saveAuthFile,
  setApiKey,
} = await jiti.import("./auth-store.ts");

// ── fixtures ─────────────────────────────────────────────────────────────────

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "auth-store-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const authPath = (dir) => join(dir, "auth.json");
const modelsPath = (dir) => join(dir, "models.json");

// ── 读写往返 ────────────────────────────────────────────────────────────────

test("setApiKey + getCredential 往返", () => {
  withDir((dir) => {
    const path = authPath(dir);
    setApiKey("zenmux", "sk-123", path);
    assert.deepEqual(getCredential("zenmux", path), { type: "api_key", key: "sk-123" });
    // 文件已写入且权限为 0o600
    assert.ok(existsSync(path));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    // 未配置的 provider 返回 undefined
    assert.equal(getCredential("missing", path), undefined);
  });
});

test("loadAuthFile 缺失 → {}，损坏 → {}，非对象 → {}", () => {
  withDir((dir) => {
    const path = authPath(dir);
    assert.deepEqual(loadAuthFile(path), {});
    writeFileSync(path, "{invalid json", "utf8");
    assert.deepEqual(loadAuthFile(path), {});
    writeFileSync(path, "42", "utf8");
    assert.deepEqual(loadAuthFile(path), {});
  });
});

test("deleteCredential 删除 flat 凭据", () => {
  withDir((dir) => {
    const path = authPath(dir);
    saveAuthFile(
      { "prov-a": { type: "api_key", key: "k1" }, "prov-b": { type: "api_key", key: "k2" } },
      path,
    );
    deleteCredential("prov-a", path);
    const data = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(data, { "prov-b": { type: "api_key", key: "k2" } });
    assert.equal(getCredential("prov-a", path), undefined);
  });
});

test("deleteCredential 同时清理嵌套位置与空 providers 键", () => {
  withDir((dir) => {
    const path = authPath(dir);
    saveAuthFile(
      {
        providers: {
          "nested-a": { type: "api_key", key: "n1" },
          "nested-b": { type: "api_key", key: "n2" },
        },
      },
      path,
    );
    deleteCredential("nested-a", path);
    const data = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(data, { providers: { "nested-b": { type: "api_key", key: "n2" } } });
    // 嵌套清空后移除整个 providers 键
    deleteCredential("nested-b", path);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {});
  });
});

// ── ${ENV} 模板解析 ─────────────────────────────────────────────────────────

test("${ENV} 模板解析：命中 env 视为已配置，缺 env 视为未配置", () => {
  withDir((dir) => {
    const path = authPath(dir);
    const mp = modelsPath(dir);
    const opts = { authPath: path, modelsPath: mp };

    process.env.AUTH_STORE_TEST_KEY = "env-secret";
    try {
      setApiKey("env-prov", "${AUTH_STORE_TEST_KEY}", path);
      assert.equal(isProviderConfigured("env-prov", opts), true);
      // env 缺失（模板解析失败）→ 未配置
      delete process.env.AUTH_STORE_TEST_KEY;
      assert.equal(isProviderConfigured("env-prov", opts), false);
    } finally {
      delete process.env.AUTH_STORE_TEST_KEY;
    }

    // 非模板 key 直接按已配置
    setApiKey("plain-prov", "sk-plain", path);
    assert.equal(isProviderConfigured("plain-prov", opts), true);
  });
});

// ── providers 嵌套兼容 ──────────────────────────────────────────────────────

test("providers 嵌套兼容：flat 优先，嵌套可读", () => {
  withDir((dir) => {
    const path = authPath(dir);
    saveAuthFile(
      {
        providers: {
          "nested-prov": { type: "api_key", key: "nk" },
        },
      },
      path,
    );
    assert.deepEqual(getCredential("nested-prov", path), { type: "api_key", key: "nk" });

    // flat 与嵌套同时存在时 flat 优先
    saveAuthFile(
      {
        "dup-prov": { type: "api_key", key: "flat-key" },
        providers: {
          "dup-prov": { type: "api_key", key: "nested-key" },
        },
      },
      path,
    );
    assert.deepEqual(getCredential("dup-prov", path), { type: "api_key", key: "flat-key" });
  });
});

test("listCredentialProviders 跳过非对象键并展开嵌套", () => {
  withDir((dir) => {
    const path = authPath(dir);
    saveAuthFile(
      {
        "flat-a": { type: "api_key", key: "a" },
        "not-obj": "string-value",
        providers: {
          "nested-b": { type: "api_key", key: "b" },
          "flat-a": { type: "api_key", key: "override" },
        },
      },
      path,
    );
    const ids = listCredentialProviders(path);
    assert.deepEqual([...ids].sort(), ["flat-a", "nested-b"]);
  });
});

// ── isProviderConfigured ─────────────────────────────────────────────────────

test("isProviderConfigured：oauth 凭据与 api_key 无 key", () => {
  withDir((dir) => {
    const path = authPath(dir);
    const mp = modelsPath(dir);
    const opts = { authPath: path, modelsPath: mp };

    // oauth 有 access/refresh → 已配置
    saveAuthFile({ "oauth-prov": { type: "oauth", access: "tok", refresh: "rt" } }, path);
    assert.equal(isProviderConfigured("oauth-prov", opts), true);
    // oauth 无 access/refresh → 未配置
    saveAuthFile({ "oauth-prov": { type: "oauth", expires: 123 } }, path);
    assert.equal(isProviderConfigured("oauth-prov", opts), false);
    // api_key 空 key → 未配置
    saveAuthFile({ "empty-prov": { type: "api_key", key: "" } }, path);
    assert.equal(isProviderConfigured("empty-prov", opts), false);
  });
});

test("isProviderConfigured：models.json apiKey 兜底", () => {
  withDir((dir) => {
    const path = authPath(dir);
    const mp = modelsPath(dir);
    const opts = { authPath: path, modelsPath: mp };

    // 无 auth 无 models → 未配置
    assert.equal(isProviderConfigured("p1", opts), false);

    // models.json providers[p1].apiKey 非空 → 已配置
    writeFileSync(mp, JSON.stringify({ providers: { p1: { apiKey: "mk" } } }), "utf8");
    assert.equal(isProviderConfigured("p1", opts), true);

    // 空字符串 → 未配置
    writeFileSync(mp, JSON.stringify({ providers: { p1: { apiKey: "" } } }), "utf8");
    assert.equal(isProviderConfigured("p1", opts), false);

    // auth 凭据优先于 models.json
    setApiKey("p1", "ak", path);
    writeFileSync(mp, JSON.stringify({ providers: {} }), "utf8");
    assert.equal(isProviderConfigured("p1", opts), true);

    // 损坏的 models.json 不抛错、视为未配置
    writeFileSync(mp, "{broken", "utf8");
    deleteCredential("p1", path);
    assert.equal(isProviderConfigured("p1", opts), false);
  });
});
