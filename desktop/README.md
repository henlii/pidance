# Pidance Desktop（Windows 桌面壳）

面向 Windows 用户的 Electron 壳：进程内拉起 pidance 服务（端口 31415），
等就绪后用自带窗口显示。关闭窗口即停服务。

## 产物形态

- **zip**（`desktop/dist/*.zip`）：解压后双击 `Pidance Desktop.exe`。
- 服务端进程使用 `desktop/node/node.exe`（Node >= 22.19，与
  `package.json engines` 一致），不依赖用户安装 Node。

## 构建（Windows 产物在 Windows 上打，或 CI 用 windows runner）

```bat
cd desktop
npm ci
node scripts\fetch-node-win.mjs        :: 下载并解压 Node win-x64 到 node\node.exe
npm run build:win:zip
```

`extraResources.node` 会把 `node.exe` 拷进 `resources/node/node.exe`；
`main.js` 在打包态找到它作为服务进程的 Node 解释器。

## 开发模式

```bash
cd desktop
npm run dev        # Electron 以仓库根为 server dir；端口 31415
```

未打包时 `resolveServerDir()` 为仓库根（`desktop/../`），服务入口
`bin/pidance.js` 直接复用工作区 `.next`（或环境变量 `PIDANCE_DIST_DIR`）。

## 端口冲突

启动时先探测 `127.0.0.1:31415/api/home`：已有服务（如 31415 正式版）则直接
打开窗口复用，不重复 spawn；仅在服务未监听时才拉起子进程。窗口关闭时只停自己
拉起的进程，不动外部实例。

## 安全边界

- `contextIsolation: true` + `sandbox: true` + `nodeIntegration: false`：
  页面仍是原 Web UI，OAuth/API 密钥交互不受壳影响。
- 服务默认绑定 `127.0.0.1`（密码门禁与正式版一致；远程访问仍需在设置中
  开启并配置密码）。

## 说明

- Electron 依赖只在 `desktop/` 内，不进主包 `@henlii/pidance`；npm 包仍只有
  `pidance` CLI（端口 31415）。
- 未打包构建产物（`node_modules` 由 electron-builder 排除 `@henlii` 之外依赖）
  仅保留 `node_modules/@henlii/**` 作为服务运行时，与 `src/main.js`。
