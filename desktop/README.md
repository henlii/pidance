# Pidance Desktop（Windows 安装版）

面向 Windows 用户的 Electron 壳：安装后双击「Pidance Desktop」，自动拉起本机
pidance 服务（127.0.0.1:31415）并打开沙箱窗口。本机已有服务则复用，不重复
spawn；关闭窗口即停本进程拉起的服务。

## 产物形态

- **NSIS 安装版**（`desktop/dist/Pidance Desktop Setup <ver>.exe`）：双击安装，
  可选安装目录，创建桌面/开始菜单快捷方式；用户级安装（不需要管理员）。
- 服务端来自 npm 包 `@henlii/pidance`（与 `desktop/package.json` 精确锁定），
  打包进 `resources/app/node_modules/@henlii/pidance`（`asar:false`）。
- 服务进程使用 `resources/node/node.exe`（Node v24.18.0 win-x64，满足主包
  `engines.node >=22.19.0`），不依赖用户安装 Node。

## 构建（Windows 产物在 Windows 上打，或 CI windows runner）

```bat
cd desktop
npm ci --include=dev
npm run fetch-node            :: 下载 Node win-x64 到 node\node.exe（build 也会自动执行）
npm run build:win:installer   :: NSIS 安装版
```

CI：`.github/workflows/desktop-win.yml` 在 windows-latest 上执行同一流程，
产物（Setup exe + SHA256）挂在 workflow run 的 Artifacts 上。

## 桌面版设置

Windows 桌面壳的托盘菜单提供「桌面版设置…」入口，会打开 Web 设置中的桌面版页面；该页面只在 Electron desktop bridge 环境显示，包含：

- 开机启动
- 关闭窗口时最小化到托盘
- 桌面通知（窗口不在前台时，本轮回复完成后提醒）

设置保存在 Electron `userData`，不会写入 Web/Pidance 配置文件。

## 安全边界

- `contextIsolation: true` + `sandbox: true`，页面不注入 Node 能力；配置页只通过白名单 IPC 修改桌面设置。
- 只绑定 `127.0.0.1`，不对外网暴露。

## 开发模式

```bash
cd desktop
npm run dev        # Electron 以仓库根为 server dir（PIDANCE_SERVER_DIR 可覆盖）；端口 31415
```

注意：开发模式复用仓库根的 `node_modules`（主仓依赖已装好）；不要在 desktop/
下手动 `npm install` 拉全量依赖——CI/打包使用 `npm ci --include=dev` 按 lockfile 精确安装。
