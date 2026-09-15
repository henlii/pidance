# 安全与数据边界

[文档导航](README.md) · [架构](architecture.md)

## 信任模型

Pidance 是运行在用户机器上的 Agent 工作区，不是多租户隔离平台。获准使用服务的人可以通过 Agent、终端和文件功能操作服务账号有权限访问的资源，应视为可信操作者。

**当前文件访问不是项目目录沙箱。** `lib/file-access.ts` 的 `isFileAccessUnrestricted()` 返回 `true`；历史文档中的“仅允许 selected project/worktree 根目录”不符合当前实现。各端点仍可能有格式、上传或冲突校验，但这些不等于目录隔离。

## 监听与认证

- CLI 默认绑定 `127.0.0.1:31415`，本机无密码模式可用。
- 设置 → 通用 → 服务与远程访问可设置密码并开启远程监听，重启生效。
- CLI 绑定非回环地址时必须配置密码，否则拒绝启动。环境变量优先用 `PIDANCE_PASSWORD`，兼容 `PI_WEB_PASSWORD`。
- 已启用密码时，API 接受 UI 会话 Cookie 或 Basic 认证（用户名 `pi`）。Host 与 Origin / Fetch Metadata 检查用于 DNS rebinding 和 CSRF 防护。
- HTTPS/TLS 终止不由默认 HTTP CLI 自动提供。远程访问应保护传输和网络入口，不把含凭据的 HTTP 暴露到不可信网络。

Linux/macOS 示例：

```bash
PIDANCE_PASSWORD='replace-with-a-strong-password' pidance --hostname 0.0.0.0
```

PowerShell 示例：

```powershell
$env:PIDANCE_PASSWORD = 'replace-with-a-strong-password'
pidance --hostname 0.0.0.0
```

以上值只是占位示例，不要将真实密码写入仓库、截图或提交记录。

### 防护限制

中间件无密码回环兜底的依据是请求 `Host` 头，**不是** TCP 来源地址（Next.js middleware 拿不到对端地址）。`Host` 由请求方提供，因此：

- 它是**纵深防御**，不能替代 `bin/pidance.js` 的启动门禁（非回环监听且未设密码时拒绝启动）；
- 不能依赖它保护「绕过 CLI 直接对外监听且无密码」的服务，或已配置代理但未启用认证的部署；
- Host 白名单（`PI_WEB_HOSTNAME` / `PI_WEB_ALLOWED_HOSTS`）在回环判定之前生效；已启用密码时回环不再免认证。

反代场景：经代理访问的请求 `Host` 通常不是回环名，因此无密码部署本来就会被拦（这一路径已有测试固定）；需要经代理使用时请启用认证并保护传输。

Electron 使用沙箱与隔离 preload，不为网页开放通用 Node API；但网页仍通过本机 Agent 服务具有上述操作能力，沙箱不等于 Agent 文件权限隔离。

## 会话与凭据

- 默认数据根为 `~/.pi/agent`，可用 `PI_CODING_AGENT_DIR` 指向其他目录。
- `auth.json`、`models.json`、`settings.json` 属于 Pi 原生配置；JSONL 属于 Pi 会话树。不要向它们添加自定义 schema 字段。
- 模型 API Key、OAuth 凭据和认证诊断只输出必要状态，不回显原值。
- UI 偏好、队列、缓存和归档使用独立 sidecar；它们不能替代 JSONL 事实来源。
- 备份/迁移会话前先停止对应 writer，再复制会话和必要 sidecar；不要边运行边裸改 JSONL。

## 多进程与远程运行

31415 与 31416 可以共享 agentDir，但同一 JSONL 必须保持一个 writer。不要让外部 Pi CLI 与 Pidance 同时写同一个会话。跨进程占用只表示写锁，不等于本进程的运行徽标。

当前租约过期接管、teardown 等仍有条件性风险，见 [静态审查 R1–R4](architecture-review-2026-09-15.md)。看到“已受理”不代表任务已完成；取消浏览器请求也不保证服务端停止。网络不确定时先确认服务端状态，不盲目重发相同操作。

本页说明现有边界，不构成全量安全审计或并发写安全认证。
