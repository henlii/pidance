/**
 * 项目信任同步：差量计划 + trust.json 写入（隔离 agentDir，不碰真实 ~/.pi/agent）。
 *
 * 写它是为了让侧栏「加入项目 / 关闭项目」与 subagent（pi CLI 子进程，会真的做
 * 信任判定）口径一致：加入 → true，关闭 → 撤销。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  planProjectTrustSync,
  planProjectTrustBackfill,
  syncProjectTrustBackfill,
  trustProjectRoot,
  revokeProjectTrust,
  applyProjectTrustSync,
  syncProjectTrustFromPrefs,
} = await jiti.import("./project-trust.ts");

function withDirs(fn) {
  const root = mkdtempSync(join(tmpdir(), "project-trust-"));
  const agentDir = join(root, "agent");
  const projectA = join(root, "proj-a");
  const parent = join(root, "parent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectA, { recursive: true });
  mkdirSync(join(parent, "nested", "proj-b"), { recursive: true });
  try {
    return fn({
      agentDir,
      projectA: realpathSync(projectA),
      projectB: realpathSync(join(parent, "nested", "proj-b")),
      parent: realpathSync(parent),
      trustPath: join(agentDir, "trust.json"),
      read: () => (existsSync(join(agentDir, "trust.json"))
        ? JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf8"))
        : null),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── 差量计划（纯函数） ────────────────────────────────────────────────

test("planProjectTrustSync：列表里的项目都是信任目标，移出列表的撤销", () => {
  const two = { sidebarUi: { projectRoots: ["/p/a", "/p/b"] } };
  // 首次（或本功能上线前的旧项目）：列表里的全部要确保受信
  assert.deepEqual(planProjectTrustSync({}, two), { trust: ["/p/a", "/p/b"], revoke: [] });
  // 状态没变：仍在信任目标里（写入侧跳过已受信项，不重写）
  assert.deepEqual(planProjectTrustSync(two, two), { trust: ["/p/a", "/p/b"], revoke: [] });
  // 关闭 b（= 移出列表）→ 撤销 b，a 保持
  const one = { sidebarUi: { projectRoots: ["/p/a"] } };
  assert.deepEqual(planProjectTrustSync(two, one), { trust: ["/p/a"], revoke: ["/p/b"] });
  // 一直只有 a：不再重复撤销
  assert.deepEqual(planProjectTrustSync(one, one), { trust: ["/p/a"], revoke: [] });
  // 重新加入 → 回到信任目标
  assert.deepEqual(planProjectTrustSync(one, two), { trust: ["/p/a", "/p/b"], revoke: [] });
  // 兼容顶层同名字段的形态
  assert.deepEqual(planProjectTrustSync({}, { projectRoots: ["/p/a"] }), { trust: ["/p/a"], revoke: [] });
});

test("planProjectTrustBackfill：启动时把列表里的项目拉齐（无可比的旧列表，故不撤销）", () => {
  assert.deepEqual(
    planProjectTrustBackfill({ sidebarUi: { projectRoots: ["/p/a", "/p/b"] } }),
    { trust: ["/p/a", "/p/b"], revoke: [] },
  );
  assert.deepEqual(planProjectTrustBackfill(undefined), { trust: [], revoke: [] });
});

test("planProjectTrustSync：脏数据一律过滤（空串/非字符串/重复）", () => {
  assert.deepEqual(
    planProjectTrustSync(null, { sidebarUi: { projectRoots: [1, "", "  ", "/p/a", "/p/a", "/p/b"] } }),
    { trust: ["/p/a", "/p/b"], revoke: [] },
  );
  assert.deepEqual(planProjectTrustSync(undefined, undefined), { trust: [], revoke: [] });
});

// ── trust.json 写入（真实 SDK store，同一把锁） ────────────────────────

test("trustProjectRoot：写入精确条目；已受信时不重复写", () => {
  withDirs(({ agentDir, projectA, trustPath, read }) => {
    assert.equal(trustProjectRoot(projectA, agentDir), true, "首次写入应报告已写");
    assert.deepEqual(read(), { [projectA]: true });
    const before = readFileSync(trustPath, "utf8");
    assert.equal(trustProjectRoot(projectA, agentDir), false, "已受信不应重复写");
    assert.equal(readFileSync(trustPath, "utf8"), before);
  });
});

test("trustProjectRoot：祖先已受信时仍写自己的条目（信任列表与项目一一对应）", () => {
  withDirs(({ agentDir, parent, projectB, read }) => {
    trustProjectRoot(parent, agentDir);
    assert.equal(trustProjectRoot(projectB, agentDir), true, "祖先的 true 不代替子项目自己那条");
    assert.deepEqual(read(), { [parent]: true, [projectB]: true });
    // 已有自己的条目 → 不重写
    assert.equal(trustProjectRoot(projectB, agentDir), false);
  });
});

test("revokeProjectTrust：只删自己那条，祖先条目保持", () => {
  withDirs(({ agentDir, parent, projectB, read }) => {
    trustProjectRoot(parent, agentDir);
    trustProjectRoot(projectB, agentDir);
    assert.deepEqual(read(), { [parent]: true, [projectB]: true });
    assert.equal(revokeProjectTrust(projectB, agentDir), true);
    assert.deepEqual(read(), { [parent]: true }, "撤销只删自己那条，祖先不动");
    // 已经是「只有祖先」的状态 → 不再写文件
    assert.equal(revokeProjectTrust(projectB, agentDir), false);
  });
});

test("revokeProjectTrust：本来就没有自己的条目时不动文件", () => {
  withDirs(({ agentDir, projectA, trustPath }) => {
    assert.equal(revokeProjectTrust(projectA, agentDir), false);
    assert.equal(existsSync(trustPath), false, "不应凭空创建 trust.json");
  });
});

test("applyProjectTrustSync：单个路径失败不影响其余路径", () => {
  withDirs(({ agentDir, projectA, projectB, read }) => {
    const result = applyProjectTrustSync({ trust: [projectA], revoke: [] }, agentDir);
    assert.deepEqual(result, { trusted: 1, revoked: 0, failed: [] });
    // 已受信 → 不再重写（计数为 0）
    assert.deepEqual(applyProjectTrustSync({ trust: [projectA], revoke: [] }, agentDir), {
      trusted: 0,
      revoked: 0,
      failed: [],
    });
    // 空路径/非法值不得写入：resolvePath("") 会落到进程 cwd，凭空信任一个目录
    const bad = applyProjectTrustSync({ trust: ["", "", projectB], revoke: [] }, agentDir);
    assert.equal(bad.trusted, 1, "空路径被跳过，其余照常");
    assert.deepEqual(read(), { [projectA]: true, [projectB]: true }, "只有合法路径落盘");
  });
});

// ── 偏好 → 信任 的整链 ────────────────────────────────────────────────

test("syncProjectTrustFromPrefs：列表补齐信任，移出撤销，脏输入不抛", () => {
  withDirs(({ agentDir, projectA, projectB, read }) => {
    const both = { sidebarUi: { projectRoots: [projectA, projectB] } };
    // 两个项目在列表里但从未写过信任（本功能上线前的状态）→ 一次同步全部补齐
    assert.deepEqual(syncProjectTrustFromPrefs({}, both, agentDir), { trusted: 2, revoked: 0, failed: [] });
    assert.deepEqual(read(), { [projectA]: true, [projectB]: true });
    // 再跑一次：已受信 → 不重写
    assert.deepEqual(syncProjectTrustFromPrefs(both, both, agentDir), { trusted: 0, revoked: 0, failed: [] });
    // 把 b 移出列表（关闭项目）→ 撤销
    const onlyA = { sidebarUi: { projectRoots: [projectA] } };
    assert.deepEqual(syncProjectTrustFromPrefs(both, onlyA, agentDir), { trusted: 0, revoked: 1, failed: [] });
    assert.deepEqual(read(), { [projectA]: true });
    // 脏输入：不抛、不写
    assert.deepEqual(syncProjectTrustFromPrefs(null, "nope", agentDir), { trusted: 0, revoked: 0, failed: [] });
  });
});

test("syncProjectTrustBackfill：启动把列表里的项目补齐为受信", () => {
  withDirs(({ agentDir, projectA, projectB, read }) => {
    // 本功能上线前就已加入、从未写过条目的项目 → 一次回填补齐
    assert.deepEqual(
      syncProjectTrustBackfill({ sidebarUi: { projectRoots: [projectA, projectB] } }, agentDir),
      { trusted: 2, revoked: 0, failed: [] },
    );
    assert.deepEqual(read(), { [projectA]: true, [projectB]: true });
    // 幂等：再回填不重写
    assert.deepEqual(
      syncProjectTrustBackfill({ sidebarUi: { projectRoots: [projectA, projectB] } }, agentDir),
      { trusted: 0, revoked: 0, failed: [] },
    );
  });
});
