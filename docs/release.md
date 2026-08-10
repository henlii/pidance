# 发布清单（v0.1.0 首发）

本文描述 **@henlii/pidance** 的正式发版流程。**不表示任何版本已发布**；任一步失败都不得宣称成功。

发布目标：

- npm 包：`@henlii/pidance@0.1.0`（及后续版本）
- GitHub Release：`henlii/pidance` 的 `v0.1.0`（及后续 tag）

Pidance 源自 [agegr/pi-web](https://github.com/agegr/pi-web)，底层仍兼容 [badlogic/pi-mono](https://github.com/badlogic/pi-mono) 的会话语义。发版前核对上游变更，保持会话文件与运行时兼容。

## 原则

1. **先版本提交并合并**，再基于干净 tag 在中性临时 worktree/checkout 构建与审计。
2. **任何脚本不得自动** `version` / `tag` / `push` / `publish` / 创建 GitHub Release。
3. 正式 `next build` **只允许**在隔离发布 checkout 中作为 `release:check` 的一部分执行；日常开发禁止 `next build`（会污染 `.next/`，干扰 `npm run dev`）。
4. **生成前后均须审计**：`release:audit`（pack dry-run + 完整文本扫描）→ 显式 `npm pack` → `release:audit:tgz`（解析真实 tgz）→ 再 sha256 / 安装冒烟 / publish。不得用工作区文件冒充制品内容。
5. `npm login` **仅在**实际 `npm publish` 前需要；预检与审计不需要登录。本机默认 registry 可为镜像（如 npmmirror），但**正式登录、身份检查、publish 与查询必须指向官方源** `https://registry.npmjs.org/`。`package.json` 的 `publishConfig.registry` / `access` 是防误发护栏，命令行仍应显式传 `--registry`。
6. 公开安装入口 CLI **仅** `pidance`；**不得**注册 `pi-web`（该命令归上游）。产品默认端口 **31415**；**30141** 留给上游 pi-web，禁止操作。
7. npm 与 GitHub Release **必须使用同一个已验收 tgz**（及对应 SHA-256）。

## 0. 版本提交（在开发分支 / PR）

1. 将 `package.json` 的 `version` 设为目标版本（首发 `0.1.0` 已就位则跳过改号）。
2. 完成功能与文档，PR 合并到默认分支。
3. 在默认分支创建并推送 **annotated tag**（示例）：

```bash
git checkout main
git pull --ff-only
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

确认远端尚无同名 tag：

```bash
git ls-remote --tags origin v0.1.0
```

## 1. 隔离发布 checkout

在**中性临时目录**（不要用日常开发工作区，避免本机路径/缓存渗入）检出干净 tag：

```bash
git worktree add /tmp/pidance-release-v0.1.0 v0.1.0
cd /tmp/pidance-release-v0.1.0
npm ci
```

可选：设置中性 `HOME` 或构建目录，降低绝对路径泄漏风险（Next 仍可能内嵌中性构建路径；审计会扫描开发机 `HOME`/仓库绝对路径与内网 IP）。

## 2. 质量门禁 + 正式构建 + 生成前审计

```bash
npm run release:check
```

等价于：

```bash
npm run check && npm run build && npm run release:audit
```

说明：

- `check`：`typecheck` + `lint` + 单元测试。
- `build`：生产 `next build`（**仅此发布例外**）。
- `release:audit`（pre-pack）：`npm pack --dry-run --json --ignore-scripts`（**不生成 tgz**），并校验：
  - 必要 `.next` 产物与 `server`/`static` 非空；
  - 仅 `bin.pidance`，无 `pi-web`；
  - 无源码/测试/本地治理/密钥/dev cache 等禁入路径；
  - 对清单中每个可扫描文本文件做**完整**有界扫描（单文件与总预算超限、读取失败均 fail closed，禁止截断后通过）；
  - 拒绝私钥标记、明显 credential 赋值、仓库/HOME 绝对路径、硬编码内网主机与 `192.168.*.*` 地址。

审计失败会列出具体路径与原因并以非零退出。**此时不要**继续 pack/publish。

## 3. 生成 tgz + 生成后审计 + 哈希

pre-pack 通过后**显式**打包，再对**真实 tgz** 审计（直接读包内字节，不回读工作区冒充）：

```bash
npm pack --ignore-scripts
# 得到例如：henlii-pidance-0.1.0.tgz

npm run release:audit:tgz -- henlii-pidance-0.1.0.tgz
# 或：node scripts/audit-release-package.mjs --tgz henlii-pidance-0.1.0.tgz
```

post-pack 规则与 pre 相同（allowlist / 必要产物 / bin / 敏感内容），且 **bin 只信 tgz 内 `package/package.json`**。CLI 会用当前干净 tag 的 `package.json` 的 `name`/`version` **仅比对包身份**（与 tgz 内声明不一致则失败）；内容与 bin 仍不读工作区冒充。解析有界：压缩体、解压总量、条目数、单条目大小均设上限；header checksum 与数值字段 fail closed；拒绝路径穿越/控制字符、符号链接/硬链接与非预期 tar 类型；双零结束后非零 trailing data 拒绝。

仅当 `release:audit:tgz` 通过后：

```bash
sha256sum henlii-pidance-0.1.0.tgz | tee henlii-pidance-0.1.0.tgz.sha256
```

## 4. 安装冒烟（同一 tgz）

在另一干净目录用 **production 依赖** 安装**已审计**的同一 tgz：

```bash
mkdir -p /tmp/pidance-smoke && cd /tmp/pidance-smoke
npm init -y
npm install /tmp/pidance-release-v0.1.0/henlii-pidance-0.1.0.tgz --omit=dev
npx pidance --help || true
# 或短时启动：npx pidance --no-open -p 31415
# 确认监听 31415，且命令名为 pidance（无 pi-web）
```

冒烟失败则停止，**不要** publish。

## 4.5 可信发布（GitHub Actions + OIDC，推荐）

本仓已配置 `.github/workflows/release.yml`（**可信发布**）：`push v* tag` 触发 CI，
在 GitHub runner 上完成隔离构建 → `release:audit` 前后审计 → `npm pack` →
`release:audit:tgz` → `sha256sum` → `npm publish --provenance --access public
--registry https://registry.npmjs.org/`（**OIDC 临时身份，无长期 token，账号 2FA 下
无需 OTP**）→ `gh release create`（同一 tgz + sha256）。

- **不使用 automation token**（完整发布权限、泄露风险高；npm 官方也建议自动化场景
  改用可信发布）。
- CI 发布流程与下方本地手动 publish 等效；本地步骤（构建/审计/冒烟）仍可用于
  发布前的预检，但发布动作交给 CI。
- npmjs.com 侧可在包发布后于包设置 → Access → **Trusted Publishing** 配置
  GitHub repo 锁定（可选，进一步收紧为只允许该 repo 的 OIDC 发布）。
- 重新触发：若 tag 已存在但 workflow 后才推送，删除远端 tag 重推即可
  （`git push origin :refs/tags/v0.1.0` → 重建 annotated tag → `git push origin v0.1.0`）。

## 5. 正式发布到 npm（显式）

仅在 tgz 已通过 post-pack 审计与安装冒烟后。**务必使用官方 registry**（勿依赖本机镜像默认值）：

```bash
# 仅在本步前登录官方源（本机默认可能是 npmmirror 等镜像）
npm login --registry https://registry.npmjs.org/
npm whoami --registry https://registry.npmjs.org/   # 确认有权发布 @henlii/pidance

npm publish /path/to/henlii-pidance-0.1.0.tgz \
  --access public \
  --registry https://registry.npmjs.org/
```

`package.json` 中 `publishConfig`（`access: public`、`registry: https://registry.npmjs.org/`）作为第二道护栏；仍建议在命令中显式写明 `--registry` 与 `--access`。

验证：

```bash
npm view @henlii/pidance@0.1.0 version --registry https://registry.npmjs.org/
```

若官方源短暂滞后，用精确版本查询，勿仅看 latest。

## 6. GitHub Release（同一 tgz + sha256）

上传**同一个**已验收 tgz 与 sha256 文件（不得一边换包一边沿用旧哈希）：

```bash
gh release create v0.1.0 \
  --repo henlii/pidance \
  --verify-tag \
  --title "v0.1.0" \
  --notes-file release-notes.md \
  henlii-pidance-0.1.0.tgz \
  henlii-pidance-0.1.0.tgz.sha256
```

发布说明建议中英双语，基于 `git log` 整理，并写明 npm 包名与版本；**不要**在未 publish 时写「已发布到 npm」。

## 7. 最终核对

```bash
gh release view v0.1.0 --repo henlii/pidance
npm view @henlii/pidance@0.1.0 version --registry https://registry.npmjs.org/
```

期望：

- GitHub Release 含与 npm 相同的 tgz + sha256；
- npm 精确版本可解析；
- 全程无自动 version/tag/push/publish 脚本副作用。

## 本地脚本对照

| 脚本 | 作用 | 是否允许自动 publish |
| ------ | ------ | ---------------------- |
| `release:audit` | **生成前** dry-run 清单 + 完整文本扫描 | 否 |
| `release:audit:tgz -- <tgz>` | **生成后** 解析真实 tgz 审计 | 否 |
| `release:check` | check + build + pre-pack 审计（隔离 checkout） | 否 |
| （无） | 已删除旧的自动 `version`+`publish` 的 `release` 脚本 | — |

顺序硬门禁：`release:audit` → `npm pack` → `release:audit:tgz` → `sha256` → 安装冒烟 → `npm publish <同一 tgz> --registry https://registry.npmjs.org/` → GitHub Release 上传同一 tgz。

## 不在本清单范围

- 对象存储 / R2 分发（后续议题）。
- 开发机日常工作区直接 `npm run build` / `npm publish`。
- 各环境自己的 systemd / 反代 / 安装目录布局（由运维方自管，不在本仓固化）。

## 安装与运行（发布后）

用户侧安装见仓库 README（`npx` / `npm i -g`）。非回环监听必须设置 `PIDANCE_PASSWORD`（兼容 `PI_WEB_PASSWORD`）。产品默认端口 **31415**；勿与上游 pi-web 默认端口混淆。
