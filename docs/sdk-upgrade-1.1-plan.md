# 内核升级评估：Pi SDK 0.87.0 → 1.1.0

评估方式：4 个只读 scout 并行盘点（上游能力 / 本仓库重叠 / 破坏性差异 / 新文档职责切分）→ 父 agent 合成 → 3 个独立复核（对抗性计划审查、15 条断言事实核查、不变量一致性判定）。
原始报告：`/tmp/pi-upgrade/`（`upstream.md`、`repo.md`、`risks.md`、`docs.md`、`review-plan.md`、`factcheck.md`、`oracle-consistency.md`）。本文只保留复核后仍成立的结论。

## 结论

**能升，值得升，但这一轮只做「版本对齐 + 补漏」，不做功能替换。** 内核公开面是超集：`exports`（`.`/`./rpc-entry`/`./client`/`./experimental/plugin`）、`engines.node >=22.19.0`、`CURRENT_SESSION_VERSION = 3`、会话 JSONL 格式、`~/.pi/agent` 全部路径、`ExtensionUIContext` 接口（逐行相同）都没变，**会话零迁移**。

自研代码里内核明确不做的部分（扩展 UI 投影 + TUI 渲染桥 ≈4,900 行、跨进程租约与单写者、队列状态机、浏览器端状态、HTTP 安全边界）必须保留；「换成内核」的候选经复核后**大部分不成立**（见第 3 节）。

## 1. 必须先修的阻塞项（同一提交）

| # | 问题 | 证据 | 修法 |
|---|---|---|---|
| B1 | `ToolRenderContext.outputPad` 在 1.1.0 变必填 `number`，内置 `edit` 渲染器 3 处消费它 | `types.d.ts:376-378`；`dist/core/tools/renderers/edit.js:89,135,154,164` | `buildToolRenderContext` 补 `outputPad: settingsManager.getOutputPad()`（缺省 1）。**后果没有第一轮说的那么满**：`renderResult` 的 `Text` 在 `undefined` 时有默认 padding 1，call 路径的 `Box` 宽度才变 NaN |
| B2 | 主题 JSON 新增 `okhsl()/oklch()` 语法，我们的 `resolveVarRefs` 是旧版镜像 → 抛 `Variable reference not found` → 主题为 null → `withRenderedToolLines` 直接返回原事件，**插件工具卡整体熄火** | 新 `theme.js:23-26` vs 旧 `theme.js:135-138`；`lib/tui-render-bridge.ts:254-267`、`lib/sdk-session-host.ts:2554` | 同一提交里：① 扩解析器认 `ok(lch\|hsl)(...)`（`#rgb` 不是缺口：`:258` 已把 `#` 开头原样返回）；② 更新 `lib/pi-themes/*.json` 与 `lib/pi-themes.test.mjs:36-60` 的字面量正则——该测试与安装包逐值对比，**不更新副本 `npm test` 必红**；③ 断言 `createPiThemeFromJson(SDK 的 dark.json) !== null` |
| B3 | SDK 与 `@earendil-works/pi-tui` 必须**同版本**升：1.1.0 移除 `npm-shrinkwrap.json`，pi-tui 会被去重到顶层；`Box.setPaddingX` 是新增，双副本会让 `instanceof Box` 跨副本失效 | 1.1.0 `files` 无 shrinkwrap；pi-tui `box.d.ts` 新增 `setPaddingX`；`lib/sdk-session-host.ts:222-237` | 顶层与 SDK 同时升 1.1.0；断言 `find node_modules -path '*@earendil-works/pi-tui/package.json'` 只有一份，且 `new Box(1,1).setPaddingX` 存在 |
| B4 | `quietStartup` 变 `boolean \| "header"`，我们的表单只认布尔，**保存时会把 `"header"` 删掉**（改用户文件） | `settings-manager.d.ts:78`；`components/AgentDefaultsConfig.tsx:232,385` | 最小修法：非布尔值不进表单、不做写回 |
| B5 | Azure provider 改名（1.0.3 唯一标注的 breaking）：`azure-openai-responses` → `azure` | `/tmp/pi-changelog.md`（1.0.3 Breaking Changes）；`lib/builtin-api-key-providers.ts:40`、`components/ModelsConfig.tsx:72` | 两个 id 都认（旧配置不至于丢图标/名字），优先显示 `azure` |

## 2. 同一提交里要一起做的（否则会静默失真）

- `ToolRenderContext.durationMs`：`tool_execution_end.durationMs` 透传，partial 时为 `undefined`（否则 bash 卡片 `Took` 走旧时钟、重载后可能不显示）。
- 嵌套工具调用：`parentToolCallId` 的 `tool_execution_start/update/end` 要**对齐 TUI**——TUI 只在 `start` 显式 `break`（`interactive-mode.js:2917`），`update/end` 因为组件没建而空操作；我们三个分支都渲染，会多出幽灵卡片。做法：在 `withRenderedToolLines` 入口对 `parentToolCallId` 直接返回原事件。
- `LoadExtensionsResult.warnings`（1.1.0 新增）：投影到插件页/日志，别在 `lib/loaded-extensions.ts:93-96` 静默丢（产品原则「不静默丢弃」）。
- AGENTS.md / docs/development.md 的 SDK 版本针、about 页版本来源、`globalThis` 键登记表（无新键就写「无」）——与 `package.json` 同一提交。
- `desktop/package-lock.json`：现在解析到的 SDK 是 **0.85.1**（`desktop/package-lock.json:21-23`），比工作区还旧；本次要一起对齐。
- pi-tui 键位默认值变了（`cursorLineStart` 去掉 `ctrl+home`，`altScreen.top` 变 `ctrl+home`），我们直接用 `TUI_KEYBINDINGS` 渲染提示，补一条源码契约测试。

## 3. 复核后**不成立**的替换（第一轮的乐观估计）

| 候选 | 结论 | 理由（复核证据） |
|---|---|---|
| 技能发现换 `loadSkills` | 不做 | 它只扫 `agentDir/skills`、`cwd/.pi/skills` 与显式路径（`skills.js:316-377`），走 `ignore`（gitignore）；我们明确不读 gitignore、`~/.agents/skills` 与祖先目录另在 `package-manager.js:2023-2066`，且技能开关要靠发现列表做可写白名单（`skills-write.ts:47,197`） |
| 会话导出换 `AgentSession.exportToJsonl` | 不做 | 公开方法要活的 `AgentSession`、写盘、无 `leafId`；我们要的是只读、带 leaf 的字符串（`session-export.ts:48-90`） |
| 模型目录换 `ModelRegistry` / `ModelRuntime` | 不做 | 我们的目录刻意不建 runtime：`models.json` 全留、内置渠道仅凭据已配置才进（`models-catalog.ts:120-128`，避免 40+ 供应商）、`enabledModels` 空=全开且全不中退回不过滤（`models-available.ts:148-176`）；`getAvailable()` 全量刷新且曾偶发失败 |
| settings 换 `SettingsManager` | 不做 | `GET/PUT /api/settings/raw` 读写整文件（`app/api/settings/raw/route.ts:19-67`）；SDK 的 `persistScopedSettings` 会 `migrateSettings` 后整文件重写（`settings-manager.js:281-320,452-471`），会删掉 `queueMode`/`websockets`/旧 skills 对象；`enabledModels` 是原文手术，禁止整文件重排 |
| `plugin-packages` 换 `DefaultPackageManager` | 不做（最多只读 `listConfiguredPackages`） | `resolve()` 未传 `onMissing` 时**直接安装**（`package-manager.js:1017-1021`），不是只读面；页面还要资源计数/disabled/diagnostics，且构造函数需要 `SettingsManager` |

## 4. 新能力：内核有、我们没落点（本轮都不接，但要登记）

- **MCP**：内核 1.1.0 内置 `createMcpExtension`。但**我们不是没有 MCP** —— `pi-mcp-adapter@2.34.0` 已作为扩展在跑（自带 `mcp`/`mcp-auth` 命令、mcp.json、keyring、MCP Apps 的 UI 资源服务器）。内核**明确不渲染 MCP Apps**（`docs/mcp.md:246`，`resources.js:8-18` 丢弃 `ui://`）。→ **保留扩展，不注册内置 MCP**；两者会双开，且 `docs/mcp.md:266` 说注册了适配器会替换内置实现。
- **codemode / tool_search**：与 MCP 强绑定（内置 MCP 默认 `exposure: codemode`）。只接 MCP 不接这两样 = 模型看不见工具。
- **虚拟模型**（显示实际派发的模型）、**`isError`**、**工具 `annotations`**（只读/破坏性提示）、**`mcp_servers_change`**：加载对应扩展后必须有可见落点。
- **`structuredContent`** 可显式降级（用户看到的仍是渲染行）；**`provider_stream_event`** 是调试事件，可以不投影（TUI 默认也不显示）。
- 新增的 `registerToolRenderer()` 解析链我们没走（仍直接读 definition），接了才不丢扩展指定的画法。

## 4.5 PR-A 执行记录（已完成，2026-10-09）

- SDK 与 pi-tui 同步升到 `1.1.0`（`package.json` 两处 + lockfile）；装完只有**一份** pi-tui，
  `Box.setPaddingX` 存在，`import("@earendil-works/pi-coding-agent")` 正常（156 个导出）。
- 主题：`resolveVarRefs` 补 `ok(lch|hsl)(...)` 字面量规则（与 SDK `theme.js:23` 同规则）；`lib/pi-themes/dark.json`
  与 `light.json` 按 SDK 值重抄（`lib/pi-themes.test.mjs` 会逐值比对，不抄必红）；新增「用 SDK 自己的主题 JSON
  建实例必须非 null」的回归测试（这条正是「插件工具卡整条熄火」的守门人）。
- 宿主接线：`buildToolRenderContext` 补 `outputPad`（缺省 1，取不到 SettingsManager 也不抛）与 `durationMs`
  （来自 `tool_execution_end.durationMs`，partial 时 undefined）；`withRenderedToolLines` 对 `parentToolCallId`
  的事件整条放过（与 TUI 一致，不产生幽灵卡片）。
- `LoadExtensionsResult.warnings` 不再静默丢：进结果、缓存时打日志，并加契约测试。
- `quietStartup` 三态：`"header"` 原样保留、表单里给出可见说明，不再被保存时抹掉。
- Azure provider 新旧 id 都认（SDK 1.0.3 改名为 `azure`）。
- AGENTS.md / docs/development.md 的版本针改为 1.1.0。
- 门禁：`npm run check` = 2820 项测试通过、eslint 0 error；31416 已重部署并用真会话验证：
  块头 8 个（思考/Bash/Write/Edit）、耗时读数正常、无渲染告警。

## 4.6 MCP 差集结论（子 agent 盘查，2026-10-09）

注册了 `pi-mcp-adapter` 的 `/mcp` 命令就等于**按名字顶掉内核内置 MCP**（`resource-loader` 的 `omitReplacedExtensions`），
所以不存在「双开」风险，这个选择事实上已经做了。差集上适配器是明显超集：**失去 12 项**（MCP Apps `ui://` 完全不渲染、
懒加载/空闲回收/keep-alive 全没了、OAuth 凭据从系统钥匙串退回明文 `mcp-auth.json`、无头/远程 OAuth 入口、MCP prompts 斜杠命令、
配置来源从 6 层掉到 2 层、工具命名与暴露语义换轨、每请求超时 120s→60s、输出守卫更早截断、运维与排障套件、elicitation/sampling、本地 UI 服务器）
vs **得到 8 项**（`structuredContent`/`isError`/`annotations` 真正进工具管线、依赖面大幅收窄、`registerMcpServer()` 与
`mcp_servers_change` 事件、codemode/tool_search 一等公民、项目信任门、重试语义、跨进程 OAuth 刷新锁、排障体验）。
**结论：保留适配器**；将来若要换，必须先把 MCP Apps 渲染这条产品原则 1 的破口补上再谈。

## 4.7 新事件 / 新字段：已投影 or 显式忽略（不许无行丢弃）

产品原则 1 要求「原生 TUI 有的都要有，暂不具备的按可见方式降级」。下表把 1.1.0 带进来的
每一样东西都点名，写明落点；写「显式忽略」的是有意的，不是漏了。

| 新东西（1.1.0） | 落点 |
|---|---|
| `agent_settled.aborted` | 已投影：优先当「被取消」判据（PR-B） |
| `tool_execution_*.parentToolCallId` | 已投影：整条事件放过，不单独成卡（与 TUI 一致） |
| `tool_execution_end.durationMs` | 已投影：进 `ToolRenderContext.durationMs` |
| 渲染上下文的 `outputPad` | 已投影：取 SettingsManager，缺省 1 |
| `pi.registerToolRenderer()` 解析链 | 已投影：先问 `resolveToolRenderers`，取不到才回落 definition（PR-B） |
| `LoadExtensionsResult.warnings` | 已投影：进结果 + 缓存时打服务端日志；插件页展示留待需要时 |
| `isError` | 已投影：工具卡片的错误态 |
| `structuredContent` | 显式忽略：TUI 也没有单独界面，用户看到的仍是渲染行 |
| 工具 `annotations`（readOnly/destructive 等） | 显式忽略：目前没有「按标记弹确认」的界面；等接了需要确认的工具再投影 |
| `mcp_servers_change` | 显式忽略：MCP 走 `pi-mcp-adapter`，状态由适配器自己的命令与工具呈现 |
| `provider_stream_event` | 显式忽略：官方定位是调试观察事件，TUI 默认也不显示 |
| 虚拟模型（`pi.registerVirtualModel()`） | 显式忽略，且有已知偏差：我们的「当前模型」是最后写者胜（`model_change` 与助手消息共用槽位），虚拟模型场景下会显示**实际派发的物理模型**；本机没有扩展注册虚拟模型，真用到时再补「选中 → 实际」 |
| codemode / `tool_search` | 未接：与内置 MCP 同批，留到需要时（现在 MCP 走适配器） |
| MCP Apps（`ui://`、`profile=mcp-app`） | 未接：内核不渲染；适配器自己渲染，我们按通用扩展 UI 投影 |

## 5. 建议的推进顺序

- **PR-A（本轮，已完成）**：B1–B5 + 第 2 节全部 + 验收：`npm run check` 绿、只有一份 pi-tui、`edit`/`bash` 卡片在 31416 实测正常、主题副本与解析器同批、`desktop` lock 对齐。
- **PR-B（可选）**：`registerToolRenderer` 解析链、`agent_settled.aborted`、`warnings` 面板、新扩展事件登记表（已投影 / 显式忽略）。
- **PR-C（要决策）**：内置 MCP + codemode + tool_search（与 `pi-mcp-adapter` 二选一）+ 虚拟模型/分类器/图片生成模型在 UI 的落点。
- **PR-D（不做）**：第 3 节那五项替换——除非出现新证据（例如内核提供只读导出/只读包管理 API）。
