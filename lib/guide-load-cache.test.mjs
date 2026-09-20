import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateGuideProjects,
  mergeAddedProjectRoots,
  withTargetProject,
} from "./guide-load-cache.ts";

// ── 项目列表聚合 ──

test("aggregates sessions into recent projects sorted by latest activity", () => {
  const sessions = [
    { cwd: "/a", modified: "2026-08-03T10:00:00.000Z" },
    { cwd: "/b", modified: "2026-08-03T11:00:00.000Z" },
    { cwd: "/a", modified: "2026-08-03T12:00:00.000Z" },
    { created: "2026-08-03T09:00:00.000Z" }, // 无 cwd，忽略
    { cwd: "/c" }, // 无时间，latest=0
  ];
  const projects = aggregateGuideProjects(sessions);
  assert.deepEqual(projects, [
    { cwd: "/a", count: 2, latest: Date.parse("2026-08-03T12:00:00.000Z") },
    { cwd: "/b", count: 1, latest: Date.parse("2026-08-03T11:00:00.000Z") },
    { cwd: "/c", count: 1, latest: 0 },
  ]);
});

test("aggregateGuideProjects respects the limit", () => {
  const sessions = ["/p1", "/p2", "/p3"].map((cwd) => ({ cwd }));
  assert.equal(aggregateGuideProjects(sessions, 2).length, 2);
});

test("aggregateGuideProjects 并入无会话的已添加项目（置顶，count=0）", () => {
  const sessions = [{ cwd: "/repo", modified: "2026-08-03T10:00:00.000Z" }];
  const projects = aggregateGuideProjects(sessions, 12, ["/empty-project", "/repo"]);
  assert.deepEqual(projects, [
    { cwd: "/empty-project", count: 0, latest: 0 },
    { cwd: "/repo", count: 1, latest: Date.parse("2026-08-03T10:00:00.000Z") },
  ]);
  // 已有会话的项目不重复、已添加项目不重复（已知集合过滤）
  const again = aggregateGuideProjects(sessions, 12, ["/repo"]);
  assert.equal(again.length, 1);
  assert.equal(again[0].cwd, "/repo");
  // limit 生效
  assert.equal(aggregateGuideProjects(sessions, 1, ["/empty-project"]).length, 1);
});

// ── 已添加项目并入项目列表（引导页在侧栏新增项目后刷新用）──

test("mergeAddedProjectRoots：新增项目置顶并入、已知项目不重复、无新增保持原引用", () => {
  const projects = [{ cwd: "/repo", count: 2, latest: 5 }];
  const merged = mergeAddedProjectRoots(projects, ["/new", "/repo"]);
  assert.deepEqual(merged, [
    { cwd: "/new", count: 0, latest: 0 },
    { cwd: "/repo", count: 2, latest: 5 },
  ]);
  // 无新增：返回原数组引用（调用方按引用判等，避免无谓重渲染）
  assert.equal(mergeAddedProjectRoots(projects, ["/repo"]), projects);
  // 空列表只并入新项目
  assert.deepEqual(mergeAddedProjectRoots([], ["/x"]), [{ cwd: "/x", count: 0, latest: 0 }]);
});

test("mergeAddedProjectRoots：新项目仍受 limit 约束且置顶不被截掉", () => {
  const projects = ["/a", "/b"].map((cwd) => ({ cwd, count: 1, latest: 0 }));
  const merged = mergeAddedProjectRoots(projects, ["/new"], 2);
  assert.deepEqual(merged.map((p) => p.cwd), ["/new", "/a"]);
});

test("withTargetProject：目标不在列表内时补临时项，已在列表则保持原引用", () => {
  const projects = [{ cwd: "/repo", count: 2, latest: 5 }];
  assert.deepEqual(withTargetProject(projects, "/repo-worktrees/feat"), [
    { cwd: "/repo-worktrees/feat", count: 0, latest: 0 },
    { cwd: "/repo", count: 2, latest: 5 },
  ]);
  // 已在列表 / 无目标：原引用（调用方按引用判等）
  assert.equal(withTargetProject(projects, "/repo"), projects);
  assert.equal(withTargetProject(projects, null), projects);
  // 空列表 + 目标：只剩临时项
  assert.deepEqual(withTargetProject([], "/x"), [{ cwd: "/x", count: 0, latest: 0 }]);
});
