/**
 * skill-discovery 测试：磁盘扫描、项目信任门禁、同名碰撞与 settings 路径。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import test from "node:test";

// skill-discovery.ts 走仓库惯例的无扩展名相对 import，node 原生 ESM 解析不了，
// 与 skills-write 测试一致改用 jiti 加载。
const jiti = createJiti(import.meta.url, {
  alias: { "@": path.join(path.dirname(fileURLToPath(import.meta.url)), "..") },
});
const { discoverSkills } = await jiti.import("./skill-discovery.ts");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pidance-skill-discovery-"));
}

function writeSkill(file, name, extra = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nname: ${name}\n${extra}---\nbody\n`);
}

test("有 SKILL.md 的子目录被发现（agentDir/skills，scope=user）", () => {
  const dir = tmpdir();
  const agentDir = path.join(dir, "agent");
  const cwd = path.join(dir, "proj");
  fs.mkdirSync(cwd, { recursive: true });
  writeSkill(path.join(agentDir, "skills", "foo", "SKILL.md"), "foo");
  const { skills, diagnostics } = discoverSkills({
    cwd,
    agentDir,
    
    homeDir: path.join(dir, "home"),
  });
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "foo");
  assert.equal(skills[0].filePath, path.join(agentDir, "skills", "foo", "SKILL.md"));
  assert.deepEqual(skills[0].sourceInfo, { source: "local", scope: "user" });
  assert.equal(diagnostics.length, 0);
});


test("projectTrusted=true 时扫项目技能（.pi/skills 与 .agents/skills，scope=project）", () => {
  const dir = tmpdir();
  const agentDir = path.join(dir, "agent");
  const cwd = path.join(dir, "proj");
  fs.mkdirSync(cwd, { recursive: true });
  writeSkill(path.join(cwd, ".pi", "skills", "pi-skill", "SKILL.md"), "pi-skill");
  writeSkill(path.join(cwd, ".agents", "skills", "agents-skill", "SKILL.md"), "agents-skill");
  const { skills } = discoverSkills({
    cwd,
    agentDir,
    
    homeDir: path.join(dir, "home"),
  });
  assert.deepEqual(skills.map((s) => s.name).sort(), ["agents-skill", "pi-skill"]);
  for (const skill of skills) assert.deepEqual(skill.sourceInfo, { source: "local", scope: "project" });
});

test("同名碰撞：保留先扫描到的，产生 collision 诊断", () => {
  const dir = tmpdir();
  const agentDir = path.join(dir, "agent");
  const cwd = path.join(dir, "proj");
  fs.mkdirSync(cwd, { recursive: true });
  const winner = path.join(agentDir, "skills", "dup", "SKILL.md");
  writeSkill(winner, "dup");
  const loser = path.join(cwd, ".agents", "skills", "dup", "SKILL.md");
  writeSkill(loser, "dup");
  const { skills, diagnostics } = discoverSkills({
    cwd,
    agentDir,
    
    homeDir: path.join(dir, "home"),
  });
  assert.equal(skills.length, 1);
  assert.equal(skills[0].filePath, winner, "保留先扫描到的（agentDir 优先）");
  const collision = diagnostics.find((d) => d.type === "collision");
  assert.ok(collision, "应有 collision 诊断");
  assert.equal(collision.path, loser);
});

test("根下直接 .md 子文件被发现，name 缺省用文件 basename", () => {
  const dir = tmpdir();
  const agentDir = path.join(dir, "agent");
  const cwd = path.join(dir, "proj");
  fs.mkdirSync(cwd, { recursive: true });
  const file = path.join(agentDir, "skills", "quick.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "---\ndescription: d\n---\n");
  const { skills } = discoverSkills({
    cwd,
    agentDir,
    
    homeDir: path.join(dir, "home"),
  });
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "quick");
  assert.equal(skills[0].description, "d");
});

test("frontmatter 解析：disable-model-invocation 为 true，name 缺省用父目录名", () => {
  const dir = tmpdir();
  const agentDir = path.join(dir, "agent");
  const cwd = path.join(dir, "proj");
  fs.mkdirSync(cwd, { recursive: true });
  const file = path.join(agentDir, "skills", "my-skill", "SKILL.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "---\ndisable-model-invocation: true\n---\n");
  const { skills } = discoverSkills({
    cwd,
    agentDir,
    
    homeDir: path.join(dir, "home"),
  });
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "my-skill");
  assert.equal(skills[0].description, "");
  assert.equal(skills[0].disableModelInvocation, true);
});

test("跳过 node_modules 与点开头的目录", () => {
  const dir = tmpdir();
  const agentDir = path.join(dir, "agent");
  const cwd = path.join(dir, "proj");
  fs.mkdirSync(cwd, { recursive: true });
  writeSkill(path.join(agentDir, "skills", "node_modules", "pkg", "SKILL.md"), "pkg");
  writeSkill(path.join(agentDir, "skills", ".hidden", "SKILL.md"), "hidden");
  writeSkill(path.join(agentDir, "skills", "visible", "SKILL.md"), "visible");
  const { skills } = discoverSkills({
    cwd,
    agentDir,
    
    homeDir: path.join(dir, "home"),
  });
  assert.deepEqual(skills.map((s) => s.name), ["visible"]);
});

test("settings.json 的 skills 路径列表额外扫描（文件与目录）", () => {
  const dir = tmpdir();
  const agentDir = path.join(dir, "agent");
  const cwd = path.join(dir, "proj");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ skills: [path.join(cwd, "extra-dir"), path.join(cwd, "single.md")] }),
  );
  writeSkill(path.join(cwd, "extra-dir", "extra", "SKILL.md"), "extra");
  fs.writeFileSync(path.join(cwd, "single.md"), "---\nname: single\n---\n");
  const { skills } = discoverSkills({
    cwd,
    agentDir,
    
    homeDir: path.join(dir, "home"),
  });
  assert.deepEqual(skills.map((s) => s.name).sort(), ["extra", "single"]);
});

test("projectTrusted=true 时向上收集祖先 .agents/skills（排除用户全局）", () => {
  const dir = tmpdir();
  const agentDir = path.join(dir, "agent");
  const homeDir = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  const cwd = path.join(repo, "packages", "app");
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(repo, ".git"), ""); // 标记 git 仓库根
  writeSkill(path.join(repo, ".agents", "skills", "ancestor-skill", "SKILL.md"), "ancestor-skill");
  writeSkill(path.join(homeDir, ".agents", "skills", "user-skill", "SKILL.md"), "user-skill");
  const { skills } = discoverSkills({ cwd, agentDir,  homeDir });
  assert.deepEqual(skills.map((s) => s.name).sort(), ["ancestor-skill", "user-skill"]);
  const ancestor = skills.find((s) => s.name === "ancestor-skill");
  assert.deepEqual(ancestor.sourceInfo, { source: "local", scope: "project" });
  const user = skills.find((s) => s.name === "user-skill");
  assert.deepEqual(user.sourceInfo, { source: "local", scope: "user" });
});

test("坏 symlink 跳过", () => {
  const dir = tmpdir();
  const agentDir = path.join(dir, "agent");
  const cwd = path.join(dir, "proj");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(agentDir, "skills"), { recursive: true });
  fs.symlinkSync(path.join(dir, "nonexistent-target"), path.join(agentDir, "skills", "broken"));
  writeSkill(path.join(agentDir, "skills", "ok", "SKILL.md"), "ok");
  const { skills } = discoverSkills({
    cwd,
    agentDir,
    
    homeDir: path.join(dir, "home"),
  });
  assert.deepEqual(skills.map((s) => s.name), ["ok"]);
});
