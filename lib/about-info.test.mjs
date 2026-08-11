import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

test("buildAboutInfo 从 package.json 形状提取版本与仓库 URL", async () => {
  const { buildAboutInfo } = await jiti.import("./about-info.ts");
  const info = buildAboutInfo({
    name: "@henlii/pidance",
    version: "0.1.0",
    homepage: "https://github.com/henlii/pidance#readme",
    repository: { type: "git", url: "git+https://github.com/henlii/pidance.git" },
    dependencies: {
      "@earendil-works/pi-coding-agent": "0.83.0",
    },
  });
  assert.equal(info.name, "Pidance");
  assert.equal(info.version, "0.1.0");
  // P2：SDK 为必需依赖，About 展示 package.json 中的精确版本
  assert.equal(info.piSdkVersion, "0.83.0");
  assert.equal(info.homepage, "https://github.com/henlii/pidance#readme");
  assert.equal(info.repository, "https://github.com/henlii/pidance");
});

test("buildAboutInfo 从 optionalDependencies 回退读 SDK 版本", async () => {
  const { buildAboutInfo } = await jiti.import("./about-info.ts");
  const info = buildAboutInfo({
    name: "@henlii/pidance",
    version: "0.1.0",
    optionalDependencies: {
      "@earendil-works/pi-coding-agent": "0.81.1",
    },
  });
  assert.equal(info.piSdkVersion, "0.81.1");
});


test("buildAboutInfo 非产品包名保持原名，不误标为 Pidance", async () => {
  const { buildAboutInfo } = await jiti.import("./about-info.ts");
  for (const name of [
    "@other/pidance",
    "pidance",
    "@henlii/pidance-fork",
    "my-fork",
  ]) {
    const info = buildAboutInfo({ name, version: "1.0.0" });
    assert.equal(info.name, name, `包名 ${name} 应保持原样`);
  }
});

test("normalizeRepositoryUrl 处理 git+https 与 .git 后缀", async () => {
  const { normalizeRepositoryUrl } = await jiti.import("./about-info.ts");
  assert.equal(
    normalizeRepositoryUrl("git+https://github.com/henlii/pidance.git"),
    "https://github.com/henlii/pidance",
  );
  assert.equal(
    normalizeRepositoryUrl({ url: "https://github.com/henlii/pidance.git" }),
    "https://github.com/henlii/pidance",
  );
  assert.equal(normalizeRepositoryUrl(null), null);
  assert.equal(normalizeRepositoryUrl(""), null);
});

test("buildAboutInfo 缺失字段时安全降级", async () => {
  const { buildAboutInfo } = await jiti.import("./about-info.ts");
  const info = buildAboutInfo({});
  assert.equal(info.name, "Pidance");
  assert.equal(info.version, "0.0.0");
  assert.equal(info.piSdkVersion, null);
  assert.equal(info.homepage, null);
  assert.equal(info.repository, null);
});
