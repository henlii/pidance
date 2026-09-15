# Pidance Desktop（Windows 桌面壳）

[文档导航](../docs/README.md) · [主应用开发](../docs/development.md) · [发布流程](../docs/release.md)

桌面包与主包独立版本化；当前 desktop 版本和内置主包均为 `0.2.26`，并不会随主仓 `0.2.28` 自动升级。精确值以本目录 `package.json` / lockfile 为准。

面向 Windows 用户的 Electron 壳：解压/安装后双击「Pidance Desktop」，自动拉起本机
pidance 服务（127.0.0.1:31415）并打开沙箱窗口。端口上已有 **Pidance** 服务则复用
（不重复 spawn，也不停它）；真正退出时只停本进程拉起的服务。启用最小化到托盘后，关窗只隐藏窗口。

## 产物形态

- **Windows zip（便携）**：`desktop/dist/*.zip`，解压即用（对应 #25 的 Windows zip 目标）。
- **NSIS 安装版**：`desktop/dist/Pidance Desktop Setup <ver>.exe`，可选安装目录、
  创建桌面/开始菜单快捷方式；用户级安装（不需要管理员）。
- 服务端来自 npm 包 `@henlii/pidance`（与 `desktop/package.json` 精确锁定，含 lockfile），
  打包进 `resources/app/node_modules/@henlii/pidance`（`asar:false`）。
- 服务进程用**包内 Electron 自带的 Node** 运行（`ELECTRON_RUN_AS_NODE=1`，Electron 37.10.3
  自带 Node 22.21.1，满足主包 `engines.node >=22.19.0`），不再单独捆绑 ~92MB 的 `node.exe`；
  原生模块（node-pty / sharp）都是 NAPI 构建，两种运行时通用。
  如需改回内置 Node：恢复 `build.extraResources` 的 `node/` 与 `prebuild:win:*` 钩子，
  并跑 `npm run fetch-node`（`resolveNodeBinary` 会优先使用它）。

桌面版窗口始终通过本机 `127.0.0.1:31415` 打开；本进程拉起的服务显式以
`--hostname 127.0.0.1` 启动（#25 范围：桌面壳只服务本机，不跟随
`pidance-server.json` 的远程访问开关）。需要远程访问请使用安装版服务。

## 启动与关闭语义

| 场景 | 行为 |
|---|---|
| 31415 上已有 Pidance（如正式版安装包） | 复用，不 spawn、不停它；关窗不影响它（身份用页面 `<title>Pidance</title>` 指纹确认，不是「端口有人应答」） |
| 31415 被其他程序占用 | 明确报错退出，绝不杀别人的进程 |
| 31415 无人监听 | 用内置 Node 拉起随包 pidance，就绪后开窗 |
| 关闭窗口（已启用最小化到托盘） | 隐藏窗口，服务继续运行 |
| 真正退出 / 未启用托盘最小化而关窗 | 只停本进程拉起的服务，win32 用 `taskkill /T` 收整棵进程树（PTY worker 一起收） |
| 启动失败（缺 Node 运行时 / 缺服务入口 / 未就绪） | 明确错误框后退出 |

复用判定不只看「端口开着」：会读回环根路径并校验响应体里的 Pidance 品牌标识
（`desktop/src/server-lifecycle.js`，纯逻辑，`npm test` 覆盖）。

## 构建（Windows 产物在 Windows 上打，或 CI windows runner）

```bat
cd desktop
npm ci --include=dev
npm test                      :: 生命周期纯逻辑测试
npm run build:win:zip         :: 便携 zip
npm run build:win:installer   :: NSIS 安装版
```

CI：`.github/workflows/desktop-win.yml` 在 windows-latest 上执行同一流程（安装 → 语法
检查 → 测试 → 瘦身 → 打包 → **产物冒烟**（解包 zip，用包内 Electron 的 Node 起服务并探活
`/api/home`）→ SHA256），产物挂在 workflow run 的 Artifacts 上，不自动发 Release。

瘦身步骤只删调试/非目标平台资产（`*.map`、`*.pdb`、非 win32-x64 的 SWC/esbuild/sharp/
node-pty prebuilds、next dev 产物），零运行引用。

## 安全边界

- `contextIsolation: true` + `sandbox: true` + `nodeIntegration: false`，页面不注入 Node 能力。
- 预加载脚本只暴露白名单 IPC（桌面设置读写、桌面通知），参数在主进程侧再做类型校验。
- 只绑定 `127.0.0.1`，不对外网暴露；窗口内不加载外部站点。

## 托盘与桌面设置

托盘菜单提供：显示窗口、开机启动、关闭窗口时最小化到托盘、桌面通知、退出。设置保存在
Electron `userData`（`desktop-settings.json`），不写入 Web/Pidance 配置文件。
Web 端目前没有消费这些 IPC 的设置页；壳自身的行为（托盘、开机启动、关窗最小化）不受影响。

## 开发模式

壳始终只操作 31415。调试时复用现有稳定服务，或把 `PIDANCE_SERVER_DIR` 指向**已安装稳定包目录**（含 `bin/pidance.js`），不要让壳在 31415 启动工作区源码。

```powershell
cd desktop
npm ci --include=dev
$env:PIDANCE_SERVER_DIR = '<已安装稳定 Pidance 包目录>'
npm run dev
```

当前未打包模式在没有覆盖变量时仍会回退仓库根；这是代码现状，不是推荐的维护方式。本轮仅修正文档，没有更改该默认值。应用源码测试继续走 [31416](../docs/development.md)。
