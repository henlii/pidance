import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const project = await createJiti(import.meta.url)('./project-context.ts');
const session = (id, modified, extra = {}) => ({ id, cwd: `/repo/${id}`, path: id, created: modified, modified, messageCount: 0, firstMessage: '', ...extra });

test('项目排序、去重与路径显示', () => {
  assert.deepEqual(project.getRecentProjects([session('a', '2024-01-01', { projectRoot: '/r' }), session('b', '2024-02-01', { projectRoot: '/r2' }), session('c', '2024-03-01', { projectRoot: '/r' })]), ['/r', '/r2']);
  assert.equal(project.displayCwd('/home/user', '/home/user'), '~');
  assert.equal(project.displayCwd('/home/user/x', '/home/user'), '~/x');
  assert.equal(project.displayCwd('/home/user2/x', '/home/user'), '/home/user2/x');
  assert.equal(project.displayCwd('C:\\Users\\me\\x', 'C:\\Users\\me'), '~/x');
});

test('会话树解析缺失祖先、循环并按层排序', () => {
  const tree = project.buildSessionTree([
    session('root', '2024-01-01'), session('child', '2024-03-01', { parentSessionId: 'missing' }),
    session('grandchild', '2024-02-01', { parentSessionId: 'root' }), session('cycle-a', '2024-04-01', { parentSessionId: 'cycle-b' }), session('cycle-b', '2024-05-01', { parentSessionId: 'cycle-a' }),
  ]);
  assert.equal(tree[0].session.id, 'cycle-b');
  assert.deepEqual(tree.find(n => n.session.id === 'root').children.map(n => n.session.id), ['grandchild']);
  assert.ok(tree.some(n => n.session.id === 'child'));
  assert.ok(tree.some(n => n.session.id === 'cycle-a'));
});

test('store 保持身份切换、归一化、重置与引用稳定性', () => {
  const store = project.createProjectStore({ identity: { cwd: '/x', projectRoot: '/x', status: 'ready', branch: 'stale', isGit: true } });
  const initial = store.getIdentitySnapshot();
  assert.deepEqual(initial, { status: 'ready', error: null, cwd: '/x', projectRoot: '/x', branch: 'stale', isGit: true, isTopLevel: false });
  let notifications = 0;
  store.subscribeIdentity(() => notifications++);
  store.setIdentity({ branch: 'main' });
  assert.equal(notifications, 1);
  assert.equal(store.getIdentitySnapshot().cwd, '/x');
  assert.equal(store.getIdentitySnapshot().projectRoot, '/x');
  store.setIdentity({ cwd: '/y', projectRoot: '/root', isGit: true, isTopLevel: true });
  assert.equal(notifications, 2);
  assert.equal(store.getIdentitySnapshot().projectRoot, '/root');
  store.setIdentity({ cwd: null });
  assert.deepEqual(store.getIdentitySnapshot(), { status: 'ready', error: null, cwd: null, projectRoot: null, branch: null, isGit: false, isTopLevel: false });
  assert.equal(notifications, 3);
  store.reset();
  assert.deepEqual(store.getIdentitySnapshot(), { status: 'idle', error: null, cwd: null, projectRoot: null, branch: null, isGit: false, isTopLevel: false });
  assert.equal(notifications, 4);
  const resetSnapshot = store.getIdentitySnapshot();
  store.reset();
  assert.equal(store.getIdentitySnapshot(), resetSnapshot);
  assert.equal(notifications, 4);
});

test("projectDisplayName 取最后一段文件夹名", () => {
  assert.equal(project.projectDisplayName("/home/user/repo"), "repo");
  assert.equal(project.projectDisplayName("/home/user/repo/"), "repo");
  assert.equal(project.projectDisplayName("C:\\Users\\me\\proj"), "proj");
  assert.equal(project.projectDisplayName("/"), "/");
  assert.equal(project.projectDisplayName("repo"), "repo");
});
