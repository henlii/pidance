# 产物管理

[文档导航](README.md) · [开发验证](development.md) · [发布指南](release.md)

只保留当前使用的编译输出与需要交付/回滚的制品。清理前确认目录、进程和文件属于本次任务；不为清盘停止 31415，不操作上游服务。

## 输出隔离

| 产物 | 目录 | 保留原则 |
|---|---|---|
| 31416 工作区测试 | `.next-public` | 保留当前一份与温构建缓存，不在服务运行时删除 |
| 独立源码 dev | 默认 `.next`，可由 `PIDANCE_DIST_DIR` 指定 | 先确认没有对应 dev 进程，再清理废弃输出；没有 `BUILD_ID` 不代表正在使用的 dev 输出可删除 |
| 正式/候选构建 | 隔离根的 webpack `.next` → `henlii-pidance-<ver>.tgz` | 审计完成后保留 tgz + sha256，构建输出打包后清理 |
| Windows 桌面制品 | `desktop/dist/`、workflow Artifacts | 与主包 tgz 分开，保留本次需要交付的 zip/installer 及哈希 |

禁止工作区正式 `next build`，禁止 31415/31416 或 `.next`/`.next-public` 产物混用。

## 本地候选包

```bash
npm run package:candidate
```

默认构建根 `/tmp/pidance-release-build`。完成后：

- 必须留：当前候选 tgz 与 `.sha256`；只有确认被替代后才删除旧候选。
- 可留：`node_modules`，用于后续增量构建。
- 应清理：本次隔离根中不再使用的 `.next`、镜像源码和旧候选制品。
- 候选版本号可与源码相同，但不代表字节与 npm 正式包一致；不要覆盖正式发布证据。

## 正式安装

自检升级的 releases 目录保留 current 与上一版。Linux 正式安装通常位于 `~/.local/share/pidance/releases/`；其他平台按实际安装位置确认，不套用 Linux 路径。

不要直接删除正在运行的 release，或为了清盘停止稳定服务。桌面壳内置服务随桌面包发布，不与工作区构建输出互换。

## 临时数据

测试目录、探测脚本、截图、日志等用完清理；需要保留的验收证据先放入本次获准的记录位置。不要批量删除 `/tmp/pidance-*` 等其他任务可能正在使用的目录，也不要清理用户真实 `~/.pi/agent/sessions`。

本页只说明清理规则；文档整理没有执行任何产物或会话删除。
