<div align="center">
  <img src="./docs/assets/pidance-banner.png" alt="Pidance — Move with Pi" width="760">
  <p><strong>让 Pi 的会话、工具与项目工作流在浏览器里自然舞动。</strong></p>
  <p>
    <a href="./README.en.md">English</a> ·
    <a href="https://github.com/henlii/pidance/issues">问题反馈</a> ·
    <a href="./docs/README.md">文档导航</a>
  </p>
</div>

Pidance 是面向 [Pi](https://github.com/badlogic/pi-mono) coding agent 的开源 Web 客户端。它直接读取本机 Pi 会话文件，并沿用 Pi SDK 的会话与运行时语义，把实时对话、项目文件、Git、工作树、子代理和配置管理汇集到一个浏览器工作区。Pi 仍是数据与执行语义的事实来源；Pidance 负责提供更清晰、更完整的操作界面。

> 当前版本：`0.2.29` · npm 包：`@henlii/pidance` · CLI：`pidance`

## 界面预览

![Pidance 新会话工作区](./docs/screenshots/desktop.png)

<p align="center"><sub>新会话工作区：项目与工作树选择、模型、思考等级和右侧上下文面板。截图中的路径已脱敏。</sub></p>

![Pidance 外观设置](./docs/screenshots/settings.png)

<p align="center"><sub>外观设置：浅色、深色、跟随系统，以及 Chamber / Fusion 两套主题风格。</sub></p>

## 功能特性

- **项目化会话空间**：按 Project → Worktree → Session 浏览会话树，支持搜索、最近会话、归档、恢复、重命名、自动命名与 HTML 导出。
- **实时 Agent 对话**：通过 SSE 呈现流式回复、思考过程、工具调用、终端 ANSI 输出、压缩状态和运行中状态；页面恢复后自动对账。
- **安全探索不同方向**：从历史消息继续、创建会话内分支，或 fork 为独立 `.jsonl` 会话；两种分支语义清晰分离。
- **项目工作区**：浏览与预览源码、Markdown、图片、音频、PDF 和 DOCX，支持文件搜索、`@` 引用、Git 状态与 diff。
- **Git worktree 工作流**：在界面内选择、创建和移除工作树，新会话与文件工作区自动跟随所选 checkout。
- **Pi 生态集成**：展示同步与异步子代理运行状态、通用扩展 UI 卡片与交互，以及结构化 Todos 的只读投影。
- **集中配置**：管理供应商认证、API Key、模型与测试、会话默认值、技能、插件和项目信任。
- **精心打磨的界面**：响应式桌面/移动布局、命令面板、会话 minimap、完成提示音、中英双语，以及 Light / Dark / System 主题。
- **访问防护**：Host/CSRF 检查与登录认证；CLI 非回环监听必须配置密码。文件与 Agent 能力面向可信操作者，不提供项目目录沙箱，见[安全边界](./docs/security.md)。

## 快速开始

需要 Node.js `>= 22.19.0`。

### 无需安装

```bash
npx @henlii/pidance@latest
```

### 全局安装

```bash
npm install -g @henlii/pidance
pidance
```

服务就绪后访问 [http://localhost:31415](http://localhost:31415)。CLI 默认会尝试打开浏览器。

```bash
pidance --port 8080
pidance --hostname 127.0.0.1
pidance -p 8080 -H 127.0.0.1
pidance --no-open
```

也可使用 `PORT` 与 `PIDANCE_NO_OPEN=1`。监听端口同样可在 **设置 → 通用 → 服务与远程访问** 中配置
（默认 31415，重启后生效）。Pidance 默认读取 `~/.pi/agent`；可通过 `PI_CODING_AGENT_DIR` 指向其他 Pi agent 目录。

### 远程或局域网访问

默认仅绑定 `127.0.0.1`（本机），无需密码。推荐在 **设置 → 通用 → 服务与远程访问** 中设置密码并
开启「远程访问」开关（监听 `0.0.0.0`，重启后生效）；也可用 CLI 显式绑定并设置密码：

```bash
PIDANCE_PASSWORD='请使用强密码' pidance --hostname 0.0.0.0
```

绑定 `0.0.0.0`、`::`、局域网 IP 或其他非回环地址且未设置密码时，CLI 会拒绝启动
（fail-closed）。兼容旧变量 `PI_WEB_PASSWORD`，新部署优先使用 `PIDANCE_PASSWORD`。

### HTTP 代理

服务端模型与 API 请求读取标准的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY`：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
pidance
```

## 开发与测试

```bash
npm install
npm run dev       # 独立源码开发服务：127.0.0.1:31416，输出 .next
npm run check     # typecheck + lint + 单元测试
```

其他验收入口：

```bash
npm run verify:render-bridge  # 真实 pi-subagents 渲染桥
npm run test:browser          # 浏览器回归（需已运行的实例，默认 http://127.0.0.1:31416）
```

日常开发**不要**执行 `npm run build` 或 `next build`：它会写入 `.next/` 并干扰开发服务。正式构建只在隔离发布 checkout 中通过 `npm run release:check` 执行。

开发约定：**31415 保留给稳定安装版，工作区使用 31416**；持续测试输出到 `.next-public`，独立 dev 输出到 `.next`。`npm run dev` 已指向 127.0.0.1:31416（与持续部署同端口，不要同时运行）。测试数据与多端要求见[开发指南](./docs/development.md)。

## 发布

发布前完成 `npm run check`、版本与双语发布记录，显式提交并推送 annotated tag。tag CI 在隔离根构建、前后审计、打包，并通过 npm OIDC 发布及创建 GitHub Release。npm 与 Release 必须使用同一已验收 tgz 和 SHA-256；本地候选脚本不改版本、tag、push 或 publish。

完整步骤见 [docs/release.md](./docs/release.md)。

## 架构概览

Pidance 是 Pi 的 Web mode adapter：主 Agent 使用同进程 Pi SDK（`AgentSessionRuntime`）。
当前职责、交互链路与源码入口见[架构说明](./docs/architecture.md)；既有迁移规格见 [#20](https://github.com/henlii/pidance/issues/20)。

```text
浏览器 / Route Handlers
          │
          ▼
SessionService ───────▶ 只读会话投影与缓存
          │
          ▼
LiveSessionRegistry
          │
          ▼
SdkSessionHost ───────▶ Web Extension UI Adapter
          │
          ▼
Pi AgentSessionRuntime
  ├─ AgentSession
  ├─ AgentSessionServices
  └─ SessionManager

~/.pi/agent/sessions/*.jsonl 始终是 Pi 会话事实来源
```

- **只读浏览**直接解析 Pi `.jsonl` 会话，不创建 AgentSession；快扫和缓存不得写 JSONL。
- **写操作或显式 wake**按需创建或复用 SDK session host；SSE 本身只观察已有 Host。
- Pi SDK 拥有 Agent、会话替换、资源和 JSONL/tree 语义；Pidance 只拥有产品用例、live registry、Web 事件与 UI 适配。
- 单向依赖与单写者是维护约束；目前仍有销毁、队列、停止和恢复方面的[已知架构风险](./docs/architecture-review-2026-09-15.md)，不应把目标约束当作完整并发保证。
- 文件访问当前不限制在项目根目录；已认证使用者应视为拥有本机 Agent 与文件能力的可信操作者。

## 文档

完整入口：[文档导航](./docs/README.md)。

- [架构与会话交互](./docs/architecture.md) · [静态审查](./docs/architecture-review-2026-09-15.md)
- [开发与验证](./docs/development.md) · [安全边界](./docs/security.md)
- [Windows 桌面壳](./desktop/README.md) · [版本变更](./docs/release-notes/README.md)
- [Git worktree 使用说明](./docs/worktrees.zh-CN.md)
- [发布与制品审计](./docs/release.md)
- [历史界面设计稿](./docs/ui-redesign/README.md)
- [主题 Token 设计参考](./docs/ui-redesign/theme-tokens.md)

## 上游与许可

Pidance 源自 [agegr/pi-web](https://github.com/agegr/pi-web)，并围绕 [badlogic/pi-mono](https://github.com/badlogic/pi-mono) 的会话与运行时语义构建。感谢两个上游项目及其贡献者。

本项目采用 [MIT License](./LICENSE)。上游版权与派生作品声明保留于 LICENSE：Copyright © 2026 agegr；Copyright © 2026 Henry Li。
