/**
 * 桌面壳生命周期纯逻辑测试（不需要 Electron / Windows）：
 * 首次启动、复用已有服务、端口被非 Pidance 占用、关闭只停自己拉起的服务。
 */
import assert from "node:assert/strict";
import test from "node:test";
import lifecycle from "../src/server-lifecycle.js";

const {
  buildReadyUrl,
  isTrustedOrigin,
  isTrustedIpcSender,
  externalUrlFor,
  coordinateStartup,
  looksLikePidance,
  probeService,
  resolveServerDir,
  resolveNodeBinary,
  meetsNodeEngine,
  buildServerArgs,
  stopServerProcess,
  checkServerInputs,
  isPortOpen,
} = lifecycle;

test("复用判定：结构化指纹（<title>Pidance</title>），不是「包含 Pidance 字样」", () => {
  assert.equal(looksLikePidance("<!DOCTYPE html><head><title>Pidance</title></head>"), true);
  assert.equal(looksLikePidance("<title>  Pidance </title>"), true);
  assert.equal(looksLikePidance("<title>PIDANCE</title>"), true);
  assert.equal(looksLikePidance("<title>Not Pidance</title>"), false, "『Not Pidance』不得被当作 Pidance");
  assert.equal(looksLikePidance("<p>欢迎使用 Pidance</p>"), false, "正文出现品牌不算身份");
  assert.equal(looksLikePidance("<title>Some other app</title>"), false);
  assert.equal(looksLikePidance(""), false);
  assert.equal(looksLikePidance(undefined), false);
});

test("导航边界：origin 严格比对，协议白名单", () => {
  const trusted = "http://127.0.0.1:31415";
  assert.equal(isTrustedOrigin("http://127.0.0.1:31415/", trusted), true);
  assert.equal(isTrustedOrigin("http://127.0.0.1:31415/?session=x", trusted), true);
  assert.equal(isTrustedOrigin("http://127.0.0.1:31415@evil.example/", trusted), false, "userinfo 绕过");
  assert.equal(isTrustedOrigin("http://127.0.0.1:31415.evil.example/", trusted), false);
  assert.equal(isTrustedOrigin("http://evil.example/127.0.0.1:31415", trusted), false);
  assert.equal(isTrustedOrigin("https://127.0.0.1:31415/", trusted), false, "协议不同即不同 origin");
  assert.equal(isTrustedOrigin("javascript:alert(1)", trusted), false);
  assert.equal(isTrustedOrigin("not a url", trusted), false);

  assert.equal(externalUrlFor("https://github.com/henlii/pidance"), "https://github.com/henlii/pidance");
  assert.equal(externalUrlFor("http://example.com/x"), "http://example.com/x");
  assert.equal(externalUrlFor("file:///etc/passwd"), null);
  assert.equal(externalUrlFor("javascript:alert(1)"), null);
  assert.equal(externalUrlFor("ms-settings:"), null);
  assert.equal(externalUrlFor(""), null);
});

test("探测：已有 Pidance → 复用；别的程序应答 → other；无人监听 → none", async () => {
  const pidance = await probeService({ url: "http://127.0.0.1:1/", timeoutMs: 200, request: async () => "pidance" });
  assert.equal(pidance, "pidance");

  const foreign = await probeService({ url: "http://127.0.0.1:1/", timeoutMs: 200, request: async () => "other" });
  assert.equal(foreign, "other");

  let calls = 0;
  const none = await probeService({
    url: "http://127.0.0.1:1/",
    timeoutMs: 300,
    request: async () => {
      calls += 1;
      return "none";
    },
  });
  assert.equal(none, "none");
  assert.ok(calls > 1, "未就绪时必须重试探测，而不是一次定论");
});

test("探测：先失败后成功（服务正在启动）会继续等到就绪", async () => {
  let attempt = 0;
  const verdict = await probeService({
    url: "http://127.0.0.1:1/",
    timeoutMs: 2_000,
    request: async () => (++attempt < 3 ? "none" : "pidance"),
  });
  assert.equal(verdict, "pidance");
  assert.equal(attempt, 3);
});

test("端口占用探测：连上为真、拒绝为假", async () => {
  const open = await isPortOpen({
    host: "127.0.0.1",
    port: 1,
    connect: () => ({ setTimeout() {}, once(event, handler) { if (event === "connect") handler(); }, removeAllListeners() {}, destroy() {} }),
  });
  assert.equal(open, true);

  const closed = await isPortOpen({
    host: "127.0.0.1",
    port: 1,
    connect: () => ({ setTimeout() {}, once(event, handler) { if (event === "error") handler(); }, removeAllListeners() {}, destroy() {} }),
  });
  assert.equal(closed, false);
});

test("服务目录解析：打包版固定用随包服务，开发版可用 PIDANCE_SERVER_DIR 覆盖", () => {
  assert.equal(
    resolveServerDir({ isPackaged: true, resourcesPath: "/res", serverDirEnv: "/tmp/ignored", srcDir: "/app/desktop/src" }),
    "/res/app/node_modules/@henlii/pidance",
  );
  assert.equal(
    resolveServerDir({ isPackaged: false, resourcesPath: "/res", serverDirEnv: "/repo", srcDir: "/repo/desktop/src" }),
    "/repo",
  );
  assert.equal(
    resolveServerDir({ isPackaged: false, resourcesPath: "/res", serverDirEnv: undefined, srcDir: "/repo/desktop/src" }),
    "/repo/desktop/src/../..",
  );
});

test("Node 运行时解析：优先内置 node.exe，没有则用 Electron 自带 Node（Node 模式）", () => {
  assert.deepEqual(
    resolveNodeBinary({ isPackaged: false, resourcesPath: "/res", execPath: "/usr/bin/electron", existsSync: () => false }),
    { bin: "/usr/bin/electron", env: { ELECTRON_RUN_AS_NODE: "1" } },
  );
  assert.deepEqual(
    resolveNodeBinary({ isPackaged: true, resourcesPath: "/res", execPath: "/usr/bin/electron", existsSync: () => true }),
    { bin: "/res/node/node.exe", env: {} },
  );
  assert.deepEqual(
    resolveNodeBinary({ isPackaged: true, resourcesPath: "/res", execPath: "/usr/bin/electron", existsSync: () => false }),
    { bin: "/usr/bin/electron", env: { ELECTRON_RUN_AS_NODE: "1" } },
    "没有内置 Node 时必须回退到 Electron 自带 Node，而不是启动失败",
  );
});

test("Node 版本门槛：Electron 自带 Node 必须满足主包 engines", () => {
  assert.equal(meetsNodeEngine("22.21.1", "22.19.0"), true);
  assert.equal(meetsNodeEngine("22.19.0", "22.19.0"), true);
  assert.equal(meetsNodeEngine("22.18.0", "22.19.0"), false);
  assert.equal(meetsNodeEngine("24.18.0", "22.19.0"), true);
  assert.equal(meetsNodeEngine(undefined, "22.19.0"), false);
});

test("IPC 调用方：只接受受信任主窗口的顶层 frame", () => {
  const trustedOrigin = "http://127.0.0.1:31415";
  const base = { frameParent: null, frameUrl: `${trustedOrigin}/`, senderIsMainWindow: true, trustedOrigin };
  assert.equal(isTrustedIpcSender(base), true);
  assert.equal(isTrustedIpcSender({ ...base, frameParent: {} }), false, "子 frame 不得调用 IPC");
  assert.equal(isTrustedIpcSender({ ...base, senderIsMainWindow: false }), false, "其他 webContents 不得调用 IPC");
  assert.equal(isTrustedIpcSender({ ...base, frameUrl: "http://evil.example/" }), false, "站外 origin 不得调用 IPC");
  assert.equal(isTrustedIpcSender({ ...base, frameUrl: "http://127.0.0.1:31415@evil.example/" }), false);
  assert.equal(isTrustedIpcSender({ ...base, frameParent: "missing", frameUrl: undefined }), false, "缺 frame 信息一律拒绝");
});

test("服务参数：显式端口 + 显式回环监听 + 不自动开浏览器", () => {
  assert.deepEqual(buildServerArgs("C:/app/bin/pidance.js", "31415", "127.0.0.1"), [
    "C:/app/bin/pidance.js",
    "--port",
    "31415",
    "--hostname",
    "127.0.0.1",
    "--no-open",
  ]);
});

test("启动协调：复用已有 Pidance 时不 spawn", async () => {
  const calls = [];
  const outcome = await coordinateStartup({
    probe: async () => "pidance",
    isPortBusy: async () => {
      calls.push("portCheck");
      return true;
    },
    startServer: async () => {
      calls.push("spawn");
      return true;
    },
    waitReady: async () => {
      calls.push("wait");
      return "pidance";
    },
  });
  assert.equal(outcome, "reused");
  assert.deepEqual(calls, [], "复用路径不得 spawn、也不应再探端口");
});

test("启动协调：端口被别的程序占用时报错且不 spawn", async () => {
  const calls = [];
  const foreign = await coordinateStartup({
    probe: async () => "other",
    isPortBusy: async () => true,
    startServer: async () => {
      calls.push("spawn");
      return true;
    },
    waitReady: async () => "pidance",
  });
  assert.equal(foreign, "foreign-port");
  assert.deepEqual(calls, []);

  const busy = await coordinateStartup({
    probe: async () => "none",
    isPortBusy: async () => true,
    startServer: async () => {
      calls.push("spawn");
      return true;
    },
    waitReady: async () => "pidance",
  });
  assert.equal(busy, "port-busy");
  assert.deepEqual(calls, [], "端口被占时不得尝试 spawn");
});

test("启动协调：首次启动 spawn 并等就绪；spawn 失败或未就绪各有明确结果", async () => {
  const calls = [];
  const started = await coordinateStartup({
    probe: async () => "none",
    isPortBusy: async () => false,
    startServer: async () => {
      calls.push("spawn");
      return true;
    },
    waitReady: async () => {
      calls.push("wait");
      return "pidance";
    },
  });
  assert.equal(started, "started");
  assert.deepEqual(calls, ["spawn", "wait"]);

  assert.equal(
    await coordinateStartup({
      probe: async () => "none",
      isPortBusy: async () => false,
      startServer: async () => false,
      waitReady: async () => "pidance",
    }),
    "start-failed",
  );

  assert.equal(
    await coordinateStartup({
      probe: async () => "none",
      isPortBusy: async () => false,
      startServer: async () => true,
      waitReady: async () => "none",
    }),
    "not-ready",
  );

  assert.equal(
    await coordinateStartup({
      probe: async () => "none",
      isPortBusy: async () => false,
      startServer: async () => true,
      waitReady: async () => "other",
    }),
    "foreign-port",
    "spawn 后发现端口上不是 Pidance 也要按占用处理",
  );
});

test("关闭清理：复用外部服务（child=null）绝不停任何进程", () => {
  const killed = [];
  const stopped = stopServerProcess({
    child: null,
    platform: "win32",
    spawnSync: (...args) => killed.push(args),
  });
  assert.equal(stopped, false);
  assert.deepEqual(killed, []);
});

test("关闭清理：win32 停整棵进程树（PTY worker 一起收）", () => {
  const calls = [];
  const stopped = stopServerProcess({
    child: { pid: 4321, killed: false },
    platform: "win32",
    spawnSync: (command, args, options) => calls.push({ command, args, options }),
  });
  assert.equal(stopped, true);
  assert.deepEqual(calls, [{ command: "taskkill", args: ["/pid", "4321", "/T", "/F"], options: { stdio: "ignore" } }]);
});

test("关闭清理：非 win32 用信号终止；已退出的 child 不重复处理", () => {
  const killed = [];
  const stopped = stopServerProcess({
    child: { pid: 99, killed: false, kill: () => killed.push("kill") },
    platform: "linux",
    spawnSync: () => assert.fail("非 win32 不应调用 taskkill"),
  });
  assert.equal(stopped, true);
  assert.deepEqual(killed, ["kill"]);

  assert.equal(
    stopServerProcess({ child: { pid: 99, killed: true }, platform: "win32", spawnSync: () => assert.fail("不应再杀") }),
    false,
  );
});

test("启动失败：缺运行时、Node 版本过低、缺服务入口都要给出明确原因", () => {
  assert.match(
    checkServerInputs({ serverBin: "/app/bin/pidance.js", nodeBin: null, existsSync: () => true }),
    /内置 Node/,
  );
  assert.match(
    checkServerInputs({
      serverBin: "/app/bin/pidance.js",
      nodeBin: "/usr/bin/electron",
      existsSync: () => true,
      nodeVersion: "22.18.0",
      requiredNodeVersion: "22.19.0",
    }),
    /低于主包要求/,
    "Electron 自带 Node 太旧必须明确报错，而不是启动后莫名失败",
  );
  assert.match(
    checkServerInputs({ serverBin: "/app/bin/pidance.js", nodeBin: "/res/node/node.exe", existsSync: () => false }),
    /未找到 pidance 服务入口/,
  );
  assert.equal(
    checkServerInputs({
      serverBin: "/app/bin/pidance.js",
      nodeBin: "/usr/bin/electron",
      existsSync: () => true,
      nodeVersion: "22.21.1",
      requiredNodeVersion: "22.19.0",
    }),
    null,
  );
});

test("就绪地址是回环根路径", () => {
  assert.equal(buildReadyUrl("127.0.0.1", "31415"), "http://127.0.0.1:31415/");
});
