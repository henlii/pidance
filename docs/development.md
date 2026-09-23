# 开发与验证

[文档导航](README.md) · [架构](architecture.md) · [发布](release.md)

## 环境与隔离

- Node.js `>=22.19.0`；主 Pi SDK 精确版本由 [package.json](../package.json) 与 lockfile 锁定，当前为 `0.87.0`。
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
node .agents/skills/pidance-development/scripts/local-deploy.mjs restart
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
