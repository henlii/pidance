# Pidance 文档导航 / Documentation

[中文首页](../README.md) · [English overview](../README.en.md)

## 按任务阅读

| 任务 | 入口 | 内容 |
|---|---|---|
| 安装与快速使用 | [中文](../README.md) / [English](../README.en.md) | Node 要求、CLI、模型代理、远程访问 |
| 会话与系统架构 | [架构说明](architecture.md) | 状态 owner、提交/SSE/停止链路、持久化、源码地图 |
| 安全与数据边界 | [安全说明](security.md) | 认证、文件访问、远程部署、共享会话与单写者限制 |
| 开发与验证 | [开发指南](development.md) | 31416、构建隔离、测试、多端验证 |
| Windows 桌面壳 | [Desktop](../desktop/README.md) | 安装制品、服务复用、托盘、IPC、独立构建 |
| 正式发布 / 候选包 | [发布指南](release.md) | 版本准备、tag、CI OIDC、审计、失败处理 |
| 产物保留与清理 | [产物管理](artifacts.md) | 测试输出、tgz、正式安装、临时数据 |
| 已知架构风险 | [2026-09-15 静态审查](architecture-review-2026-09-15.md) | 审查基线、未解决问题、建议回归矩阵 |
| 版本变更 | [发布记录索引](release-notes/README.md) | 各版本当时的变更与验收记录 |
| 界面分区对照 | [Web 与 TUI 对照](ui-vs-tui.md) | 分区/部件映射、扩展 UI 槽位、刻意分叉、改界面时的维护清单 |
| 设计研究 | [UI 设计稿](ui-redesign/README.md) | 历史 HTML 原型、主题和图标研究，不代替当前实现 |

## 文档职责与事实来源

- `README.md` 是中文产品入口；`README.en.md` 是英文入口；`README.zh-CN.md` 仅保留旧链接兼容，不再维护第三份产品说明。
- 当前实现以源码为准：版本/命令看 `package.json`，发布行为看 `.github/workflows/release.yml`，桌面壳看独立 `desktop/package.json` 与 workflow。
- 架构说明区分“当前实现”和“必须维持的约束”；已知缺口在静态审查中登记，不通过改文档假装问题已解决。
- 发布记录保留当时状态，不回写成新版行为；UI 原型保留设计背景，不作为当前功能清单或强制组件 API。
- 本地 `AGENTS.md` 与 `.agents/skills/` 在当前仓库被 Git 忽略，属于维护环境的操作规则。公共文档不依赖读者拥有这些文件；维护者仍须遵守当前环境适用规则。

## 历史资料

下列 Issue 是既有阶段规划入口，其完成状态应以 Issue 本身为准，不由本页推断：

- [第一阶段：架构 seam 与产品改造 #1](https://github.com/henlii/pidance/issues/1)
- [第二阶段：Pi 生态盲区 #2](https://github.com/henlii/pidance/issues/2)
- [第三阶段：扩展可观测性与默认值 #3](https://github.com/henlii/pidance/issues/3)
- [第四阶段：辅助信息与低频能力 #4](https://github.com/henlii/pidance/issues/4)
- [同进程 Pi SDK 迁移规格 #20](https://github.com/henlii/pidance/issues/20)
- [Pi TUI 与 Pidance 渲染对照稿](assets/pi-tui-vs-pidance-rendering.html)

本轮文档整理未修改业务代码，也未重新执行历史发布记录中的验收。
