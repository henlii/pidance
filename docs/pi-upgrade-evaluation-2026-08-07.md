# Pi 版本升级调研：0.81.1 → 0.84.1 对 Pidance 的影响

- **日期**：2026-08-07
- **范围**：`@earendil-works/pi-{coding-agent,agent-core,ai,tui}` 从 **0.81.1**（当前锁定）到 **0.84.1**（npm latest）
- **权威来源**：
  - [packages/coding-agent/CHANGELOG.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md)
  - [packages/agent/CHANGELOG.md](https://github.com/earendil-works/pi/blob/main/packages/agent/CHANGELOG.md)
  - [packages/ai/CHANGELOG.md](https://github.com/earendil-works/pi/blob/main/packages/ai/CHANGELOG.md)
  - 0.84.1 包内 `docs/rpc.md`、`dist/**/*.d.ts` 与本地 `node_modules` 0.81.1 对照
- **结论摘要**：**可升级，但不是 drop-in**。主路径（进程内 `AgentSession` + `SessionManager`）大体兼容；最大风险在流式事件契约、`ModelRuntime` 签名、以及若干 auth/provider 行为变化。建议分阶段：先 0.82.x 冒烟 → 0.83 → 0.84.1，并强制跑流式 SSE / 登录 / 模型列表 / 会话树验收。

---

## 1. 版本事实

| 项 | 值 |
|----|-----|
| Pidance 当前 | `@earendil-works/pi-{agent-core,ai,coding-agent,tui}` **0.81.1**（`package.json` 精确钉死） |
| npm latest | **0.84.1**（2026-08-07 发布） |
| 中间版本 | 0.82.0 → 0.82.1 → 0.83.0 → 0.84.0 → 0.84.1 |
| 仓库 | `github.com/earendil-works/pi`（coding-agent 子包） |
| 与 `@mariozechner/pi-*` | **不同发布线**；官方个人包停在 ~0.73.x，Pidance 跟的是 earendil-works 线 |

跨度约 **17 天**（0.81.1 于 07-21，0.84.1 于 08-07），含 3 个 minor + 2 个 patch。

0.84 起 coding-agent 新增依赖：

- `@earendil-works/pi-client`（远程会话客户端，CBOR）
- `@earendil-works/pi-protocol`
- `grok-mermaid`（TUI Mermaid）
- `undici` 升至 8.9.0

---

## 2. 按版本：升级内容（只列与嵌入式客户端相关）

### 2.1 0.82.0（2026-07-24）

**能力**

- 工具 **constrained sampling**（strict JSON Schema / Lark grammar），模型能力元数据门禁
- **OpenRouter OAuth PKCE**、**Kimi Code 订阅 OAuth** 登录
- bash 工具注入 `PI_SESSION_ID` / `PI_SESSION_FILE` / `PI_PROVIDER` / `PI_MODEL` / `PI_REASONING_LEVEL`
- RPC **`bash_execution_update`** 流式输出（带 request id）

**对 Pidance**

| 影响 | 说明 |
|------|------|
| 中 | 登录面多了 OpenRouter/Kimi OAuth；现有 `ModelRuntime.login` + SSE 路径应可接，但交互文案/回调需回归 |
| 低 | bash env 注入对扩展/脚本有利，Pidance 无需改码 |
| 低 | `bash_execution_update` 仅影响 **RPC 直连 bash 命令**；Pidance 主要走工具 bash，可先透传/忽略 |
| 无 | constrained sampling 默认在工具定义侧；Pidance 未自定义 tool schema 采样 |

### 2.2 0.82.1（2026-07-25）

- Claude Opus 5（Anthropic / Bedrock）
- `ANTHROPIC_AUTH_TOKEN` bearer 网关鉴权
- 模型目录 `If-None-Match` 条件刷新（304）
- 修复：纯 header 鉴权下的 compaction/branch summary；scoped 模型 UI；llama.cpp 目录持久化

**对 Pidance**：模型目录/认证更稳；Opus 5 自动出现在列表。几乎无破坏性。

### 2.3 0.83.0（2026-07-29）

**能力**

- `pi auth print-api-key` / `print-bearer-token`（外部客户端导出凭证 + OAuth 刷新）
- OpenRouter **headless** 登录（粘贴 redirect URL / code）
- Claude Opus 5 on GitHub Copilot
- 扩展 `ctx.scopedModels`
- stop reason：`pending`；`rawStopReason`；未映射终态改报 provider error
- OAuth 提前 5 分钟刷新

**破坏**

- 捆绑 **TypeBox → 1.3.7**，移除 `Type.Base` / `Type.Awaited` / `Value.Mutate` 等

**对 Pidance**

| 影响 | 说明 |
|------|------|
| 中 | headless OpenRouter 与现有「manual code」登录 SSE 高度相关，应回归 `app/api/auth/login/[provider]` |
| 低 | TypeBox：Pidance 自身几乎不直接依赖已删 API；扩展/插件若用旧 TypeBox 会炸 |
| 低 | stop reason 更严：原先「假成功 stop」可能变成错误气泡——偏正确性修复 |
| 机会 | credential export CLI 可考虑未来给桌面/外部工具，非必须 |

### 2.4 0.84.0（2026-08-06）— **本轮最大变更**

#### 破坏性（按 Pidance 相关度）

| # | 变更 | Pidance 相关度 |
|---|------|----------------|
| A | **JSON/RPC `message_update` 只保留 `assistantMessageEvent` delta**，去掉累计 `message` 与 `assistantMessageEvent.partial` | **高风险面（见 §3）** |
| B | `ModelRegistry.getApiKeyAndHeaders()` 返回 `string \| null`，`null` 表示删 header | 中（若转发 header 须透传 null） |
| C | `ModelRegistry.refresh()` → `ModelsRefreshOptions` / `ModelsRefreshResult` | 中（`ModelRuntime.refresh` 签名已变） |
| D | `ModelRuntime.setRuntimeApiKey()` 不再吃 catalog refresh options | 中（api-key 路由若传旧第二参） |
| E | OAuth `refreshToken(credentials, signal)` 必须接受 abort signal | 中（自定义 provider 扩展） |
| F | 动态 provider：`context.store` → `context.stored` + `context.publish()` | 低（Pidance 不手写 refreshModels） |
| G | **pi-agent-core harness v4**：`Session` / `SessionStorage` / `SessionRepo`，去掉 legacy JSONL repo；`FileSystem.renameFile()` 必填 | **低～中**：Pidance 会话主路径是 **coding-agent `SessionManager`**，不是 harness repo；但 `session-title` 用 `Agent` 类需回归 |
| H | harness 实验 API 升为默认 export，去掉 experimental 子路径 | 低（Pidance 未 import experimental） |

#### 能力

- 全屏 TUI、Mermaid/LaTeX 渲染（主要利 CLI，Web 无关）
- `AGENTS.override.md` 按目录覆盖上下文
- `samplingParams` / vLLM `thinking_token_budget`
- Baseten provider
- 实验性 **RemoteSession / PiClient**（`@earendil-works/pi-client`）
- `AgentOptions.shouldStopAfterTurn`
- telemetry 契约（`pi-telemetry`）
- 大量 compaction / credential 并发 / 目录刷新 / symlink 会话发现修复

### 2.5 0.84.1（2026-08-07）

- Qwen Token Plan Individual
- `pi auth check`
- 扩展 `tool_call` 可 `terminate` 整批
- **`Agent.reset()` 在运行中拒绝**，须 idle 后才能 reset
- TUI 全屏交互修复

**对 Pidance**：若某处对运行中的 agent 调 `reset()` 会从「静默清状态」变成 throw，需确认无此调用（当前代码检索未见直接 `Agent.reset`）。

---

## 3. Pidance 耦合面与冲击评估

### 3.1 当前依赖与导入面（摘要）

| 包 | 用途 | 关键入口 |
|----|------|----------|
| `pi-coding-agent` | 会话生命周期、SessionManager、ModelRuntime、Settings、插件/技能 | `lib/rpc-manager.ts`、`lib/session-reader.ts`、`lib/session-service.ts`、auth/models/plugins routes |
| `pi-agent-core` | 标题生成 shadow `Agent` | `lib/session-title.ts` |
| `pi-ai` / `pi-ai/compat` | thinking levels；模型连通测试 `completeSimple` | `app/api/models/route.ts`、`models-config/test` |
| `pi-tui` | 自定义 UI 终端渲染桥 | `lib/tui-render-bridge.ts`、`rpc-manager` keybindings |

主运行模型：

```text
Browser SSE ← projectAgentEvent ← AgentSessionWrapper.onEvent
                                      ↑
                         AgentSession.subscribe (进程内 SDK)
                                      ↑
                    createAgentSessionFromServices + SessionManager
```

**不是** 子进程 RPC mode；因此 0.84 changelog 里写的「JSON and RPC message_update」**不一定**等于进程内 SDK 事件。

### 3.2 流式 `message_update`（最关键）

**0.81.1（现状）**

- agent-core / AgentSession 事件：`{ type, message, assistantMessageEvent }`
- Pidance `projectAgentEvent`：**删除** `assistantMessageEvent`，保留累计 `message`
- 客户端 `useAgentSession`：`message_update` 用 `event.message` 做 replace 式流式更新

**0.84.1 实测（agent-core dist）**

- **进程内** `agent-loop` 仍 emit：
  ```js
  { type: "message_update", assistantMessageEvent: event, message: { ...partialMessage } }
  ```
- AgentSession 仍向 listener 转发带 `message` 的更新
- **仅 RPC/JSON 文档**声明去掉累计 `message` 与 `partial`

| 场景 | 升级后预期 |
|------|------------|
| 当前进程内 SDK 路径 | **短期可继续工作**（仍有 `message`） |
| 未来 agent-core 与 RPC 对齐去掉 `message` | **流式全挂**：`projectAgentEvent` 删了 delta，客户端又只读 `message` |
| 若误走 RPC 协议客户端 | 立刻挂 |

**建议（升级时必做）**

1. 安装 0.84.1 后用真实 SSE 抓一帧 `message_update`，确认是否仍含 `message`
2. 无论是否含，尽快改为 **双轨**：
   - 有 `message` → 沿用累计快照
   - 仅有 `assistantMessageEvent` → 在客户端/服务端组装 partial（`message_start` + delta，`message_end` 权威）
3. 停止「无脑 strip assistantMessageEvent」作为唯一策略；至少在服务端保留组装能力

### 3.3 SessionManager / 会话文件

对照 0.81 vs 0.84 `session-manager.d.ts`：

- `SessionManager.open/create/forkFrom`、`getEntries`、`getLeafId`、`getTree`、`buildSessionContext` 等 **表面 API 稳定**
- 0.84 harness v4 **不替代** coding-agent 的 `~/.pi/agent/sessions/**.jsonl` 树格式
- 修复向：JSONL fork/torn-tail **原子 publish**、symlink 会话发现、worktree 嵌套 context 重复加载——**对 Pidance 利好**

风险：若 entry 类型/字段有细微新增（usage 元数据、retry 事件持久化等），只读扫描与 metadata cache 应容忍未知字段（当前设计已偏宽松）。

### 3.4 ModelRuntime / Auth / Models

Pidance 用法：

- `ModelRuntime.create` + `login` / `logout` / 模型列表
- `setRuntimeApiKey` 可能经 api-key 路由
- `getSupportedThinkingLevels`（pi-ai）
- `completeSimple` 仍从 **`pi-ai/compat`** 导入

| 变更 | 动作 |
|------|------|
| `setRuntimeApiKey` 第二参语义变 | 检查调用点，勿再把 refresh options 当 catalog 刷新 |
| `refresh()` 返回 `ModelsRefreshResult` | 错误展示可更细；忽略也可 |
| headers 含 `null` | 若有自建转发 header 逻辑必须透传 |
| OAuth 提前刷新 / headless | 回归 login SSE；OpenRouter 粘贴 URL 路径 |
| `pi-ai/compat` | 0.84 仍有 `./compat` export，但属过渡；中期应迁到 `Models`/`ModelRuntime` |
| 新 provider（Baseten、Qwen Individual、Opus 5…） | 列表自动变多；UI 无需改，需测 auth 状态展示 |

### 3.5 事件面（SSE / 客户端）

| 事件 | 0.81→0.84 | Pidance |
|------|-----------|---------|
| `message_*` | 见 §3.2 | 必回归 |
| `tool_execution_*` | 稳定 | 已透传 update |
| `bash_execution_update` | 0.82+ 新增 | 可透传；UI 可选 |
| `summarization_retry_*` | 0.81.1+ 已有，0.84 仍强化 | 可选展示重试中 |
| `compaction_*` / 双名 auto_ | 既有兼容 | 保持双名 |
| `agent_end` + `willRetry` | 既有 | 保持 |
| `Agent.reset` 运行中拒绝 | 0.84.1 | 确认无热路径调用 |

### 3.6 其它模块

| 模块 | 影响 |
|------|------|
| 插件 / `SettingsManager` / `DefaultPackageManager` | 表面仍在 index export；package 损坏资源数组修复有利 |
| Skills / `DefaultResourceLoader` | 稳定；资源 reload 元数据修复有利 |
| Subagent 桥（`PI_SUBAGENT_PI_BINARY`） | 仍指向本包 `pi-coding-agent/dist/cli.js`；升级后路径需确认仍存在 |
| `session-title` 的 `Agent` | harness 大改但 `Agent` 类仍在；`streamFunction` 等 0.81 已改过的约束保持；跑 auto-name 集成测 |
| TUI 渲染桥 | 0.84 全屏/Mermaid 主要是 interactive TUI；Web 桥依赖 Container/Text/Theme，需 typecheck |
| 新 `pi-client` 远程会话 | **可选产品方向**，与当前同进程模型正交，不阻塞升级 |

---

## 4. 风险矩阵

| 等级 | 项 | 失败表现 | 缓解 |
|------|----|----------|------|
| **P0** | 流式 `message_update` 契约漂移 | 聊天无增量、只在 end 才出字或完全空白 | 安装后抓包；双轨组装；测试覆盖 |
| **P0** | `createAgentSessionFromServices` / subscribe 行为回归 | 会话起不来、事件断流 | 启动 + 发消息 + SSE 冒烟 |
| **P1** | Auth login/logout/api-key | 无法登录、卡在 OAuth、key 写不进 | 覆盖 OpenRouter headless、device code、api_key |
| **P1** | 模型列表 / thinking levels | 空列表、thinking 选项错 | `GET /api/models` + 切换模型 |
| **P1** | Compaction / branch / fork | 树损坏、卡 compact | 既有会话树用例 + 长会话 compact |
| **P2** | TypeBox / 扩展工具 schema | 某扩展装了就挂 | 用常用扩展 smoke |
| **P2** | `pi-ai/compat` 未来删除 | 模型测试路由编译失败 | 中期迁出 compat |
| **P3** | TUI-only 特性 | 无 | 忽略 |
| **机会** | symlink 会话发现、credential 锁、compaction 竞态修复 | 稳定性提升 | 随升级白嫖 |
| **机会** | RemoteSession 客户端 | 多进程/远程 agent | 单独立项，不塞进本次升级 |

---

## 5. 建议升级路径

### 5.1 不建议

- 直接把四包跳到 0.84.1 且只跑 typecheck 就上 31416
- 把 harness v4 / RemoteSession 与依赖升级绑在同一变更里

### 5.2 建议步骤

1. **基线**：当前 0.81.1 录一组黄金路径（发消息流式、tool、compact、fork、login、模型列表）
2. **依赖**：四包同升同一版本（禁止混版本）；0.84 起可顺带装上 `pi-client`/`pi-protocol` 仅作传递依赖，**不强制业务引用**
3. **类型与编译**：`tsc --noEmit` + 相关 `node --test`
4. **契约探针**（最小代码）：
   - 临时日志：首条 `message_update` 是否含 `message` / `assistantMessageEvent` / `partial`
   - 无 `message` 则阻塞发布，先做组装器
5. **功能回归**（31416 local-deploy）：
   - 流式文本 + thinking + tool_execution_update
   - 中途刷新 SSE 重连
   - retract/restore、branch navigate
   - plugins/skills 列表
   - subagent 一次（桥 + 发现）
6. **提交策略**：单独 C2 Issue「升级 pi 0.84.1」；流式适配与依赖升级可同 MR，但 RemoteSession 产品化另开

### 5.3 升级时必改/必查清单

- [ ] `package.json` 四包 → `0.84.1`（或先 `0.83.0` 再 `0.84.1`）
- [ ] 锁文件重生；确认无残留 0.81 嵌套
- [ ] `lib/agent-event-stream.ts` + `useAgentSession` 流式路径适配（见 §3.2）
- [ ] `app/api/auth/*`、`models*`、`models-config/test`（compat）
- [ ] `lib/session-title.ts` auto-name
- [ ] `lib/pi-subagent-bridge.ts` CLI 路径
- [ ] `AGENTS.md` / skill 中「0.81.1」版本钉死说明同步
- [ ] local-deploy 31416 健康 + HTTP 冒烟

---

## 6. 与 OpenChamber / 上游 pi-web

- 本调研只覆盖 **earendil-works Pi SDK**，不涉及上游 `agegr/pi-web` 版本对齐。
- Pidance 产品边界不变：CLI 仅 `pidance`，端口 31415/31416，禁止操作 30141。
- 若未来 pi-web 也跟 0.84，可再做一次「Web 客户端事件契约」对照；当前以本仓进程内 SDK 为准。

---

## 7. 一句话结论

**从 0.81.1 升到 0.84.1 值得做**（模型/鉴权/compaction/会话发现有大量修复与新 provider），**但必须把流式 `message_update` 和 Auth/ModelRuntime 当硬门禁**；SessionManager 主 API 与进程内累计 `message` 目前仍在，给了缓冲，**不能假设缓冲会长期存在**。RemoteSession（pi-client）是可选增量，不要绑进依赖升级。

---

## 8. 参考链接

- Changelog coding-agent：https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md
- Changelog agent-core：https://github.com/earendil-works/pi/blob/main/packages/agent/CHANGELOG.md
- Changelog ai：https://github.com/earendil-works/pi/blob/main/packages/ai/CHANGELOG.md
- Release notes 索引：https://pi.dev/news/releases
- 0.84.0 tag：https://github.com/earendil-works/pi/releases/tag/v0.84.0
- RPC message_update 说明（0.84 包内 `docs/rpc.md`）
