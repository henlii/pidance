# Pidance

[English](./README.md)

![Pidance 横幅](https://raw.githubusercontent.com/henlii/pidance/main/docs/assets/pidance-banner.png)

Pidance 是基于 [Pi](https://github.com/badlogic/pi-mono) 的统一 Agent 工作空间上层客户端。它不脱离 Pi，而是读取本机 Pi 会话文件并遵循 Pi 的运行时语义，在浏览器里提供会话管理、实时对话、模型配置、技能管理和项目文件预览。

![Pidance 样例数据产品预览：会话侧边栏、带工具卡片的对话区和文件工作区](https://raw.githubusercontent.com/henlii/pidance/main/docs/assets/pidance-preview.png)

*样例数据产品预览：会话侧边栏、包含工具卡片的对话区与文件工作区。图中内容均为示意样例数据，并非真实运行会话。*

## 路线图

路线图、实施进度和验收标准统一记录在各阶段 tracking Issue 中：

- [第一阶段：架构 seam 与 OpenChamber 风格产品改造](https://github.com/henlii/pidance/issues/1)
- [第二阶段：补齐 Pi 生态高价值盲区（待办镜像、会话全文搜索、subagent 结果卡片、项目信任）](https://github.com/henlii/pidance/issues/2)
- [第三阶段：Pi 扩展生态可观测性与 Agent 默认值设置](https://github.com/henlii/pidance/issues/3)
- [第四阶段：辅助信息面与低频能力（统计、结果浏览、克隆、模板、版本）](https://github.com/henlii/pidance/issues/4)

## Upstream / 上游来源

Pidance 源自 [agegr/pi-web](https://github.com/agegr/pi-web)，遵循 MIT License；底层运行时来自 [badlogic/pi-mono](https://github.com/badlogic/pi-mono)。项目保留 Pi 的会话文件格式与运行时语义，现有 Pi 数据仍是事实来源。上游版权和派生作品说明保留在 [LICENSE](./LICENSE) 中。

## 快速开始

**无需安装，直接运行：**

```bash
npx @henlii/pidance@latest
```

**或全局安装后使用：**

```bash
npm install -g @henlii/pidance
pidance
```

启动后打开 [http://localhost:31415](http://localhost:31415)。命令行版本会在服务就绪后尝试自动打开浏览器。

**可选参数：**

```bash
pidance --port 8080              # 自定义端口
pidance --hostname 127.0.0.1     # 仅本机访问
pidance -p 8080 -H 127.0.0.1     # 组合使用
pidance --no-open                # 不自动打开浏览器

PORT=8080 pidance                # 也支持环境变量
PIDANCE_NO_OPEN=1 pidance        # 不自动打开浏览器（适用于后台服务或开机自启）
```

## HTTP 代理

Pidance 的服务端模型请求和 API 请求会读取标准的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY` 环境变量。

macOS 或 Linux：

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @henlii/pidance@latest
```

Windows PowerShell：

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @henlii/pidance@latest
```

## 功能介绍

- **把历史工作接回来**：打开网页就能按项目找到以前的 pi 对话，不必在终端里翻文件或记住会话路径。
- **放心试不同方向**：可以从某条历史消息重新开始，也可以复制出一条独立的新路线，探索方案时不怕弄乱原来的对话。
- **跨分支工作**：在侧边栏切换 Git worktree，让新会话和 Explorer 跟随你选择的 checkout。
- **边聊边看项目文件**：左侧浏览项目文件，右侧打开源码、文档、图片、音频和 PDF；文件变化会自动刷新，适合边让 agent 改边检查结果。
- **随时掌握会话状态**：在顶部就能看到上下文占用、花费、压缩结果和系统提示，长会话不再像黑箱。
- **少离开当前界面**：模型、登录/API key、模型测试和技能开关都能在网页里处理，配置 agent 时不用在多个工具之间来回切换。

## 注意事项

- **数据目录**：默认读取 `~/.pi/agent/sessions` 下的会话文件。可通过环境变量 `PI_CODING_AGENT_DIR` 指定其他 pi agent 目录。
- **会话文件**：路径形如 `~/.pi/agent/sessions/<编码后的工作目录>/<时间戳>_<uuid>.jsonl`。
- **模型配置**：Models 面板读写 pi agent 目录下的 `models.json`，模型列表和默认模型由 pi 的配置解析得到。
- **文件访问**：文件浏览和预览面向当前选择的项目目录，以及会话中已出现过的工作目录。
- **Git worktree**：什么时候显示切换器、新建目录在哪里、删除会影响什么，见 [Pidance 里的 Worktree](./docs/worktrees.zh-CN.md)。
- **Fork 与会话内分支不同**：Fork 会创建新的 `.jsonl` 文件；“Edit from here” 是同一会话文件里的分支。

## 开发

```bash
npm install
npm run dev
```

本地开发端口为 [http://localhost:31415](http://localhost:31415)。若同机还运行上游 [pi-web](https://github.com/agegr/pi-web)，请为其保留独立端口与数据目录，勿与 Pidance 混用。

常用检查：

```bash
node_modules/.bin/tsc --noEmit
npm run lint
```

开发时不要运行 `next build` / `npm run build`，它会写入 `.next/`，容易影响正在运行的 dev server。发布流程再执行构建。

## 项目结构

```
app/
  api/
    agent/          # 创建/驱动 AgentSession，提供 SSE 事件流和 bash 输出
    auth/           # OAuth 和 API key 管理
    cwd/validate/   # 自定义工作目录校验
    default-cwd/    # 获取 pi 默认工作目录
    files/          # 文件列表、读取、预览、搜索、上传和 watch
    file-index/     # 项目文件索引和 @ 提及搜索
    git/            # 当前项目的 Git diff 和 status
    home/           # 当前用户 home 目录
    models/         # 可用模型、默认模型、thinking levels
    models-config/  # 读写 models.json、测试模型
    plugins/        # package 插件管理
    sessions/       # 会话读取、重命名、自动命名、删除、上下文、状态、延迟 thinking 和 HTML 导出
    skills/         # skills 列表、搜索、安装、更新、检查和启停
    worktrees/      # Git worktree 列表、新建和删除
components/
  AppShell.tsx        # 主布局、URL 状态、顶部面板、文件标签
  SessionSidebar.tsx  # 项目选择、会话树、Explorer
  ChatWindow.tsx      # 消息区、SSE、拖拽图片、minimap
  ChatInput.tsx       # 输入栏、模型/工具/thinking/compact/slash controls
  MessageView.tsx     # 消息、thinking、tool call/result 渲染
  ModelsConfig.tsx    # 模型和认证配置面板
  SkillsConfig.tsx    # 技能管理面板
  FileExplorer.tsx    # 文件树
  FileViewer.tsx      # 源码、diff、图片、音频、PDF、DOCX 预览
lib/
  api-types.ts       # API 请求和响应的共享类型
  ansi.ts             # 终端输出的 ANSI 转义序列处理
  bash-output.ts      # bash 命令输出的格式化和解析
  custom-ui-terminal.ts # 自定义 UI 输出的终端适配器
  git-changes.ts      # Git diff/变更收集
  git-status.ts       # Git status 收集和规范化
  git-types.ts        # Git 数据共享类型
  http-dispatcher.ts  # 服务端 fetch 的 HTTP(S) 代理配置
  rpc-manager.ts      # AgentSessionWrapper 生命周期和全局 registry
  session-reader.ts   # 解析 .jsonl 会话文件和分支上下文
  session-file-references.ts # 会话引用文件的检查
  normalize.ts        # 规范化 toolCall 字段名
  file-access.ts      # 文件读取安全边界和允许的根目录
  file-fuzzy.ts       # 文件模糊搜索工具
  file-upload.ts      # 文件上传校验和冲突处理
  file-paths.ts       # 文件路径编码/相对路径工具
  models-cache.ts     # 模型列表和默认值缓存
  session-title.ts    # 会话标题和自动命名工具
  skill-updates.ts    # 技能更新操作
  skill-lock.ts       # 技能更新锁
  terminal-input.ts   # 终端输入处理
  worktree.ts         # 项目/worktree 解析和 Git 操作
  markdown.ts         # Markdown/Mermaid/KaTeX 插件配置
  pi-types.ts         # pi 相关类型
hooks/
  useAgentSession.ts  # 会话加载、发送命令、SSE 状态机
  useAudio.ts         # 完成提示音
  useDragDrop.ts      # 图片拖拽
  useKeyboardShortcuts.ts # 键盘快捷键处理
  useTheme.ts         # 主题切换
bin/
  pidance.js          # npm CLI 入口（仅 pidance；pi-web 归上游）
instrumentation.ts    # 初始化服务端 HTTP dispatcher
```
