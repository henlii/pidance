# Pidance Desktop（Windows 桌面壳）

面向 Windows 用户的 Electron 壳：解压/安装后双击「Pidance Desktop」，自动拉起本机
pidance 服务（127.0.0.1:31415）并打开沙箱窗口。端口上已有 **Pidance** 服务则复用
（不重复 spawn，也不停它）；关闭窗口只停本进程拉起的服务。

## 产物形态

- **Windows zip（便携）**：`desktop/dist/*.zip`，解压即用（对应 #25 的 Windows zip 目标）。
- **NSIS 安装版**：`desktop/dist/Pidance Desktop Setup <ver>.exe`，可选安装目录、
  创建桌面/开始菜单快捷方式；用户级安装（不需要管理员）。
- 服务端来自 npm 包 `@henlii/pidance`（与 `desktop/package.json` 精确锁定，含 lockfile），
  打包进 `resources/app/node_modules/@henlii/pidance`（`asar:false`）。
- 服务进程使用 `resources/node/node.exe`（`npm run fetch-node` 下载 Node win-x64，
  满足主包 `engines.node >=22.19.0`），不依赖用户安装 Node。

桌面版窗口始终通过本机 `127.0.0.1:31415` 打开；服务的监听地址由
`~/.pi/agent/pidance-server.json` 中的远程访问设置决定。开启远程访问前先设置服务密码，
保存后重启桌面版使监听地址生效。

## 启动与关闭语义

| 场景 | 行为 |
|---|---|
| 31415 上已有 Pidance（如正式版安装包） | 复用，不 spawn、不停它；关窗不影响它 |
| 31415 被其他程序占用 | 明确报错退出，绝不杀别人的进程 |
| 31415 无人监听 | 用内置 Node 拉起随包 pidance，就绪后开窗 |
| 关闭窗口 / 退出 | 只停本进程拉起的服务，win32 用 `taskkill /T` 收整棵进程树（PTY worker 一起收） |
| 启动失败（缺 Node 运行时 / 缺服务入口 / 未就绪） | 明确错误框后退出 |

复用判定不只看「端口开着」：会读回环根路径并校验响应体里的 Pidance 品牌标识
（`desktop/src/server-lifecycle.js`，纯逻辑，`npm test` 覆盖）。

## 构建（Windows 产物在 Windows 上打，或 CI windows runner）

```bat
cd desktop
npm ci --include=dev
npm test                      :: 生命周期纯逻辑测试
npm run fetch-node            :: 下载 Node win-x64 到 node\node.exe（build 也会自动执行）
npm run build:win:zip         :: 便携 zip
npm run build:win:installer   :: NSIS 安装版
```

CI：`.github/workflows/desktop-win.yml` 在 windows-latest 上执行同一流程（安装 → 语法
检查 → 测试 → 打包 → SHA256），产物挂在 workflow run 的 Artifacts 上，不自动发 Release。

## 安全边界

- `contextIsolation: true` + `sandbox: true` + `nodeIntegration: false`，页面不注入 Node 能力。
- 预加载脚本只暴露白名单 IPC（桌面设置读写、桌面通知），参数在主进程侧再做类型校验。
- 只绑定 `127.0.0.1`，不对外网暴露；窗口内不加载外部站点。

## 托盘与桌面设置

托盘菜单提供：显示窗口、开机启动、关闭窗口时最小化到托盘、桌面通知、退出。设置保存在
Electron `userData`（`desktop-settings.json`），不写入 Web/Pidance 配置文件。
Web 端目前没有消费这些 IPC 的设置页；壳自身的行为（托盘、开机启动、关窗最小化）不受影响。

## 开发模式

```bash
cd desktop
npm run dev        # Electron 以仓库根为 server dir（PIDANCE_SERVER_DIR 可覆盖）；端口 31415
```

注意：开发模式复用仓库根的 `node_modules`（主仓依赖已装好）；不要在 desktop/
下手动 `npm install` 拉全量依赖——CI/打包使用 `npm ci --include=dev` 按 lockfile 精确安装。
