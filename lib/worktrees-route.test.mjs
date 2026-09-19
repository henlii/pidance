/**
 * 工作树的信任同步：创建 → 写 trust.json，删除 → 撤销。
 *
 * 为什么要它：工作树建在仓库**旁边**（`<repo>-worktrees/<branch>`），拿不到项目根
 * 那条信任条目；subagent 在该 cwd 下走 pi CLI 子进程，会因未受信而加载不到项目的
 * 技能/扩展。仓库是真实 git 仓库（隔离在临时目录），agentDir 也隔离。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { POST, DELETE } = await jiti.import("../app/api/worktrees/route.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

test("创建工作树 → 写信任；删除工作树 → 撤销", async () => {
  const base = mkdtempSync(join(tmpdir(), "wt-trust-"));
  const repo = join(base, "repo");
  const agentDir = join(base, "agent");
  const worktreesDir = `${realpathSync(base)}/repo-worktrees`;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(repo, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "x");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "init"]);
  const repoRoot = realpathSync(repo);
  allowFileRoot(repoRoot);
  const trustPath = join(agentDir, "trust.json");
  const readTrust = () => (existsSync(trustPath) ? JSON.parse(readFileSync(trustPath, "utf8")) : null);
  try {
    const created = await POST(new Request("http://x", {
      method: "POST",
      body: JSON.stringify({ cwd: repoRoot, branch: "feat-trust" }),
    }));
    assert.equal(created.status, 200, await created.clone().text());
    const { path: worktreePath } = await created.json();
    assert.ok(worktreePath.startsWith(worktreesDir), `工作树应在仓库旁：${worktreePath}`);
    assert.deepEqual(readTrust(), { [realpathSync(worktreePath)]: true }, "创建工作树后应写入信任");

    const removed = await DELETE(new Request("http://x", {
      method: "DELETE",
      body: JSON.stringify({ cwd: repoRoot, path: worktreePath }),
    }));
    assert.equal(removed.status, 200, await removed.clone().text());
    assert.deepEqual(readTrust(), {}, "删除工作树后应撤销信任");
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(worktreesDir, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});
