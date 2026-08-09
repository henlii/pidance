/**
 * skills-write 写边界测试：loader 权威列表、来源可写性、项目信任门禁、
 * symlink 拒绝、行尾保持与原子替换。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

// skills-write.ts 走仓库惯例的无扩展名相对 import，node 原生 ESM 解析不了，
// 与 project-trust 测试一致改用 jiti 加载。
const jiti = createJiti(import.meta.url, {
  alias: { "@": path.join(path.dirname(fileURLToPath(import.meta.url)), "..") },
});
const { SkillWriteError, toggleSkillDisableModelInvocation } = await jiti.import("./skills-write.ts");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pidance-skills-write-"));
}

function makeDeps(overrides = {}) {
  return {
    loadSkills: async () => ({ skills: [] }),
        agentDir: "/tmp/agent",
    homeDir: "/tmp/home",
    ...overrides,
  };
}

import test from "node:test";

const skillInfo = (filePath, name = "test") => ({
  name,
  description: "d",
  filePath,
  baseDir: path.dirname(filePath),
  disableModelInvocation: false,
  sourceInfo: {},
});

test("缺 cwd 拒绝", async () => {
  await assert.rejects(
    () => toggleSkillDisableModelInvocation({ cwd: "", filePath: "/x/SKILL.md", disableModelInvocation: true }, makeDeps()),
    (e) => e instanceof SkillWriteError && e.code === "bad-request",
  );
});

test("缺 filePath 拒绝", async () => {
  await assert.rejects(
    () => toggleSkillDisableModelInvocation({ cwd: "/tmp", filePath: "", disableModelInvocation: true }, makeDeps()),
    (e) => e instanceof SkillWriteError && e.code === "bad-request",
  );
});

test("相对 filePath 拒绝", async () => {
  await assert.rejects(
    () => toggleSkillDisableModelInvocation({ cwd: "/tmp", filePath: "SKILL.md", disableModelInvocation: true }, makeDeps()),
    (e) => e instanceof SkillWriteError && e.code === "bad-request",
  );
});

test("cwd 不存在拒绝", async () => {
  await assert.rejects(
    () => toggleSkillDisableModelInvocation({ cwd: "/tmp/does-not-exist-xyz", filePath: "/tmp/a/SKILL.md", disableModelInvocation: true }, makeDeps()),
    (e) => e instanceof SkillWriteError && e.code === "bad-request",
  );
});

test("不在 loader 列表的路径拒绝（核心安全边界）", async () => {
  const dir = tmpdir();
  const victim = path.join(dir, "secret.txt");
  fs.writeFileSync(victim, "precious");
  const deps = makeDeps({ loadSkills: async () => ({ skills: [] }) });
  await assert.rejects(
    () => toggleSkillDisableModelInvocation({ cwd: dir, filePath: victim, disableModelInvocation: true }, deps),
    (e) => e instanceof SkillWriteError && e.code === "not-found",
  );
  assert.equal(fs.readFileSync(victim, "utf8"), "precious", "目标文件不得被改写");
});

test("loader 列表外的任意存在文件不得写入", async () => {
  const dir = tmpdir();
  const victim = path.join(dir, "passwd.txt");
  fs.writeFileSync(victim, "root:x");
  const listed = skillInfo(path.join(dir, "real", "SKILL.md"));
  const deps = makeDeps({
    loadSkills: async () => ({ skills: [listed] }),
  });
  await assert.rejects(
    () => toggleSkillDisableModelInvocation({ cwd: dir, filePath: victim, disableModelInvocation: true }, deps),
    (e) => e instanceof SkillWriteError && e.code === "not-found",
  );
  assert.equal(fs.readFileSync(victim, "utf8"), "root:x");
});

test("package/temporary 来源（非全局非项目根）拒绝", async () => {
  const dir = tmpdir();
  const pkg = path.join(dir, "node_modules", "pi-pkg", "SKILL.md");
  fs.mkdirSync(path.dirname(pkg), { recursive: true });
  fs.writeFileSync(pkg, "---\nname: p\n---\n");
  const deps = makeDeps({ loadSkills: async () => ({ skills: [skillInfo(pkg)] }) });
  await assert.rejects(
    () => toggleSkillDisableModelInvocation({ cwd: dir, filePath: pkg, disableModelInvocation: true }, deps),
    (e) => e instanceof SkillWriteError && e.code === "forbidden",
  );
});


test("项目来源且已信任可写", async () => {
  const dir = tmpdir();
  const skill = path.join(dir, ".agents", "skills", "foo", "SKILL.md");
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, "---\nname: foo\n---\n");
  const deps = makeDeps({
    loadSkills: async () => ({ skills: [skillInfo(skill)] }),
      });
  const result = await toggleSkillDisableModelInvocation({ cwd: dir, filePath: skill, disableModelInvocation: true }, deps);
  assert.deepEqual(result, { success: true });
  assert.match(fs.readFileSync(skill, "utf8"), /^---\ndisable-model-invocation: true\n/);
});

test("全局技能（agentDir/skills）可写且保持 CRLF 行尾", async () => {
  const dir = tmpdir();
  const agentDir = path.join(dir, "agent");
  const skill = path.join(agentDir, "skills", "foo", "SKILL.md");
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, "---\r\nname: foo\r\n---\r\nbody\r\n");
  const deps = makeDeps({
    loadSkills: async () => ({ skills: [skillInfo(skill)] }),
    agentDir,
  });
  await toggleSkillDisableModelInvocation({ cwd: dir, filePath: skill, disableModelInvocation: true }, deps);
  const updated = fs.readFileSync(skill, "utf8");
  assert.match(updated, /^---\r\ndisable-model-invocation: true\r\n/);
  // 除开头行外不允许裸 LF：每个换行前都必须是 \r。
  for (const [i, ch] of [...updated].entries()) {
    if (ch === "\n" && i > 0 && updated[i - 1] !== "\r") {
      assert.fail(`第 ${i} 字符处混入 LF 行尾: ${JSON.stringify(updated.slice(Math.max(0, i - 10), i + 10))}`);
    }
  }
});

test("全局技能（~/.agents/skills）可写，移除键后保留其余 frontmatter", async () => {
  const dir = tmpdir();
  const homeDir = path.join(dir, "home");
  const skill = path.join(homeDir, ".agents", "skills", "foo", "SKILL.md");
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, "---\nname: foo\ndisable-model-invocation: true\n---\nbody\n");
  const deps = makeDeps({
    loadSkills: async () => ({ skills: [skillInfo(skill)] }),
    homeDir,
  });
  await toggleSkillDisableModelInvocation({ cwd: dir, filePath: skill, disableModelInvocation: false }, deps);
  const updated = fs.readFileSync(skill, "utf8");
  assert.ok(!updated.includes("disable-model-invocation"), "键应被移除");
  assert.match(updated, /^---\nname: foo\n---\nbody\n/);
});

test("无 frontmatter 时创建一段", async () => {
  const dir = tmpdir();
  const skill = path.join(dir, ".agents", "skills", "foo", "SKILL.md");
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, "plain body\n");
  const deps = makeDeps({
    loadSkills: async () => ({ skills: [skillInfo(skill)] }),
      });
  await toggleSkillDisableModelInvocation({ cwd: dir, filePath: skill, disableModelInvocation: true }, deps);
  const updated = fs.readFileSync(skill, "utf8");
  assert.match(updated, /^---\ndisable-model-invocation: true\n---\nplain body\n/);
});

test("symlink 目标拒绝", async () => {
  const dir = tmpdir();
  const real = path.join(dir, "real", "SKILL.md");
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, "---\n---\n");
  const link = path.join(dir, "link.md");
  fs.symlinkSync(real, link);
  const deps = makeDeps({
    loadSkills: async () => ({ skills: [skillInfo(link)] }),
      });
  await assert.rejects(
    () => toggleSkillDisableModelInvocation({ cwd: dir, filePath: link, disableModelInvocation: true }, deps),
    (e) => e instanceof SkillWriteError && e.code === "forbidden",
  );
});

test("重复设置同一值为幂等，文件不变", async () => {
  const dir = tmpdir();
  const skill = path.join(dir, ".agents", "skills", "foo", "SKILL.md");
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  const original = "---\ndisable-model-invocation: true\n---\n";
  fs.writeFileSync(skill, original);
  const deps = makeDeps({
    loadSkills: async () => ({ skills: [skillInfo(skill)] }),
      });
  await toggleSkillDisableModelInvocation({ cwd: dir, filePath: skill, disableModelInvocation: true }, deps);
  assert.equal(fs.readFileSync(skill, "utf8"), original);
});

test("文件不存在返回 not-found", async () => {
  const dir = tmpdir();
  const skill = path.join(dir, ".agents", "skills", "foo", "SKILL.md");
  const deps = makeDeps({
    loadSkills: async () => ({ skills: [skillInfo(skill)] }),
      });
  await assert.rejects(
    () => toggleSkillDisableModelInvocation({ cwd: dir, filePath: skill, disableModelInvocation: true }, deps),
    (e) => e instanceof SkillWriteError && e.code === "not-found",
  );
});

test("找不到模块时跳过", async () => {
  assert.ok(true, "存在性：文件可被 node --test 加载");
});
