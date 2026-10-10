# 开发与验证

[文档导航](README.md) · [架构](architecture.md) · [发布](release.md)

## 环境与隔离

- Node.js `>=22.19.0`；主 Pi SDK 精确版本由 [package.json](../package.json) 与 lockfile 锁定，当前为 `1.1.0`（`@earendil-works/pi-tui` 同版本）。
- 主仓和 `desktop/` 是独立 npm 包，各自维护 lockfile。
- 31415 保留给稳定安装版；工作区持续测试使用 31416。不操作上游 pi-web 的服务、目录或产物。
- 工作区禁止正式 `next build`。正式构建在隔离发布根运行，不能污染开发输出。

```bash
npm ci
npm run check
```

### 启动工作区

维护环境已有本地部署入口时，从仓库根执行：

```bash
node scripts/local-deploy.mjs restart
```

该入口使用 31416、Turbopack 与 `.next-public`；不经反向代理。它属于被 Git 忽略的本地维护工具，公共 clone 不保证包含该文件。

普通 clone 可直接启动独立源码开发服务：

```bash
npm run dev       # 127.0.0.1:31416，输出 .next（与持续部署的 .next-public 互不覆盖）
```

该端口与持续测试部署的 31416 相同，**不要同时运行**；两者同时需要时，把 dev 换到其他空闲端口（例如 `npm run dev -- -p 31417`）。显式 `-H 127.0.0.1` 保证 dev 服务不暴露到局域网（dev 无需密码，不应对外监听）。

首次启动前确认端口归属，不能为抢端口停止稳定版。

## 验证入口

| 命令 | 用途与前提 |
|---|---|
| `npm run typecheck` | TypeScript 检查 |
| `npm run lint` | ESLint 与边界静态检查 |
| `npm test` | `lib/`、`components/`、`hooks/`、`bin/`、`scripts/lib/` 单测 |
| `npm run check` | typecheck → lint → 全部上述单测 |
| `npm run verify:render-bridge` | 真实 pi-subagents 渲染桥；先准备相关依赖 |
| `npm run test:browser` | 需要运行中的测试服务及浏览器自动化环境 |
| `npm run test:browser:context` | 需要测试服务、agent-browser 和可用模型，可能产生 API 调用费用 |
| `npm run test:browser:sse` | 桌面/窄视口录制回放，检查流式投影 |
| `cd desktop && npm test` | 桌面壳纯逻辑测试（生命周期/瘦身/更新逻辑）；不替代 Windows 产物验证 |
| `cd desktop && npm run prune:win` | 按 win32-x64 类别瘦身打包输入；**会就地改 `desktop/node_modules`**（Linux 上跑完需 `npm ci` 复原） |
| `cd desktop && npm run verify:packaged -- --app-dir <解包目录>` | 在真实打包产物上验页面/静态资源/版本/node-pty/SDK 会话/可停 |
| `cd desktop && npm run smoke:shell -- --app-dir <解包目录>` | 用真实 Electron 壳加载页面并检查退出清理（需 Windows 桌面会话） |

浏览器脚本使用 `PIDANCE_TEST_URL`，默认 `http://127.0.0.1:31416`。具体 fixture 和环境依赖以各测试文件开头为准。静态文档核对不代表这些测试已经执行。

## 测试数据与多端

1. 先跑受影响模块测试，再做 typecheck/lint 与完整单测。
2. 应用代码修改后，维护环境部署 31416；纯文档修改不重启服务。
3. 桌面浏览器、手机窄视口/触摸、后台恢复、多标签与 Electron 共用服务端语义；涉及分叉时同步检查，不能只验一面。
4. 单元测试使用临时 agentDir。需要完全隔离服务数据时设置 `PI_CODING_AGENT_DIR`，不要复制真实凭据作为 fixture。
5. 浏览器 QA 仅用专用测试会话；创建提示会话的 body 必须含 `type:"prompt"`。不向用户现有会话发送测试内容。
6. 测试结束清理本次创建的会话和临时文件，确认对象归属后再删除；不能用通配符清理其他任务的数据。

优先补齐的跨模块回归见 [静态审查建议回归矩阵](architecture-review-2026-09-15.md#建议回归矩阵)。

## 桌面开发

见 [Desktop README](../desktop/README.md)。壳只操作 31415，调试时指向已安装的稳定 Pidance 服务目录或复用现有稳定服务，不将仓库源码作为 31415 的服务制品。

## 候选与正式构建

- 本地候选：`npm run package:candidate`，不会改版本/tag/push/publish。
- 正式发布：[发布指南](release.md)，由 tag 触发 CI，执行前后审计。
- 产物目录及清理：[产物管理](artifacts.md)。

# 风险验证矩阵

| 风险 | 最小证据 | 建议命令 |
|------|----------|----------|
| 纯文档 / Skill | 相对链接、diff check | `git diff --check -- AGENTS.md .agents/skills/` |
| SDK 依赖与 server-only 边界 | 版本/Node engine 一致；client 无 SDK import；OAuth Route 仅保留 allowlist 动态 import；发布包可安装 | SDK import 静态门禁 + `node_modules/.bin/tsc --noEmit` |
| Live registry | 同 id 并发启动合并；destroy/idle 清理；fork 后 registry 不留旧 key | registry/host 定向测试 |
| SDK host | prompt 预检、状态、事件、abort、bash、tools、compaction、dispose | host 定向测试 + 无网络 fixture |
| 会话替换 | new/switch/fork teardown、事件重绑、Extension context 失效、路径缓存重键 | `AgentSessionRuntime` 窄集成测试 |
| JSONL / tree | 单写者、SDK SessionManager/禁止外部 writer、compaction context、exact leaf、turn-end、fork、leaf sidecar 重启恢复 | 临时目录 `SessionManager` fixture；禁止真实 `~/.pi/agent` |
| Extension UI | request id、FIFO、响应、timeout、AbortSignal、status/widget、ANSI、custom terminal | adapter + `extension-ui-bridge` + dialog 定向测试 |
| SSE / reconciliation | reconnect、单调 run id、`agent_settled`、旧响应不复活运行态 | EventStreamManager/useAgentSession 定向测试 |
| API 边界 | 缺参/非法命令 400；read-only 403；运行异常不丢 session | route 与 SessionService 测试 |
| RPC 退役 | 生产代码无 `pi --mode rpc`、runtime slot、主 runtime 二进制探测；subagent CLI 独立可用 | `rg` 静态门禁 + subagent bridge 测试 |
| 跨 seam | Route → SessionService → registry → host → SDK 单向；无反向 import | 依赖边界测试 + `npm run lint` |
| 浏览器产品行为 | 专用测试会话覆盖发送、abort、compact、fork、分支、Extension UI、刷新恢复 | 31416 浏览器回归；完成后删除测试会话 |
| SSE 流式 / 移动端视口 | 固定时间戳 recording 经真实 registry/EventStreamManager/ChatWindow 回放，两端 timeline 一致且额外客户端延迟有上限 | `npm run test:browser:sse`（桌面 + 390×844） |
| 顶栏上下文实时读数 | 运行中读数在 run 结束前更新 | `npm run test:browser:context` |
| 多端 | 桌面浏览器、手机（触摸/后台/窄视口）、Electron、多标签：同一行为或分叉已在本变更改齐 | 动手前列表面；无头桌面 + 窄视口逻辑；触及 `desktop/` 才跑桌面路径 |
| 发布 | 同一 tgz 前后 allowlist 审计、SHA256、安装与 HTTP 冒烟 | 隔离发布 checkout 执行 `npm run release:check` 与 tgz 审计 |

## 验证顺序

1. 先跑受影响深模块的定向测试，使失败定位在 owner。
2. 再跑 `node_modules/.bin/tsc --noEmit` 与 `npm run lint`。
3. 运行完整 `npm test`，确认 legacy 删除没有留下静态引用。
4. 每次应用代码修改后执行 `node scripts/local-deploy.mjs restart`，检查 31416 健康。
5. 使用专用测试会话做浏览器 QA；正常会话不发送测试消息。
6. 正式构建、pack、安装冒烟只在隔离 checkout 执行，不污染工作区 `.next/`。

## 必测失败路径

- SDK 缺失、版本不匹配或 Node 低于 SDK engine 时启动应明确失败。
- prompt 预检失败不写 user message，不留下 running 假状态。
- fork/new/switch 任一步失败时，旧会话文件保持可恢复，registry 不挂半初始化 host。
- Extension UI timeout/abort/dispose 只清理目标请求，不 resolve 成伪造用户输入。
- sidecar 损坏、过期或目标 entry 不存在时安全降级到 Pi 默认 leaf。
- live writer 存在时任何离线 append/branch 必须拒绝或先完成受控 teardown。
- 外部 RPC 代码删除后，`pi-subagents` 仍能解析包内 Pi CLI。

纯文档与 Skill 修改不重启 31416；至少检查全部相对链接、UTF-8、统一 CRLF 和 diff。

## 本地测试纪律

> **用户定的硬规矩（2026-09-26）：测试一律在 31416 做，不要再起 31417 或任何第二个实例。**

**测试会话的生命周期（用户 2026-09-30 定下的硬规则）**：测试会话**用完立刻就删**，
- 同一回合内多次会话测试**尽量复用**同一个测试会话，不要每项验证都新建一个。
最晚不超过主控会话的**本回合结束** —— 不要把测试会话留到下一轮再清。
删不掉通常是因为它仍持有存活 host 或打开的扩展面板：先关面板 / 等空闲回收再删；
确实删不掉的必须在回复里说明（哪几个 id、什么状态），不要默默留着。
> 本文后面那些「隔离实例 / 独立 agent dir / 31417」的段落是历史做法，已作废，只留作事故复盘参考。
>
> 在 31416 上测试要注意的：
> 1. **只用自己刚建的测试会话**（提示词里带明确标记，便于事后按标记删除）。绝不打开用户自己的会话，
>    也不要用「列表里的第 0 条」这种写法选目标 —— 2026-09-25 那次事故就是这么打开的。
> 2. 测完**按标记删掉**自己建的会话（DELETE /api/sessions/<id>），别把垃圾留在用户的会话列表里。
> 3. 31416 用的是真实 `~/.pi/agent`：不要改用户的 settings/models/auth，不要动用户的偏好文件；
>    要临时登记 QA 扩展就当场登记、用完立刻撤掉。
> 4. 31415 稳定安装版永不操作；上游服务永不操作。
>
> ── 以下为历史记录 ──

# 本地隔离测试（历史做法，已作废）

不依赖 Docker。常规每次应用代码修改后的可测试部署使用持续部署脚本：

```powershell
node scripts/local-deploy.mjs restart
```

`local-deploy.mjs` 会按平台选择实现：Linux 使用 systemd，Windows 使用独立
Node 子进程；两者都固定构建到 `.next-public` 并只管理 31416。Windows 的状态和
日志保存在 `%TEMP%` 下，不需要管理员权限。

构建：Turbopack → `.next-public`（单次 build；温构建约几十秒）。本机实测与运维记录位于
`.local-ops/deploy/local-31416-build.md`；通用方法见 **nm-deploy** `references/local-test-build-speed.md`。
**不要**在 unit 里再跑一遍 `next build`。

**端口规范（当前）**：

| 端口 | 角色 |
|------|------|
| **31415** | Pidance 正式安装版（Windows 固定使用安装版）；反代只指此端口 |
| **31416** | Pidance 持续测试与隔离 smoke 约定端口；不对外反代 |

持续测试与隔离 smoke 固定 **31416**（unit 前缀 `pidance-local-31416-*`）。

持续部署使用当前工作区和依赖，固定 `0.0.0.0:31416`；隔离 smoke 固定 `127.0.0.1:31416`。正式安装版（**31415**）始终独立保留且不被工作区部署操作。安装版、测试版与其他服务的目录 / 进程 / 构建产物 / PID / 日志不可混用。纯文档或 Skill 修改无需重启应用，除非用户要求。

风险较高、需要只读隔离验证时，不依赖 Docker。隔离脚本默认只读，监听 **127.0.0.1:31416**，并在启动前确认该端口空闲；发现正式版或其他服务占用端口时直接拒绝。运行隔离流程前必须先停止持续测试部署，验证完成后再执行持续部署 `restart`；两者均不得影响正式安装版。

```bash
node .agents/skills/pidance-development/scripts/isolated-test.mjs help
node .agents/skills/pidance-development/scripts/isolated-test.mjs run
```

脚本用 Node 内置模块把仓库复制到当前用户临时目录下的 `pidance-isolated-<uid>` 根目录的 `app`，排除 `.git`、`.next`、`node_modules`、`.env*`、敏感和生成物，并安全链接源仓库现有 `node_modules`（Windows 使用 junction）。状态、PID、日志在根目录独立保存；不复制用户 Pi agent 目录，保持 HOME 不变以复用 Pi 的 settings/models/auth/session 数据，但脚本不读 auth.json。可用 `PIDANCE_ISOLATED_ROOT` 指定临时根；命名须为 `pidance-isolated-<uid>`。

`prepare`、`start`、`status`、`smoke`、`stop`、`clean`、`run` 均可单独使用。`run` 执行 prepare → start → smoke → stop，默认不 clean，方便查看日志；需要清理时显式执行 clean，且运行中拒绝清理。start 在镜像内使用隔离的 `.next-public` 产物启动 `pidance.js -p 31416 -H 127.0.0.1`，等待 `/api/home`，不调用正式安装版。prepare 会在镜像内保留源 `next.config.ts` 的副本，并生成仅扩展 `turbopack.root` 的临时包装配置，使共享 `node_modules` 链接仍位于 Turbopack 文件系统边界内；该配置不会写回源仓库。

只读 smoke 仅允许检查 `/api/home`、`/api/models`、`/api/sessions` 的 HTTP 状态和结构摘要，不创建 AgentSession、不接管 live session、不输出完整会话或模型凭据。任何写入测试必须显式 opt-in，使用专用 cwd 和专用测试会话，不得并发接管现有运行会话；清理时只能删除确认属于本次测试的会话。

## 验证脚本绝不要写进真实 agent dir（2026-09-25 事故）

**症状**：用户在稳定安装版（31415）里看到自己的会话被标未读、列表里出现不该有的状态，
并抱怨「双进程的隔离有问题」。

**根因（我的操作，不是产品缺陷）**：
1. 我的验证脚本把会话列表里的**用户真实会话**当成打开目标（图方便，用 `sessions[0]` / `list.find(...)`）。
   打开会话会让该进程进入 starting 并在结束时被判为「跑完了」，于是给用户的会话写了一条
   `unreadSessionState.completedAt.<id>` —— 用户侧栏立刻多一个未读。
2. 我的测试会话直接建在共享的 `~/.pi/agent` 里，测试结束只删了会话、留下的未读条目变成死条目。
3. 我的进程还**握着用户会话的 writer 租约**，用户在稳定版里打开同一会话会被挡住。

**纪律**：
- 验证脚本**不得打开 `~/.pi/agent` 里的用户会话**；一律用自己新建的测试会话。
- 需要跑真实模型（`auth.json` 为空、凭据在 `models.json` 的 `apiKey`）时，用**独立 agent dir + 独立端口**：

```bash
mkdir -p ~/.pi/agent-qa
cp -n ~/.pi/agent/{models.json,settings.json} ~/.pi/agent-qa/   # 拷贝而不是软链，避免测试写回真实文件
setsid nohup env -u NODE_ENV -u TURBOPACK -u PI_WEB_PASSWORD -u PIDANCE_PASSWORD \
  PI_CODING_AGENT_DIR=$HOME/.pi/agent-qa PIDANCE_DIST_DIR=.next-public \
  node bin/pidance.js -p 31417 -H 127.0.0.1 --no-open > /tmp/pidance-qa-31417.log 2>&1 &
```

  会话、租约、未读、偏好全部落在 `~/.pi/agent-qa/`，与 31415/31416 的真实状态互不影响。
- 31416 是「持续测试部署」，它**共享**真实 `~/.pi/agent`（这是既有设定），所以更要避免在它上面
  创建/驱动测试会话；要么用上面的 31417，要么用完立刻删掉并清理未读条目。
- 事后清理未读条目要**走仓库自己的加锁写入**（`updatePidancePref(..., null)`），不要手写偏好文件：

```bash
# 脚本必须放在仓库里跑，否则裸 import "jiti" 解析不到
cd /home/moss/works/open/pidance && node ./.tmp-clean-unread.mjs && rm -f ./.tmp-clean-unread.mjs
```

## 浏览器 QA 的 harness 事实（agent-browser，2026-09 实测，会反复踩）

- **`network route <url> --body` 拦不到 page-initiated fetch**（agent-browser 0.27.0）：同一已加载文档、
  重新导航、经 `about:blank` 再导航、加 `--resource-type fetch,xhr` 四种试法都拿到真响应；
  但 **`network route <url> --abort` 生效**（fetch 直接失败）→ 拦截层本身是通的，只有 body mock 不行。
  要在页面里换掉某个接口的响应，用**导航前注入的 init script** 包装 `window.fetch`。
- **`AGENT_BROWSER_INIT_SCRIPTS` 收的是逗号分隔的「文件路径」**，不是内联代码：传代码会被当不存在的路径
  **静默忽略**。这个版本没有 `addinitscript` 子命令。init script 注册后**卸不掉**（清环境变量也不行），
  重启 Chrome 才彻底清；所以脚本要写成「可换载荷」的形状（把载荷放 localStorage，而不是重注册脚本）。
- **`agent-browser open <同一 URL>` 不保证真的重载文档**：旧 DOM 会留下，重新读 DOM 会读到刷新前的页面。
  要真刷新先 `open about:blank`，并用「localStorage 里的标记仍在、而 `window.__probe` 变 undefined」来证明。
- 页面**没挂载**时先看是不是没登录：把登录页当成产品 bug 会白查一轮。
- 判断「某个会话的页面」不要读 `document.body.innerText`：侧栏每行显示的是该会话的首条用户消息，
  不同会话的标记会互相混。时间线读 `[data-pidance-chat="true"]` 里的 `[data-chat-scroller="true"]`。
- 运行中状态在侧栏是行上的 `[aria-label]`（i18n 的「运行中」）与 `[title]`。会话的**选中态**没有
  aria-selected，只有内联 `background: var(--bg-selected)`，所以别用角色选择器断言选中。
- **宿主只在被写动作创建**：仅仅打开页面**不会**建 host（多次轮询 `/api/sessions/<id>/state` 仍是
  `live:false`），因此所有 host-only 投影字段（`extensionShortcuts`、`extensionTerminalInputListenerCount`、
  `extensionAutocompleteProviderCount` 等）都读不到，整批断言会假红。要么从**页面自己的输入框**发一条提示
  （设 textarea 值 + 派发 `input` + 派发可取消的 Enter keydown），要么先确认 `live:true`。
- **扩展夹具要按「扩展视角」解析 pi-tui**：本机磁盘上可能有两份（顶层 + SDK 下的嵌套副本），
  模块实例与能力缓存都不共享。用 `createRequire(<SDK 包目录>)` 解析，否则会验出假结论（见 AGENTS.md 那条）。
  同步渲染器（如 entry renderer）必须**同步** require，Node 24 支持 require(esm)。
- 假的 `~/.pi/agent-qa` **没有**凭据就发不了提示：从真实 agent dir `cp -n`（**不要 symlink**）
  `models.json` / `settings.json` / `auth.json`；插件夹具用 `settings.json` 的 `packages` 数组里的
  **单文件路径**登记即可被 Pidance 自己的 loader 加载。
- 每次做完 QA 记得清场：按 `ss -ltnp` 读出的 PID 停实例（**别 `pkill -f`**）、把夹具条目从隔离
  `settings.json` 移除、删隔离 sessions 目录、确认真实 `~/.pi/agent/pidance-preferences.json` 不含 QA 会话 id。

# 编码与产物约定

从根 `AGENTS.md` 搬来的细节（AGENTS.md 只留每条 1–3 行的 standing orders 并链接回本文件）。

## 行尾与补丁

- 新 TS/TSX/MJS 用 **CRLF**；编辑既有文件保持它的原行尾，不要把 CRLF 文件改成 LF。
- 用脚本改仓库文件时：解码 UTF-8 → 归一成 LF → 替换 → 还原 CRLF → 写字节；每个 anchor 先断言
  `count == 1`，全部断言通过后再写盘（python 补丁跨文件**不是**原子的：中断可能已改到一半）。
- 多段脚本失败后必须重新 `tsc`／grep 确认哪些文件真的落地了，不要假设整批回滚。

## i18n 与样式

- 文案：`lib/locales/en.ts` 是 `TranslationKey` 的唯一源，`zh-CN.ts` 必须是它的完整映射；新键
  **两处同加**，组件一律经 `useI18n()`，禁止硬编码。
- 颜色：只用 `app/globals.css` 里的 CSS 变量，不在组件里写死色值。
- Route 约 50 行：校验与状态码留在 route，业务下沉 `lib/`。只读投影失败返回 200 安全空态，
  缺参 400、越权 403、冲突 409。

## `globalThis` 键登记表

新增键必须登记并写失效入口，否则内存会留下跨请求的旧值。

| 键 | 位置 | 失效 |
|----|------|------|
| `__piSessions` | live-session-registry | dispose / 替换 |
| `__piStartLocks` | live-session-registry | start 完成 |
| `__piRunningListeners` | live-session-registry | 退订 |
| `__piSessionListCache/Promise/Generation` | session-reader | 刷新 / generation++ |
| `__piSessionPathCache` / `__piPathToSessionIdCache` | session-reader | 新会话登记 |
| `__piAllowedRootsCache` / `__piAdditionalAllowedRoots` | file-access | `allowFileRoot()` |
| `__piModelsCacheState` | models-cache | 模型配置变更 |
| `__piLoginCallbacks` | auth login | 短期过期 |
| `__piFileIndexCache` | file-index | 自身刷新 |
| `__piPidanceLatestCache` | pidance-update | 30min TTL |
| `pidance/server-shutdown/v1` | server-shutdown | `resetShutdownStateForTests()` / 收尾完成 |
| `@agegr/pi-web/session-liveness/v1` | session-liveness | `clearSessionLivenessProviders()` / 注销 |
| `__piSessionReadViewCache` | session-read-manager-cache | 删除 / 重命名 / 追加后 `invalidateSessionReadCache()` |
| `__piPidanceExtensionProvidersCache` | extension-providers | `invalidateExtensionProvidersCache()` / 插件安装卸载后 |
| `__piPidanceLoadedExtensionsCache` | loaded-extensions | `invalidateLoadedExtensionsCache()` / 插件安装卸载后 |
| `__piPidanceMarkdownTransformerCache` / `__piPidanceMarkdownTransformMemo` | extension-markdown-transformers | `invalidateMarkdownTransformCache()` / 插件安装卸载后 |
| `__piCrossProcessWatch` | cross-process-watch | 最后一个订阅者退订 / `stopCrossProcessWatch()` / `resetCrossProcessWatchForTests()` |

磁盘缓存：`~/.pi/agent/pidance-session-cache.json`（mtime/size 失配即失效）；
跨进程 running 租约：`~/.pi/agent/pidance-running-leases/`。

## 产物管理

只留当前在用的一份编译输出：31416 → `.next-public`；dev → `.next`（无 `BUILD_ID` 则可删）；
发布 → 最新的 `henlii-pidance-<ver>.tgz` + sha256。候选构建根可留 `node_modules`，打完即删其中
`.next` 与旧 tgz；正式安装目录最多 current + 上一版。禁止为清盘操作 31415 进程。

## Windows 桌面壳（`desktop/`）

独立包 + 独立 lockfile，版本与主包同步，精确锁定 `@henlii/pidance`；生命周期/瘦身/更新逻辑测试
为 `cd desktop && npm test`。产物由 `desktop-win` workflow 构建：只出 NSIS 安装版，按平台类别
瘦身后打包 → 在 `dist/*-unpacked` 上验页面、`_next` 静态资源、版本、node-pty、SDK 会话与可停 →
真实 Electron 壳冒烟 → 静默安装/卸载。桌面壳只操作 31415。

**发布冻结（2026-10-09 起）**：桌面版暂时停更。发主包时不动 `desktop/` 的版本与 lockfile、不跑
`release:desktop-check`、Release 不附 Setup；代码与 workflow 都留着。注意 `v*` tag 仍会触发
`desktop-win` 构建并附上约 157MB 的 Setup（已知，未擅自改动 CI）。

## Commit message

中文口语化主题 + conventional 前缀（`fix(panel):`、`feat(host):`、`chore(release):`），正文写清
改前因果与改后行为，结尾一行门禁：`门禁：tsc --noEmit；eslint 0 error；npm test N 项通过`。
