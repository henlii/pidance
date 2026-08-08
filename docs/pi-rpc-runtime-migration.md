# Pidance → 外部 Pi RPC 运行时：可行性与直接迁移方案

> **独立评估**：Oracle（`new-api/gpt-5.6-sol` / xhigh），会话 `ses_02102cb2affeERXwfDx0fLF4OT`，2026-08-08  
> 状态：**阶段 0–5 主路径已落地并在 31416 持续运行**（`PIDANCE_AGENT_RUNTIME=rpc`）。  
> 基线 tag：`v0.1.0-pre-rpc`（`dad333f`）。  
>
> **31416 冒烟（2026-08-08）**：ensure_session / get_state / prompt / abort / bash /  
> get_tools(本地合成) / fork / navigate_tree / compact(过短会话正确拒绝) /  
> `/api/runtime` + About / `POST /api/runtime/switch`(无 slot→404) / 外部 `pi` 子进程。  
>
> **仍分期（明确不阻塞主路径）**：  
> 1. TUI 工具渲染桥（外部无 in-process extensionRunner；前端纯文本回退）  
> 2. slot 远程下载/校验安装器（现仅本地 slot 枚举 + 显式切 current）  
> 3. 管理面 npm 0.81→0.84（独立轨，与运行面外置拆开）  
> 相关：`docs/pi-upgrade-evaluation-2026-08-07.md`  
> 说明：本文件为该次独立评估的执行规格落盘，非照抄前一稿。

---

## 1. 可行性结论

### 判定：**GO-WITH-CONDITIONS**

外部 Pi RPC 运行时可行，且能满足：

- 运行中的 agent loop 不再嵌入 Next 进程  
- Pi 引擎可独立于 Pidance 升级  
- 可探测 runtime 版本并提示升级  
- 托管环境可提供**受门禁**的升级流程  

**不是** `createAgentSessionFromServices()` 的 drop-in。

### 硬前提

1. **运行面**全部经外部 `pi --mode rpc`  
2. **管理面**仍由 Pidance 自管（不依赖 RPC auth/plugins/skills 命令）  
3. Pidance **保留** JSONL 会话读写能力（列表、只读上下文、归档、活动、产品级分支）  
4. **外部 Pi 与 Pidance 不得同时对同一 session JSONL 做树结构写**  
5. RPC 事件必须经 Pidance 适配；**不能假设**始终存在累计 `event.message`  
6. 默认 **1 live session = 1 rpc 子进程**；不做 multi-tenant Remote  
7. **31415 默认禁止无确认自动升 Pi**；须白名单、隔离构建、冒烟、回滚  

### 关键证据

RPC（0.81.1 文档）覆盖运行面：`prompt/steer/follow_up/abort/set_model/set_thinking_level/compact/bash/get_state/get_entries/get_tree/fork/clone/switch_session` + 扩展 UI + 完整事件流。

但 **无公开** `navigate_tree`、精确 leaf、分支标签、Pidance activity 等命令（`navigateTree` 仅在 RPC 进程内部 extension context，非客户端协议）。故必须保留 **Pidance 会话树适配层**。

---

## 2. 当前耦合面（摘要）

| 面 | 位置 | 迁移含义 |
|----|------|----------|
| 运行 | `lib/rpc-manager.ts`：`inner.prompt/abort/setModel/compact/executeBash/navigateTree/steer/followUp` | 改为 `PiRpcProcess` / `PiRuntimeSession` |
| 运行 | 同文件：registry、idle、扩展 UI、工具渲染、activity、fork destroy、running 广播 | 迁入 runtime manager |
| 管理 | `session-reader` / auth / models / plugins / skills / settings / `session-title` | **一期仍可用钉版本 pi npm**，不阻塞运行面外置 |
| 前端 | `useAgentSession` 依赖 `event.message`；`agent-event-stream` strip `assistantMessageEvent` | 0.84 RPC delta-only 下会全丢 → 必须服务端组装 |

**一期目标**：agent loop 独立升级 ≠ 立刻卸光全部 pi npm。

---

## 3. 目标架构

### 3.1 拓扑

```text
Browser
  ├─ sessions / context / agent POST / SSE
  ▼
Next.js Pidance
  ├─ SessionService（列表、JSONL 只读、产品 fork/retract、管理面）
  ├─ PiRuntimeManager（registry、命令/响应、事件规范化、重启、running）
  └─ PiRpcProcess × N
         stdin/stdout JSONL
         ▼
    pi --mode rpc
         agent loop / tools / provider / compact / extensions / jsonl append
```

### 3.2 边界

| 运行面（外部 pi） | 管理面（Pidance） |
|------------------|-------------------|
| prompt、流式、tool、compact、bash、abort、model/thinking、retry、extension 执行与 UI 请求 | 列表、JSONL 只读、archive、worktree、models.json、auth、skills、plugins、settings、retract、activity、**产品 fork**、版本检查 |

不要用 RPC `get_commands` 当管理面事实源。

### 3.3 生命周期

```text
ensureLive(sessionId)
  → 健康进程则复用
  → 否则 spawn pi --mode rpc（cwd=会话 cwd，绑定 session 文件）
  → get_state 校验 sessionId/sessionFile
  → 注册并订阅 stdout

idle 10min → abort/确认 idle → SIGTERM → 清 registry
异常退出 → dead + reject pending + runtime_lost → 下次请求再起
```

**二进制解析顺序（与旧「优先 node_modules」不同）**：

1. 管理员配置绝对路径  
2. Pidance runtime 配置中的路径  
3. PATH 中的 `pi`  
4. **不再默认**用 Pidance 自带 `node_modules` CLI 当「外部可升级引擎」  

主 runtime 与 `PI_SUBAGENT_PI_BINARY` **必须同源解析**，禁止主进程 0.84、subagent 仍 0.81。

### 3.4 版本探测（三层）

```json
{
  "pidanceVersion": "0.1.0",
  "managementPiVersion": "0.81.1",
  "runtime": {
    "path": "/usr/local/bin/pi",
    "version": "0.84.1",
    "source": "configured-path",
    "protocol": "rpc",
    "compatible": true
  },
  "runtimeUpdate": { "available": true, "latest": "0.84.1" }
}
```

- `pi --version`：超时、退出码、格式、路径规范化  
- 启动后协议探针：`get_state` / `get_entries`；探测 delta-only、`agent_settled`、`bash_execution_update`、extension UI  
- capability 结构建议：`deltaOnlyMessageUpdate`、`agentSettled`、`bashExecutionUpdate`、`extensionUi`、`getEntries`、`getTree`  
- **0.84**：RPC `message_update` 无累计 `message`、无 `partial`；`message_end.message` 权威  
- **0.84.1 engines**：Node `>=22.19.0`（Pidance 现声明 `>=20.9.0`）→ 托管升级必须查 Node  

---

## 4. 关键决策

### 4.1 流式：服务端组装，保持浏览器契约

新增例如：

```text
lib/pi-runtime/
  rpc-process.ts
  rpc-protocol.ts
  rpc-event-assembler.ts
  rpc-runtime-manager.ts
```

规则：

1. `message_start` → 建 buffer  
2. `message_update`：按 contentIndex 处理 text/thinking/toolcall delta；对外仍发累计 `message` 形  
3. `message_end` → 权威 `message` 覆盖  
4. 缺 start → 最小 buffer，end 修正  
5. 重连 → 不靠内存；JSONL/`get_entries` 重载  

**不要**把 delta 组装放进 React。  
`agent-event-stream` 禁止「只删 assistantMessageEvent 又不组装」。

### 4.2 navigate / retract / 产品 fork

| 能力 | 决策 |
|------|------|
| navigate_tree / select_leaf / branch_from_assistant | **无公开 RPC** → quiesce → 磁盘 SessionManager → **停进程** → 下次再起 |
| retract/restore | 同 navigate（`parentId` / `chainTail`）；撤回栈可保留 |
| **产品 Fork** | **继续** `SessionManager.createBranchedSession`；**不用** RPC `fork`（不回 newSessionId、进程 in-place 换文件） |

统一流程：

```text
quiesce → abort → wait settled → stop RPC
  → 本地树操作 → invalidate cache → clear runtime
  → lazy restart on next send
```

**禁止**：进程仍 live 时 Pidance 改 JSONL 还继续用该进程。

`getReadView()` 迁移后：**不要**优先 live 内存 sessionManager；只读以磁盘为准（运行中先 flush/settled）。

### 4.2.1 leaf 持久化（sidecar）与已知限制（2026-08-08 定稿）

**事实**：Pi 0.83 `SessionManager._buildIndex` 打开文件时 `leafId = 文件最后一条 entry`；
header 无 leaf 字段；CLI 无 leaf 参数；RPC 无 navigate/set_leaf 命令（`navigateTree`
仅在 RPC 进程内部 extension context，非客户端协议）。

**决策**：

- 导航 leaf 属于 Pidance 业务附加元数据 → 写 `<session>.jsonl.leaf.json` sidecar，
  **不再**写 header 扩展 `pidanceLeafId`（Pi 忽略未知键但违反原生 schema guardrail）。
- 历史 `pidanceLeafId` header 一次性迁移到 sidecar 并清理 header（失败保留原状重试）。
- 单写者：Pidance 任何 JSONL 写盘（activity / label / rename / 导航）前必须确认
  外部 pi 进程已 quiesce/destroy；appendActivity 与 PATCH 改名已修复为 live 走
  RPC / 否则停进程再写。
- **已知限制（不伪造恢复）**：导航到非末尾分支后，外部 pi 重启 leaf 回到文件末尾。
  ExternalRpcSession.start() 检测 sidecar leaf ≠ 文件末尾时 emit `leaf_drift`，
  前端明确提示「会话将从文件末尾继续」，不静默挂错分支。

**待平台升级**：Pi 若提供公开 leaf 恢复（CLI 参数或 RPC 命令），改回原生路径并移除提示。

### 4.3 依赖

| 阶段 | 策略 |
|------|------|
| 一期 | 管理面 **保留钉版本 pi-***；运行面 **外部 pi** |
| 二期（独立） | 自有 JSONL/树/models/auth/plugins/skills → 再卸 npm |

### 4.4 与 0.84 捆绑？

**三变量拆开，不捆绑：**

| 变量 | 建议 |
|------|------|
| 运行面 → 外部 RPC | **先做** |
| 外部 runtime 0.81 → 0.84 | 适配层稳后再做 |
| 管理面 npm → 0.84 | **单独**回归 |

阶段 0 即可加 **0.84 RPC fixture**，不必立刻升管理面依赖。

---

## 5. 分阶段迁移（可独立验收）

### 阶段 0 — 协议基线（不切运行路径）

- 新增：`lib/pi-runtime/rpc-protocol|event-assembler|process|types` + 测试  
- 改：`agent-event-stream`、必要时 about  
- 严格 LF JSONL（**禁** Node readline 作 framing）  
- 0.81 累计 + 0.84 delta-only 双轨 fixture  

### 阶段 1 — 外部进程管理器

- `rpc-runtime-manager`、`runtime-path`、`runtime-version`  
- 替换 `AgentSessionWrapper` 运行职责（send/onEvent/destroy/registry/idle/running）  
- SessionService 暴露；**保持** route 不双 import  
- 验证 session 文件恢复：`--session-dir` 或启动后 `switch_session`  

### 阶段 2 — 运行命令切换

| Pidance | RPC |
|---------|-----|
| prompt/steer/follow_up/abort/set_model/thinking/compact/bash | 同名 |
| abort_compaction | **无协议命令** → 能力探测；不可伪造成功 |
| extension_ui_* | 对齐 RPC 子集 |

Feature flag 先挂测试路径。

### 阶段 3 — 扩展 UI / 工具渲染

- 支持 select/confirm/input/editor/notify/setStatus/setWidget…  
- custom/TUI footer 等：一期明确降级或保留 Pidance 自有协议  
- 工具渲染：**不能**从错误版本的 in-process extensionRunner 取 renderer；通用渲染或 RPC 侧 `renderedLines`  

### 阶段 4 — 树操作 + 产品 fork

- `session-quiesce.ts`  
- navigate/retract/fork/label 全走 quiesce 流程  
- 修正 live 读视图优先级  

### 阶段 5 — 版本提示 + 托管升级

- `GET /api/runtime`；About 展示 management vs runtime  
- 区分 `latest / tested / allowed / installed`  
- 升级 slot 见 §6  

---

## 6. 升级门禁与回滚

### 31415：默认禁止自动升级

允许：探测、提示、**管理员显式**升级。  
禁止：后台静默替换、请求触发 `npm -g`、覆盖唯一可回滚版本。

### 推荐 runtime slot

```text
~/.pidance/runtimes/pi/
  0.81.1/
  0.84.1/
  current -> 0.81.1
```

升级：下载临时目录 → SHA256 → 新 slot → `--version` → 临时 RPC 冒烟（prompt/stream/tool/compact/树/extension UI/现有 jsonl 恢复）→ 确认后切 `current` → 旧 live 策略性 quiesce 重启 → 失败回滚 slot。

### 硬门禁（任一失败不切换）

Node engines、SHA256、CLI 解析、RPC 启动、`get_state`、stream/tool/compact fixture、现有会话可读、路径白名单、运行中 session 已 quiesce。

31416 不能替代 31415 正式验收。

### 发布

tgz 仍不含 node_modules / runtime 安装目录 / secrets / 源码治理；**无 bin.pi-web**。  
回滚 = 切 `current` 符号链接，不是重装 npm。

---

## 7. 验收 A（Given / When / Then）

| ID | 要点 |
|----|------|
| A1 | 配置路径 runtime → 状态含 path/version/compatible；不碰 30141 |
| A2 | 新会话 prompt → 外部 `pi --mode rpc`；Next 内无 AgentSession loop |
| A3 | 0.84 delta-only → 前端连续增量；end 权威；重连不重复 |
| A4 | tool + direct bash + abort 状态正确 |
| A5 | compact 可结束、上下文一致 |
| A6 | 切分支/retract：quiesce 后改 leaf，旧进程不续旧 context |
| A7 | 产品 fork：新 jsonl + parentSession + 源 runtime destroy；不依赖 RPC fork 回 id |
| A8 | 进程崩溃：runtime_lost、pending reject、jsonl 不伪造；可再起 |
| A9 | 升级：门禁全过才切 current；失败不切；可回滚 slot |

---

## 8. 推荐实施顺序

1. RPC framing + delta assembler **纯测试**（不切路径）  
2. 外部 **0.81.1** RPC smoke（session/cwd/prompt/tool/compact）  
3. `PiRpcProcess` + `PiRuntimeManager` + feature flag  
4. `/api/agent/*` 运行命令切 RPC；管理 API 不动  
5. **0.84.1** delta-only 兼容  
6. quiesce + navigate/retract/fork  
7. extension UI / 工具渲染可用子集  
8. `/api/runtime` + About  
9. 31416 生产模式全验收  
10. 31415：默认关自动升级；仅探测 + 显式管理员升级  
11. **最后**单独评估管理面 npm 0.81 → 0.84  

---

## 9. 一句话

> **先把 Pi 变成 Pidance 的外部运行时，而不是先清空全部 Pi 管理依赖。**  
> 运行面解耦是目标的最小充分路径；管理面去 Pi 化、升 0.84 npm、外部引擎升 0.84 是三个独立变量。
