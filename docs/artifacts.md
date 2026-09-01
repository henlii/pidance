# 产物管理

只保留**当前在用**的一份编译产物。过期 dist、旧 tgz、探测临时目录一律删。

## 三套产物，互不混用

| 产物 | 目录 | 何时保留 |
|------|------|----------|
| 31416 测试 | 工作区 `.next-public` | 仅这一份；`local-deploy` 温构建靠其中 cache，**不要**每次 `rm -rf` |
| `npm run dev` | 工作区 `.next` | 只有正在跑 `next dev` 时才需要。无 `BUILD_ID` 的残留直接删 |
| 正式包 | 隔离根 webpack `.next` → `henlii-pidance-<ver>.tgz` | 审计通过后 **tgz + sha256** 才是发布物。构建根里的 `.next` 打完包即可删 |

禁止：工作区正式 `next build`；31415/31416/.next/.next-public 混用。

## 候选包 `/tmp/pidance-release-build`

```bash
npm run package:candidate
```

打完后：

- **必须留**：`henlii-pidance-<ver>.tgz` 与 `.sha256`（最新一版即可，旧版 tgz 删掉）
- **可留**：`node_modules`（下次增量 `npm ci`）
- **应删**：该目录下其它 `.next`、镜像源码、旧版本 tgz

## 正式安装 `~/.local/share/pidance/releases/`

自检升级保留 **current + 上一版**（共两版）。不得用手去动正在跑的 31415 进程来「清理」。

## 临时垃圾

任务结束后删除 `/tmp/pidance-*` 测试夹、`/tmp/pi-bash-*.log`、探测脚本。不要删用户 `~/.pi/agent/sessions`。
