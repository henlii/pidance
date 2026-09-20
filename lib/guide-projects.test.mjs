import assert from "node:assert/strict";
import test from "node:test";

import { guideProjectOptions } from "./guide-projects.ts";

test("guideProjectOptions：候选就是侧栏项目列表本身", () => {
  const roots = ["/repo-a", "/repo-b"];
  assert.deepEqual(guideProjectOptions(roots, null), ["/repo-a", "/repo-b"]);
  // 未加入项目的目录不会凭空出现（旧实现按最近会话 cwd 聚合过）
  assert.equal(guideProjectOptions(roots, null).includes("/not-a-project"), false);
  // 空项目列表：下拉为空，不伪造条目
  assert.deepEqual(guideProjectOptions([], null), []);
});

test("guideProjectOptions：目标不在列表时置顶补临时项，已在列表则不重复", () => {
  const roots = ["/repo-a", "/repo-b"];
  assert.deepEqual(guideProjectOptions(roots, "/side-checkout"), ["/side-checkout", "/repo-a", "/repo-b"]);
  assert.deepEqual(guideProjectOptions(roots, "/repo-b"), ["/repo-a", "/repo-b"]);
  assert.deepEqual(guideProjectOptions([], "/only-target"), ["/only-target"]);
  // 不修改输入数组
  assert.equal(roots.length, 2);
});
