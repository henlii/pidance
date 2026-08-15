import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

test("偏好解析：standard/compact 原样保留，非法 displayMode 回退 standard", async () => {
  const { parseSidebarPreferences } = await jiti.import("./ui-preferences.ts");
  assert.equal(parseSidebarPreferences({ displayMode: "standard" }).displayMode, "standard");
  assert.equal(parseSidebarPreferences({ displayMode: "compact" }).displayMode, "compact");
  assert.equal(parseSidebarPreferences({ displayMode: "minimal" }).displayMode, "standard");
  assert.equal(parseSidebarPreferences({ displayMode: 42 }).displayMode, "standard");
  assert.equal(parseSidebarPreferences({}).displayMode, "standard");
});

test("偏好解析：非对象输入回退完整默认值", async () => {
  const { parseSidebarPreferences, DEFAULT_SIDEBAR_PREFERENCES } = await jiti.import("./ui-preferences.ts");
  for (const raw of [null, undefined, "compact", 7, true, []]) {
    assert.deepEqual(parseSidebarPreferences(raw), DEFAULT_SIDEBAR_PREFERENCES);
  }
});

test("偏好解析：折叠集合逐项过滤非 string 脏数据", async () => {
  const { parseSidebarPreferences, SIDEBAR_WIDTH_DEFAULT, RIGHT_PANEL_WIDTH_DEFAULT, CHANGES_PANEL_WIDTH_DEFAULT } = await jiti.import("./ui-preferences.ts");
  const prefs = parseSidebarPreferences({
    displayMode: "compact",
    collapsedProjectRoots: ["/repo", 1, null, "/other"],
    collapsedWorktreePaths: "not-an-array",
  });
  assert.deepEqual(prefs, {
    displayMode: "compact",
    collapsedProjectRoots: ["/repo", "/other"],
    collapsedWorktreePaths: [],
    projectAliases: {},
    closedProjectRoots: [],
    addedProjectRoots: [],
    sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
    rightPanelOpen: false,
    rightPanelWidth: RIGHT_PANEL_WIDTH_DEFAULT,
    changesPanelOpen: true,
    changesPanelWidth: CHANGES_PANEL_WIDTH_DEFAULT,
    showRecentSessions: true,
    fileExplorerState: {},
  });
});

test("偏好序列化往返：serialize → JSON.parse → parse 保持一致", async () => {
  const { parseSidebarPreferences, serializeSidebarPreferences, SIDEBAR_WIDTH_DEFAULT, RIGHT_PANEL_WIDTH_DEFAULT } = await jiti.import("./ui-preferences.ts");
  const prefs = {
    displayMode: "compact",
    collapsedProjectRoots: ["/a", "/b"],
    collapsedWorktreePaths: ["/a-wt/feat"],
    projectAliases: {},
    closedProjectRoots: [],
    addedProjectRoots: [],
    sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
    rightPanelOpen: false,
    rightPanelWidth: RIGHT_PANEL_WIDTH_DEFAULT,
    changesPanelOpen: true,
    changesPanelWidth: 360,
    showRecentSessions: true,
    fileExplorerState: {},
  };
  assert.deepEqual(parseSidebarPreferences(JSON.parse(serializeSidebarPreferences(prefs))), prefs);
});

test("项目 alias 解析：过滤空 key、空 value 与非 string 项，key/value 均 trim", async () => {
  const { parseProjectAliases } = await jiti.import("./ui-preferences.ts");
  assert.deepEqual(parseProjectAliases({
    "/repo": "  主仓库  ",
    "  / spaced  ": "keep-key-trim",
    "/empty": "",
    "/blank": "   ",
    "/num": 42,
    "/null": null,
    "/obj": {},
    "": "orphan",
    "   ": "orphan-blank",
  }), {
    "/repo": "主仓库",
    "/ spaced": "keep-key-trim",
  });
  // 非对象输入一律回退空表。
  for (const raw of [null, undefined, "x", 7, true, ["/repo", "alias"]]) {
    assert.deepEqual(parseProjectAliases(raw), {});
  }
});

test("偏好解析：alias 与 closedProjectRoots 脏数据回退/过滤", async () => {
  const { parseSidebarPreferences } = await jiti.import("./ui-preferences.ts");
  const prefs = parseSidebarPreferences({
    displayMode: "compact",
    projectAliases: { "/repo": "别名", "/bad": 1 },
    closedProjectRoots: ["/closed", 2, null],
  });
  assert.deepEqual(prefs.projectAliases, { "/repo": "别名" });
  assert.deepEqual(prefs.closedProjectRoots, ["/closed"]);
});

test("偏好解析：旧版本数据（无 alias/closed/sidebarWidth 字段）回退为空/默认宽", async () => {
  const { parseSidebarPreferences, SIDEBAR_WIDTH_DEFAULT } = await jiti.import("./ui-preferences.ts");
  const prefs = parseSidebarPreferences({
    displayMode: "standard",
    collapsedProjectRoots: ["/repo"],
  });
  assert.deepEqual(prefs.projectAliases, {});
  assert.deepEqual(prefs.closedProjectRoots, []);
  assert.deepEqual(prefs.collapsedProjectRoots, ["/repo"]);
  assert.equal(prefs.sidebarWidth, SIDEBAR_WIDTH_DEFAULT);
});

test("偏好解析：右栏键——旧数据缺字段默认关闭+默认宽；脏数据安全回退", async () => {
  const {
    parseSidebarPreferences,
    RIGHT_PANEL_WIDTH_DEFAULT,
    RIGHT_PANEL_WIDTH_MIN,
    RIGHT_PANEL_WIDTH_MAX,
  } = await jiti.import("./ui-preferences.ts");
  // 旧数据无 rightPanelOpen/rightPanelWidth 字段
  const legacy = parseSidebarPreferences({ displayMode: "standard" });
  assert.equal(legacy.rightPanelOpen, false);
  assert.equal(legacy.rightPanelWidth, RIGHT_PANEL_WIDTH_DEFAULT);
  // 仅显式 true 视为打开；truthy 脏数据（1/"true"）不算
  assert.equal(parseSidebarPreferences({ rightPanelOpen: true }).rightPanelOpen, true);
  assert.equal(parseSidebarPreferences({ rightPanelOpen: 1 }).rightPanelOpen, false);
  assert.equal(parseSidebarPreferences({ rightPanelOpen: "true" }).rightPanelOpen, false);
  // 宽度越界/损坏 clamp
  assert.equal(parseSidebarPreferences({ rightPanelWidth: 100 }).rightPanelWidth, RIGHT_PANEL_WIDTH_MIN);
  assert.equal(parseSidebarPreferences({ rightPanelWidth: 9999 }).rightPanelWidth, RIGHT_PANEL_WIDTH_MAX);
  assert.equal(parseSidebarPreferences({ rightPanelWidth: "x" }).rightPanelWidth, RIGHT_PANEL_WIDTH_DEFAULT);
  assert.equal(parseSidebarPreferences({ rightPanelWidth: 460 }).rightPanelWidth, 460);
});

test("偏好解析：修改面板旧数据默认打开且宽度安全钳制", async () => {
  const {
    parseSidebarPreferences,
    clampChangesPanelWidth,
    CHANGES_PANEL_WIDTH_DEFAULT,
    CHANGES_PANEL_WIDTH_MIN,
    CHANGES_PANEL_WIDTH_MAX,
  } = await jiti.import("./ui-preferences.ts");
  const legacy = parseSidebarPreferences({ displayMode: "standard" });
  assert.equal(legacy.changesPanelOpen, true);
  assert.equal(legacy.changesPanelWidth, CHANGES_PANEL_WIDTH_DEFAULT);
  assert.equal(parseSidebarPreferences({ changesPanelOpen: false }).changesPanelOpen, false);
  assert.equal(parseSidebarPreferences({ changesPanelOpen: 0 }).changesPanelOpen, true);
  assert.equal(clampChangesPanelWidth(100), CHANGES_PANEL_WIDTH_MIN);
  assert.equal(clampChangesPanelWidth(9999), CHANGES_PANEL_WIDTH_MAX);
  assert.equal(clampChangesPanelWidth("x"), CHANGES_PANEL_WIDTH_DEFAULT);
  assert.equal(clampChangesPanelWidth(401.6), 402);
});

test("偏好解析：sidebarWidth 越界/损坏 clamp；合法值保留", async () => {
  const {
    parseSidebarPreferences,
    clampSidebarWidth,
    SIDEBAR_WIDTH_MIN,
    SIDEBAR_WIDTH_MAX,
    SIDEBAR_WIDTH_DEFAULT,
  } = await jiti.import("./ui-preferences.ts");
  assert.equal(clampSidebarWidth(100), SIDEBAR_WIDTH_MIN);
  assert.equal(clampSidebarWidth(9999), SIDEBAR_WIDTH_MAX);
  assert.equal(clampSidebarWidth("x"), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(clampSidebarWidth(NaN), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(clampSidebarWidth(320.6), 321);
  assert.equal(parseSidebarPreferences({ sidebarWidth: 100 }).sidebarWidth, SIDEBAR_WIDTH_MIN);
  assert.equal(parseSidebarPreferences({ sidebarWidth: 999 }).sidebarWidth, SIDEBAR_WIDTH_MAX);
  assert.equal(parseSidebarPreferences({ sidebarWidth: 360 }).sidebarWidth, 360);
  assert.equal(parseSidebarPreferences({ sidebarWidth: null }).sidebarWidth, SIDEBAR_WIDTH_DEFAULT);
});

test("偏好序列化往返：alias 与 closed roots 与 sidebarWidth 一并保持", async () => {
  const { parseSidebarPreferences, serializeSidebarPreferences } = await jiti.import("./ui-preferences.ts");
  const prefs = {
    displayMode: "standard",
    collapsedProjectRoots: [],
    collapsedWorktreePaths: [],
    projectAliases: { "/repo": "主仓库", "/other": "实验" },
    closedProjectRoots: ["/archived"],
    addedProjectRoots: [],
    sidebarWidth: 360,
    rightPanelOpen: true,
    rightPanelWidth: 460,
    changesPanelOpen: true,
    changesPanelWidth: 360,
    showRecentSessions: true,
    fileExplorerState: {},
  };
  assert.deepEqual(parseSidebarPreferences(JSON.parse(serializeSidebarPreferences(prefs))), prefs);
});

test("无 window 环境：load 返回默认值、save 静默不抛", async () => {
  const { loadSidebarPreferences, saveSidebarPreferences, DEFAULT_SIDEBAR_PREFERENCES } = await jiti.import("./ui-preferences.ts");
  assert.equal(typeof window, "undefined");
  assert.deepEqual(loadSidebarPreferences(), DEFAULT_SIDEBAR_PREFERENCES);
  assert.doesNotThrow(() => saveSidebarPreferences({
    displayMode: "compact",
    collapsedProjectRoots: ["/a"],
    collapsedWorktreePaths: [],
    projectAliases: {},
    closedProjectRoots: [],
    addedProjectRoots: [],
    sidebarWidth: DEFAULT_SIDEBAR_PREFERENCES.sidebarWidth,
    rightPanelOpen: DEFAULT_SIDEBAR_PREFERENCES.rightPanelOpen,
    rightPanelWidth: DEFAULT_SIDEBAR_PREFERENCES.rightPanelWidth,
    changesPanelOpen: DEFAULT_SIDEBAR_PREFERENCES.changesPanelOpen,
    changesPanelWidth: DEFAULT_SIDEBAR_PREFERENCES.changesPanelWidth,
    showRecentSessions: DEFAULT_SIDEBAR_PREFERENCES.showRecentSessions,
    fileExplorerState: DEFAULT_SIDEBAR_PREFERENCES.fileExplorerState,
  }));
});

function makeMemoryStorage(initial = {}) {
  /** @type {Map<string, string>} */
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}




test("侧栏宽度写入：只更新 sidebarWidth，其余存储字段原样保留", async () => {
  const {
    loadSidebarPreferencesFromStorage,
    saveSidebarWidthToStorage,
    STORAGE_KEY,
    serializeSidebarPreferences,
  } = await jiti.import("./ui-preferences.ts");
  const existing = {
    displayMode: "compact",
    collapsedProjectRoots: ["/repo"],
    collapsedWorktreePaths: ["/repo-wt/feat"],
    projectAliases: { "/repo": "主仓" },
    closedProjectRoots: ["/closed"],
    addedProjectRoots: [],
    sidebarWidth: 300,
    rightPanelOpen: true,
    rightPanelWidth: 480,
    changesPanelOpen: true,
    changesPanelWidth: 360,
    showRecentSessions: true,
    fileExplorerState: {},
  };
  const storage = makeMemoryStorage({
    [STORAGE_KEY]: serializeSidebarPreferences(existing),
  });
  saveSidebarWidthToStorage(storage, 420);
  assert.deepEqual(loadSidebarPreferencesFromStorage(storage), { ...existing, sidebarWidth: 420 });
});

test("侧栏宽度写入：越界/非法值钳入 [240, 520]，空存储从默认偏好起步", async () => {
  const {
    loadSidebarPreferencesFromStorage,
    saveSidebarWidthToStorage,
    DEFAULT_SIDEBAR_PREFERENCES,
    SIDEBAR_WIDTH_MIN,
    SIDEBAR_WIDTH_MAX,
  } = await jiti.import("./ui-preferences.ts");
  const storage = makeMemoryStorage();
  saveSidebarWidthToStorage(storage, 40);
  assert.equal(loadSidebarPreferencesFromStorage(storage).sidebarWidth, SIDEBAR_WIDTH_MIN);
  saveSidebarWidthToStorage(storage, 9999);
  assert.equal(loadSidebarPreferencesFromStorage(storage).sidebarWidth, SIDEBAR_WIDTH_MAX);
  saveSidebarWidthToStorage(storage, Number.NaN);
  assert.equal(loadSidebarPreferencesFromStorage(storage).sidebarWidth, DEFAULT_SIDEBAR_PREFERENCES.sidebarWidth);
  // 除宽度外其余字段保持默认（不因宽度写入产生脏数据）
  const prefs = loadSidebarPreferencesFromStorage(storage);
  assert.deepEqual(prefs, { ...DEFAULT_SIDEBAR_PREFERENCES, projectAliases: {} });
});

test("侧栏宽度写入：存储抛错时静默忽略", async () => {
  const { saveSidebarWidthToStorage } = await jiti.import("./ui-preferences.ts");
  const storage = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
    removeItem() {},
  };
  assert.doesNotThrow(() => saveSidebarWidthToStorage(storage, 360));
});

test("侧栏偏好：读取规范键与缺失回退默认", async () => {
  const {
    loadSidebarPreferencesFromStorage,
    STORAGE_KEY,
    serializeSidebarPreferences,
    SIDEBAR_WIDTH_DEFAULT,
    DEFAULT_SIDEBAR_PREFERENCES,
    RIGHT_PANEL_WIDTH_DEFAULT,
  } = await jiti.import("./ui-preferences.ts");
  const prefs = {
    displayMode: "compact",
    collapsedProjectRoots: ["/a"],
    collapsedWorktreePaths: [],
    projectAliases: {},
    closedProjectRoots: [],
    addedProjectRoots: [],
    sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
    rightPanelOpen: false,
    rightPanelWidth: RIGHT_PANEL_WIDTH_DEFAULT,
    changesPanelOpen: true,
    changesPanelWidth: 360,
    showRecentSessions: true,
    fileExplorerState: {},
  };
  const storage = makeMemoryStorage({ [STORAGE_KEY]: serializeSidebarPreferences(prefs) });
  assert.deepEqual(loadSidebarPreferencesFromStorage(storage), prefs);
  const empty = loadSidebarPreferencesFromStorage(makeMemoryStorage());
  assert.equal(empty.displayMode, DEFAULT_SIDEBAR_PREFERENCES.displayMode);
  assert.equal(empty.sidebarWidth, SIDEBAR_WIDTH_DEFAULT);
  assert.equal(empty.rightPanelOpen, false);
  assert.equal(empty.rightPanelWidth, RIGHT_PANEL_WIDTH_DEFAULT);
});

test("右栏偏好写入：只更新 open/width，其余存储字段原样保留", async () => {
  const {
    loadSidebarPreferencesFromStorage,
    saveRightPanelPreferencesToStorage,
    STORAGE_KEY,
    serializeSidebarPreferences,
  } = await jiti.import("./ui-preferences.ts");
  const existing = {
    displayMode: "compact",
    collapsedProjectRoots: ["/repo"],
    collapsedWorktreePaths: [],
    projectAliases: { "/repo": "主仓" },
    closedProjectRoots: [],
    addedProjectRoots: [],
    sidebarWidth: 300,
    rightPanelOpen: false,
    rightPanelWidth: 400,
    changesPanelOpen: true,
    changesPanelWidth: 360,
    showRecentSessions: true,
    fileExplorerState: {},
  };
  const storage = makeMemoryStorage({
    [STORAGE_KEY]: serializeSidebarPreferences(existing),
  });
  // 只写 open：width 与其余字段保留
  saveRightPanelPreferencesToStorage(storage, { open: true });
  assert.deepEqual(loadSidebarPreferencesFromStorage(storage), { ...existing, rightPanelOpen: true });
  // 只写 width：open 保留；越界 clamp
  saveRightPanelPreferencesToStorage(storage, { width: 9999 });
  const after = loadSidebarPreferencesFromStorage(storage);
  assert.equal(after.rightPanelOpen, true);
  assert.equal(after.rightPanelWidth, 720);
  assert.equal(after.sidebarWidth, 300);
});

test("右栏偏好写入：空存储从默认偏好起步；存储抛错静默忽略", async () => {
  const {
    loadSidebarPreferencesFromStorage,
    saveRightPanelPreferencesToStorage,
    DEFAULT_SIDEBAR_PREFERENCES,
  } = await jiti.import("./ui-preferences.ts");
  const storage = makeMemoryStorage();
  saveRightPanelPreferencesToStorage(storage, { open: true, width: 520 });
  const prefs = loadSidebarPreferencesFromStorage(storage);
  assert.equal(prefs.rightPanelOpen, true);
  assert.equal(prefs.rightPanelWidth, 520);
  assert.equal(prefs.displayMode, DEFAULT_SIDEBAR_PREFERENCES.displayMode);
  const denied = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
    removeItem() {},
  };
  assert.doesNotThrow(() => saveRightPanelPreferencesToStorage(denied, { open: true }));
});

test("修改面板偏好写入：只更新 open/width 并钳制宽度", async () => {
  const {
    loadSidebarPreferencesFromStorage,
    saveChangesPanelPreferencesToStorage,
    DEFAULT_SIDEBAR_PREFERENCES,
    CHANGES_PANEL_WIDTH_MAX,
  } = await jiti.import("./ui-preferences.ts");
  const storage = makeMemoryStorage();
  saveChangesPanelPreferencesToStorage(storage, { open: false, width: 9999 });
  assert.deepEqual(loadSidebarPreferencesFromStorage(storage), {
    ...DEFAULT_SIDEBAR_PREFERENCES,
    changesPanelOpen: false,
    changesPanelWidth: CHANGES_PANEL_WIDTH_MAX,
  });
});

test("偏好解析：最近会话区默认开启，仅显式 false 关闭，序列化往返保持", async () => {
  const {
    parseSidebarPreferences,
    serializeSidebarPreferences,
    DEFAULT_SIDEBAR_PREFERENCES,
  } = await jiti.import("./ui-preferences.ts");
  // 默认开启；旧数据缺字段也视为开启
  assert.equal(DEFAULT_SIDEBAR_PREFERENCES.showRecentSessions, true);
  assert.equal(parseSidebarPreferences({}).showRecentSessions, true);
  assert.equal(parseSidebarPreferences({ displayMode: "standard" }).showRecentSessions, true);
  // 仅显式 false 关闭；脏数据（0/"false"/null）回退默认开启
  assert.equal(parseSidebarPreferences({ showRecentSessions: false }).showRecentSessions, false);
  assert.equal(parseSidebarPreferences({ showRecentSessions: 0 }).showRecentSessions, true);
  assert.equal(parseSidebarPreferences({ showRecentSessions: "false" }).showRecentSessions, true);
  assert.equal(parseSidebarPreferences({ showRecentSessions: null }).showRecentSessions, true);
  // 序列化往返：显式关闭可持久化
  const closed = {
    displayMode: "standard",
    collapsedProjectRoots: [],
    collapsedWorktreePaths: [],
    projectAliases: {},
    closedProjectRoots: [],
    addedProjectRoots: [],
    sidebarWidth: DEFAULT_SIDEBAR_PREFERENCES.sidebarWidth,
    rightPanelOpen: false,
    rightPanelWidth: DEFAULT_SIDEBAR_PREFERENCES.rightPanelWidth,
    changesPanelOpen: true,
    changesPanelWidth: 360,
    showRecentSessions: false,
    fileExplorerState: {},
  };
  assert.deepEqual(
    parseSidebarPreferences(JSON.parse(serializeSidebarPreferences(closed))),
    closed,
  );
});

test("文件树状态解析：合法结构保留，脏数据逐项过滤，非对象回退空表", async () => {
  const { parseFileExplorerState } = await jiti.import("./ui-preferences.ts");
  assert.deepEqual(parseFileExplorerState({
    "/repo/a": { expanded: ["/repo/a/src", "/repo/a/src/lib"], scrollTop: 320 },
    "/repo/b": { expanded: "not-array", scrollTop: -5 },
    "/repo/c": "string",
    "/repo/d": { expanded: ["/repo/d", 7, null], scrollTop: 9999.6 },
    "": { expanded: [], scrollTop: 1 },
    "/repo/e": { expanded: [], scrollTop: "x" },
  }), {
    "/repo/a": { expanded: ["/repo/a/src", "/repo/a/src/lib"], scrollTop: 320 },
    "/repo/b": { expanded: [], scrollTop: 0 },
    "/repo/d": { expanded: ["/repo/d"], scrollTop: 10000 },
    "/repo/e": { expanded: [], scrollTop: 0 },
  });
  for (const raw of [null, undefined, "x", 7, true, []]) {
    assert.deepEqual(parseFileExplorerState(raw), {});
  }
});

test("文件树状态解析：parseSidebarPreferences 集成 + 序列化往返", async () => {
  const { parseSidebarPreferences, serializeSidebarPreferences, DEFAULT_SIDEBAR_PREFERENCES } = await jiti.import("./ui-preferences.ts");
  // 旧数据缺字段：默认空表
  assert.deepEqual(parseSidebarPreferences({ displayMode: "standard" }).fileExplorerState, {});
  assert.deepEqual(DEFAULT_SIDEBAR_PREFERENCES.fileExplorerState, {});
  const prefs = {
    displayMode: "standard",
    collapsedProjectRoots: [],
    collapsedWorktreePaths: [],
    projectAliases: {},
    closedProjectRoots: [],
    addedProjectRoots: [],
    sidebarWidth: 300,
    rightPanelOpen: false,
    rightPanelWidth: 400,
    changesPanelOpen: true,
    changesPanelWidth: 360,
    showRecentSessions: true,
    fileExplorerState: { "/repo/a": { expanded: ["/repo/a/src"], scrollTop: 120 } },
  };
  assert.deepEqual(
    parseSidebarPreferences(JSON.parse(serializeSidebarPreferences(prefs))),
    prefs,
  );
});

test("文件树状态写入：只更新指定 cwd，其余存储字段原样保留", async () => {
  const {
    loadSidebarPreferencesFromStorage,
    saveFileExplorerStateToStorage,
    STORAGE_KEY,
    serializeSidebarPreferences,
  } = await jiti.import("./ui-preferences.ts");
  const existing = {
    displayMode: "compact",
    collapsedProjectRoots: [],
    collapsedWorktreePaths: [],
    projectAliases: {},
    closedProjectRoots: [],
    addedProjectRoots: [],
    sidebarWidth: 300,
    rightPanelOpen: true,
    rightPanelWidth: 480,
    changesPanelOpen: true,
    changesPanelWidth: 360,
    showRecentSessions: true,
    fileExplorerState: { "/repo/a": { expanded: ["/repo/a/src"], scrollTop: 88 } },
  };
  const storage = makeMemoryStorage({
    [STORAGE_KEY]: serializeSidebarPreferences(existing),
  });
  saveFileExplorerStateToStorage(storage, "/repo/b", { expanded: ["/repo/b/x"], scrollTop: 240.6 });
  const after = loadSidebarPreferencesFromStorage(storage);
  // 新 cwd 写入，旧 cwd 保留，其余偏好字段不动
  assert.deepEqual(after.fileExplorerState, {
    "/repo/a": { expanded: ["/repo/a/src"], scrollTop: 88 },
    "/repo/b": { expanded: ["/repo/b/x"], scrollTop: 241 },
  });
  assert.equal(after.sidebarWidth, 300);
  assert.equal(after.rightPanelOpen, true);
  // 覆盖写：同 cwd 更新展开/滚动
  saveFileExplorerStateToStorage(storage, "/repo/a", { expanded: [], scrollTop: 0 });
  assert.deepEqual(loadSidebarPreferencesFromStorage(storage).fileExplorerState["/repo/a"], { expanded: [], scrollTop: 0 });
  // 空 cwd 不写入
  saveFileExplorerStateToStorage(storage, "  ", { expanded: ["/x"], scrollTop: 1 });
  assert.deepEqual(loadSidebarPreferencesFromStorage(storage).fileExplorerState["  "], undefined);
});

test("文件树状态写入：空存储从默认偏好起步；存储抛错静默忽略", async () => {
  const {
    loadSidebarPreferencesFromStorage,
    saveFileExplorerStateToStorage,
    DEFAULT_SIDEBAR_PREFERENCES,
  } = await jiti.import("./ui-preferences.ts");
  const storage = makeMemoryStorage();
  saveFileExplorerStateToStorage(storage, "/repo", { expanded: ["/repo/src"], scrollTop: 55 });
  const prefs = loadSidebarPreferencesFromStorage(storage);
  assert.deepEqual(prefs.fileExplorerState, { "/repo": { expanded: ["/repo/src"], scrollTop: 55 } });
  assert.equal(prefs.displayMode, DEFAULT_SIDEBAR_PREFERENCES.displayMode);
  const denied = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
    removeItem() {},
  };
  assert.doesNotThrow(() => saveFileExplorerStateToStorage(denied, "/repo", { expanded: [], scrollTop: 1 }));
});

test("自动检测更新偏好：默认 true；仅显式 false 关闭", async () => {
  const {
    parseAutoUpdateCheck,
    loadAutoUpdateCheckFromStorage,
    saveAutoUpdateCheckToStorage,
    DEFAULT_AUTO_UPDATE_CHECK,
  } = await jiti.import("./ui-preferences.ts");
  assert.equal(DEFAULT_AUTO_UPDATE_CHECK, true);
  assert.equal(parseAutoUpdateCheck(undefined), true);
  assert.equal(parseAutoUpdateCheck(true), true);
  assert.equal(parseAutoUpdateCheck(false), false);
  assert.equal(parseAutoUpdateCheck("false"), false);
  assert.equal(parseAutoUpdateCheck("0"), false);
  const storage = makeMemoryStorage();
  assert.equal(loadAutoUpdateCheckFromStorage(storage), true);
  saveAutoUpdateCheckToStorage(storage, false);
  assert.equal(loadAutoUpdateCheckFromStorage(storage), false);
  saveAutoUpdateCheckToStorage(storage, true);
  assert.equal(loadAutoUpdateCheckFromStorage(storage), true);
});

test("applySyncedSidebarUi：只覆盖跨端字段，保留宽度", async () => {
  const { applySyncedSidebarUi, DEFAULT_SIDEBAR_PREFERENCES } = await jiti.import("./ui-preferences.ts");
  const next = applySyncedSidebarUi(
    { ...DEFAULT_SIDEBAR_PREFERENCES, sidebarWidth: 400 },
    { displayMode: "compact", showRecentSessions: false, collapsedProjectRoots: ["/a"] },
  );
  assert.equal(next.displayMode, "compact");
  assert.equal(next.showRecentSessions, false);
  assert.deepEqual(next.collapsedProjectRoots, ["/a"]);
  assert.equal(next.sidebarWidth, 400);
});
