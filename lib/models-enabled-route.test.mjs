/**
 * /api/models/enabled 路由：GET 返回**未过滤**目录 + 开关状态；POST 走最小编辑写回。
 *
 * 隔离 agentDir（PI_CODING_AGENT_DIR）+ 临时 cwd，不碰真实 settings.json。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { GET, POST } = await jiti.import("../app/api/models/enabled/route.ts");

const MODELS_JSON = JSON.stringify(
  {
    providers: {
      cpa: {
        name: "CPA",
        baseUrl: "https://example.invalid",
        apiKey: "test-key",
        models: [
          { id: "grok-4.6", name: "Grok 4.6" },
          { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
        ],
      },
    },
  },
  null,
  2,
);

async function withWorkspace(fn, { settingsBody, projectBody, modelsBody } = {}) {
  const agentDir = mkdtempSync(join(tmpdir(), "models-enabled-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "models-enabled-cwd-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    if (settingsBody !== undefined) writeFileSync(join(agentDir, "settings.json"), settingsBody, "utf8");
    if (modelsBody !== undefined) writeFileSync(join(agentDir, "models.json"), modelsBody, "utf8");
    if (projectBody !== undefined) {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "settings.json"), projectBody, "utf8");
    }
    return await fn({ agentDir, cwd });
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

function request(method, cwd, body) {
  const url = `http://localhost/api/models/enabled?cwd=${encodeURIComponent(cwd)}`;
  return new Request(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
}

test("GET：返回完整目录（含被关掉的）+ enabled 标记 + 状态位", async () => {
  await withWorkspace(
    async ({ cwd }) => {
      const res = await GET(request("GET", cwd));
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.unreadable, false);
      assert.equal(data.projectOverride, false);
      assert.equal(data.enabledModels, null);
      const refs = data.models.map((m) => m.ref).sort();
      assert.deepEqual(refs, ["cpa/deepseek-v4.1-flash", "cpa/grok-4.6"]);
      assert.ok(data.models.every((m) => m.enabled === true), "未过滤时全部为启用");
    },
    { modelsBody: MODELS_JSON, settingsBody: '{ "theme": "chamber" }\n' },
  );
});

test("GET：enabledModels 生效时被关掉的模型仍列出，但 enabled=false", async () => {
  await withWorkspace(
    async ({ cwd }) => {
      const data = await (await GET(request("GET", cwd))).json();
      const byRef = Object.fromEntries(data.models.map((m) => [m.ref, m.enabled]));
      assert.deepEqual(byRef, { "cpa/grok-4.6": true, "cpa/deepseek-v4.1-flash": false });
    },
    {
      modelsBody: MODELS_JSON,
      settingsBody: '{ "theme": "chamber", "enabledModels": ["cpa/grok-4.6"] }\n',
    },
  );
});

test("POST 停用（未过滤时）：物化列表写回，其它键逐字节不变", async () => {
  await withWorkspace(
    async ({ agentDir, cwd }) => {
      const settingsPath = join(agentDir, "settings.json");
      const before = readFileSync(settingsPath, "utf8");
      const res = await POST(request("POST", cwd, { ref: "cpa/grok-4.6", enabled: false }));
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data.enabledModels, ["cpa/deepseek-v4.1-flash"]);

      const after = readFileSync(settingsPath, "utf8");
      // 比较「去掉新属性之后」的其余文本：只允许在拼接点留下一个逗号（追加属性的必然结果），
      // 其它任何行的排版变化都会被这条断言抓住。
      const strip = (text) =>
        text
          .split("\n")
          .filter((line) => !line.includes("enabledModels"))
          .join("\n")
          .replace(/,(\r?\n\}\r?\n?)$/, "$1");
      assert.equal(strip(after), strip(before), "其它行必须逐字节不变");
      assert.equal(JSON.parse(after).theme, "chamber");
      assert.deepEqual(JSON.parse(after).tools, ["bash", "read"]);
    },
    {
      modelsBody: MODELS_JSON,
      // 多行（pi 自己写的形状）才能做行级逐字节比较
      settingsBody: '{\n  "theme": "chamber",\n  "tools": ["bash", "read"]\n}\n',
    },
  );
});

test("POST 停用最后一个：409，且文件不动", async () => {
  await withWorkspace(
    async ({ agentDir, cwd }) => {
      const settingsPath = join(agentDir, "settings.json");
      const before = readFileSync(settingsPath, "utf8");
      const res = await POST(request("POST", cwd, { ref: "cpa/grok-4.6", enabled: false }));
      assert.equal(res.status, 409);
      assert.equal((await res.json()).code, "last-model");
      assert.equal(readFileSync(settingsPath, "utf8"), before);
    },
    { modelsBody: MODELS_JSON, settingsBody: '{ "enabledModels": ["cpa/grok-4.6"] }\n' },
  );
});

test("POST：settings.json 解析失败 → 422，文件原样", async () => {
  const broken = '{ "theme": "chamber", oops }\n';
  await withWorkspace(
    async ({ agentDir, cwd }) => {
      const settingsPath = join(agentDir, "settings.json");
      const res = await POST(request("POST", cwd, { ref: "cpa/grok-4.6", enabled: false }));
      assert.equal(res.status, 422);
      assert.equal((await res.json()).code, "unreadable");
      assert.equal(readFileSync(settingsPath, "utf8"), broken);
    },
    { modelsBody: MODELS_JSON, settingsBody: broken },
  );
});

test("POST：项目级覆盖 enabledModels → 409 且全局文件不动", async () => {
  await withWorkspace(
    async ({ agentDir, cwd }) => {
      const settingsPath = join(agentDir, "settings.json");
      const before = readFileSync(settingsPath, "utf8");
      const res = await POST(request("POST", cwd, { ref: "cpa/grok-4.6", enabled: false }));
      assert.equal(res.status, 409);
      assert.equal((await res.json()).code, "project-override");
      assert.equal(readFileSync(settingsPath, "utf8"), before);
      // GET 也要把只读原因带出来，界面才能解释为什么不能改
      const view = await (await GET(request("GET", cwd))).json();
      assert.equal(view.projectOverride, true);
    },
    {
      modelsBody: MODELS_JSON,
      settingsBody: '{ "theme": "chamber" }\n',
      projectBody: '{ "enabledModels": ["cpa/grok-4.6"] }\n',
    },
  );
});

test("POST：参数非法 → 400", async () => {
  await withWorkspace(
    async ({ cwd }) => {
      for (const body of [undefined, {}, { ref: 42, enabled: true }, { ref: "a/b" }, { ref: "", enabled: true }]) {
        const res = await POST(request("POST", cwd, body));
        assert.equal(res.status, 400, `body=${JSON.stringify(body)}`);
      }
    },
    { modelsBody: MODELS_JSON, settingsBody: "{}\n" },
  );
});
