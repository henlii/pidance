# Pidance Desktop（Windows 桌面壳）

[文档导航](../docs/README.md) · [主应用开发](../docs/development.md) · [发布流程](../docs/release.md) · [产物管理](../docs/artifacts.md)

面向 Windows 用户的 Electron 壳：安装后双击「Pidance Desktop」，自动拉起本机
pidance 服务（127.0.0.1:31415）并打开沙箱窗口。端口上已有 **Pidance** 服务则复用
（不重复 spawn，也不停它）；真正退出时只停本进程拉起的服务。启用最小化到托盘后，关窗只隐藏窗口。

桌面壳版本与主包**同版本**：`desktop/package.json` 的 `version` 与 `@henlii/pidance`
依赖都跟着主包走（精确版本 + lockfile）。发布主包时必须一起改，见
[发布准备第 5 步](../docs/release.md)。

## 产物形态

- **NSIS 安装版**：`desktop/dist/Pidance Desktop Setup <ver>.exe`，可选安装目录、
  创建桌面/开始菜单快捷方式；用户级安装（不需要管理员），自带卸载器。
- 只出安装版：解压形态（便携 zip）没有安装目录也没有卸载器，对用户和验证都是负担。
- electron-builder 打安装包前会先把应用目录留在 `desktop/dist/*-unpacked`，
  它和安装后落盘的文件树一致，CI 就在这个目录上验证与冒烟。
- 服务端来自 npm 包 `@henlii/pidance`（与 `desktop/package.json` 精确锁定，含 lockfile），
  打包进 `resources/app/node_modules/@henlii/pidance`（`asar:false`）。
- 服务进程用**包内 Electron 自带的 Node** 运行（`ELECTRON_RUN_AS_NODE=1`，Electron 37.10.3
  自带 Node 22.21.1，满足主包 `engines.node >=22.19.0`），不单独捆绑 `node.exe`；
  原生模块（node-pty / sharp）都是 NAPI 构建，两种运行时通用。CI 会在真实产物上量这个运行时版本，
  低于主包 engines 直接失败。
- 打包前先按**目标平台类别**瘦身（`npm run prune:win`）：删调试/非目标平台资产
  （`*.map`、`*.pdb`、非 win32-x64 的 SWC/esbuild/sharp/node-pty 预编译、只用于构建的
  `lucide-react`、docs/examples/tests）。瘦身脚本自带必需输入校验，删多了会直接失败。

桌面版窗口始终通过本机 `127.0.0.1:31415` 打开；本进程拉起的服务显式以
`--hostname 127.0.0.1` 启动（桌面壳只服务本机，不跟随 `pidance-server.json` 的远程访问开关）。
需要远程访问请使用安装版服务。

## 启动与关闭语义

| 场景 | 行为 |
|---|---|
| 31415 上已有 Pidance（如正式版安装包） | 复用，不 spawn、不停它；关窗不影响它（身份用页面 `<title>Pidance</title>` 指纹确认，不是「端口有人应答」） |
| 31415 被其他程序占用 | 明确报错退出，绝不杀别人的进程 |
| 31415 无人监听 | 用包内 Electron 的 Node 拉起随包 pidance，就绪后开窗 |
| 关闭窗口（已启用最小化到托盘） | 隐藏窗口，服务继续运行 |
| 真正退出 / 未启用托盘最小化而关窗 | 只停本进程拉起的服务，win32 用 `taskkill /T` 收整棵进程树（PTY worker 一起收） |
| 启动失败（Node 运行时过低 / 缺服务入口 / 未就绪） | 明确错误框后退出 |

复用判定不只看「端口开着」：会读回环根路径并校验响应体里的 Pidance 品牌标识
（`desktop/src/server-lifecycle.js`，纯逻辑，`npm test` 覆盖）。

## 版本与更新

壳会同时显示三个版本（关于框、托盘提示、控制台都打印）：

- **壳**：`desktop/package.json` 的版本（= 主包版本）；
- **内置服务**：包内 `@henlii/pidance` 的版本；
- **已连接服务**：实际在 31415 提供页面的服务，读 `/api/about`（外部服务设了密码时读不到，显示未知）。

复用外部服务且版本与内置不一致时，会提示「当前页面由外部服务提供」——升级或卸载桌面版都不会停掉那个服务。

更新是**手动触发**的（托盘「检查更新」），没有后台自动检查、也没有静默安装。只认同一个 Release 上的
`Pidance Desktop Setup <ver>.exe`：

1. 读 `https://api.github.com/repos/henlii/pidance/releases`，跳过 draft / prerelease，取比当前壳版本新、且带安装包的版本；
2. 流式下载到独立临时目录的 `.part`，同时算 sha256（不整块读进内存）；
3. 按 Release 资产声明的 `digest` 校验：**只有匹配才执行**；不一致或没声明摘要一律中止（没声明时给「打开下载页面」的人工退路），并删掉下载文件；
4. 校验通过才改名成安装包、先停掉本进程拉起的服务（复用外部服务时不动它），再 `/S` 静默安装并退出。

注意：同一个 Release 里的 sha256 只能证明「下载完整、与声明一致」，不是发布者身份签名——它能发现下载损坏
或被篡改的下载，不能抵抗仓库/发布凭据被攻破。

桌面制品**未做代码签名**，也没有 electron-updater 之类的后台自动更新：安装时会有 SmartScreen 提示，
安装与否由用户确认。

## 构建（Windows 产物在 Windows 上打，或 CI windows runner）

```bat
cd desktop
npm ci --include=dev
npm test                      :: 生命周期 / 瘦身 / 更新逻辑纯测试
npm run prune:win             :: 按 win32-x64 瘦身打包输入（可选，构建脚本会自动跑）
npm run build:win:installer   :: 瘦身 + NSIS 安装版（并留下 dist/*-unpacked 应用目录）
```

`prune:win` 会**就地改 `desktop/node_modules`**（删掉非目标平台与非运行资产）；在 Linux/macOS
上跑过之后要重新 `npm ci` 才能恢复本地开发用的原生模块。

## 验证

不是只看端口有没有人应答。三层验证，按成本从低到高：

```bat
:: 1. 纯逻辑（任何平台）
npm test

:: 2. 打包产物目录：页面 + _next 静态资源 + /api/about 版本 + 运行时 Node 版本 + node-pty + SDK 会话 + 关停
node scripts/verify-packaged.mjs --app-dir dist/win-unpacked --port 31419

:: 3. 真实 Electron 壳（需要 Windows 桌面会话）：加载页面、退出清理、端口释放
node scripts/smoke-shell.mjs --app-dir <打包产物目录或安装目录> --port 31421
```

`verify-packaged` 会真的建一个 SDK 会话（`POST /api/agent/new` 的 `ensure_session`）并确认
registry 认得它，最后发 SIGTERM/taskkill 检查进程退出、端口释放、临时状态目录能删掉
（有子进程占着文件就会失败）。它也会扫 stderr 里的 `Cannot find module` 之类缺失。

CI（[`.github/workflows/desktop-win.yml`](../.github/workflows/desktop-win.yml)，windows-latest）：

1. `npm ci` → 语法检查 → `npm test`；
2. 校验打包输入（内置服务版本 = `desktop/package.json` 声明；用包内 Electron 量运行时 Node 版本 ≥ 主包 engines）；
3. 打包 NSIS 安装版（构建脚本自动瘦身，并留下 `dist/*-unpacked` 应用目录）；
4. 打包产物目录 → `verify-packaged`（31419）；
5. 打包产物目录 → 真实壳 `smoke-shell`（31421）；
6. 静默安装到 `%LOCALAPPDATA%\Programs\Pidance Desktop` → 版本核对 → 壳冒烟（31422）→ 静默卸载 → 等目录消失；
7. 算 SHA256、输出体积摘要、上传 Artifacts（30 天）；
8. **`v*` tag 触发时**：等 `release.yml` 建好同一个 tag 的 Release，用 `gh release upload` 把
   Setup exe、sha256.txt 挂上去（主包 tgz 也在那个 Release 里）。

## 安全边界

- `contextIsolation: true` + `sandbox: true` + `nodeIntegration: false`，页面不注入 Node 能力。
- 预加载脚本只暴露白名单 IPC（桌面设置读写、桌面通知），参数在主进程侧再做类型校验。
- 只绑定 `127.0.0.1`，不对外网暴露；窗口内不加载外部站点。
- 更新：只从固定仓库的 Release 下载、只执行名字匹配 `Pidance Desktop Setup *.exe` 的资产，
  执行前必须通过 sha256 校验。

## 托盘与桌面设置

托盘菜单提供：显示窗口、开机启动、关闭窗口时最小化到托盘、桌面通知、检查更新、关于、退出。
设置保存在 Electron `userData`（`desktop-settings.json`），不写入 Web/Pidance 配置文件。
Web 端**已经消费**这些 IPC：设置里的「桌面版」页读写这三个开关（`getSettings` / `setSetting`），
托盘「桌面版设置…」会打开该页（`onOpenSettings`），会话在后台跑完时页面调用 `notify` 发系统通知。
页面侧只通过 preload 暴露的白名单方法访问，桥不存在时（普通浏览器）该页不出现、通知也不发。

## 开发模式

壳始终只操作 31415。调试时复用现有稳定服务，或把 `PIDANCE_SERVER_DIR` 指向**已安装稳定包目录**
（含 `bin/pidance.js`），不要让壳在 31415 启动工作区源码。

```powershell
cd desktop
npm ci --include=dev
$env:PIDANCE_SERVER_DIR = '<已安装稳定 Pidance 包目录>'
npm run dev
```

未打包模式在没有覆盖变量时仍会回退仓库根（`desktop/src/server-lifecycle.js` 的现状，不推荐）。
应用源码测试继续走 [31416](../docs/development.md)。
